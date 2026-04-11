import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CopilotClient,
  CopilotSession,
  approveAll,
  type SessionMetadata,
  type SessionEvent,
  type SessionListFilter,
  type ModelInfo,
  type SessionConfig,
  type ResumeSessionConfig,
  type GetStatusResponse,
  type GetAuthStatusResponse,
} from '@github/copilot-sdk';

const SDK_CLI_PATH = process.env.COPILOT_CLI_PATH || '/opt/node/lib/node_modules/@github/copilot/npm-loader.js';

function copilotSessionStateDir(): string {
  return process.env.COPILOT_SESSION_STATE_DIR || path.join(os.homedir(), ".copilot", "session-state");
}

function parseWorkspaceTitle(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  for (const key of ["name", "summary"]) {
    const prefix = `${key}:`;
    const line = lines.find((item) => item.startsWith(prefix));
    if (!line) continue;
    const value = line.slice(prefix.length).trim();
    if (!value) continue;
    const quoted =
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"));
    return quoted ? value.slice(1, -1) : value;
  }
  return undefined;
}

export interface SessionModelInfo {
  model: string;
  reasoningEffort?: string;
}

type CompactResult = { success: boolean; tokensRemoved: number; messagesRemoved: number };

type SessionCompactRpcCompat = {
  history?: {
    compact?: () => Promise<CompactResult>;
  };
  compaction?: {
    compact?: () => Promise<CompactResult>;
  };
};

type SessionConnectionCompat = {
  sendRequest?: (method: string, params: { sessionId: string }) => Promise<CompactResult>;
};

type SessionHistoryConnection = {
  sessionId: string;
  sendRequest: (method: string, params: { sessionId: string }) => Promise<CompactResult>;
};

function getSessionCompactRpc(session: CopilotSession): SessionCompactRpcCompat {
  return session.rpc as SessionCompactRpcCompat;
}

function getSessionHistoryConnection(session: CopilotSession): SessionHistoryConnection | undefined {
  const maybe = session as unknown as { sessionId?: unknown; connection?: SessionConnectionCompat };
  if (typeof maybe.sessionId !== "string" || typeof maybe.connection?.sendRequest !== "function") {
    return undefined;
  }
  return {
    sessionId: maybe.sessionId,
    sendRequest: maybe.connection.sendRequest.bind(maybe.connection),
  };
}

function isUnsupportedMethodError(error: unknown, method: string): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(`Unhandled method ${method}`)
    || error.message.includes(`Method not found: ${method}`)
    || error.message.includes(`Unknown method ${method}`);
}

export class AcpClient {
  private client: CopilotClient | null = null;
  private sessions = new Map<string, CopilotSession>();
  private sessionWorkingDirectory = new Map<string, string>();
  private sessionModelInfo = new Map<string, SessionModelInfo>();
  private sessionTitles = new Map<string, string>();

  private getOrCreateClient(): CopilotClient {
    if (!this.client || this.client.getState() === 'error') {
      if (this.client && this.client.getState() === 'error') {
        this.sessions.clear();
        this.sessionWorkingDirectory.clear();
        this.client.forceStop().catch(() => {});
      }
      this.client = new CopilotClient({
        cliPath: SDK_CLI_PATH,
        logLevel: 'none',
        useLoggedInUser: true,
      });
    }
    return this.client;
  }

  private attachModelTracking(session: CopilotSession): void {
    session.on('session.model_change', (event) => {
      this.sessionModelInfo.set(session.sessionId, {
        model: event.data.newModel,
        reasoningEffort: event.data.reasoningEffort,
      });
    });
    session.on('session.title_changed', (event) => {
      this.sessionTitles.set(session.sessionId, event.data.title);
    });
    session.on('assistant.usage', (event) => {
      const current = this.sessionModelInfo.get(session.sessionId);
      if (!current || current.model !== event.data.model || current.reasoningEffort !== event.data.reasoningEffort) {
        this.sessionModelInfo.set(session.sessionId, {
          model: event.data.model,
          reasoningEffort: event.data.reasoningEffort,
        });
      }
    });
  }

  private async seedModelInfoFromHistory(session: CopilotSession): Promise<void> {
    if (this.sessionModelInfo.has(session.sessionId)) return;
    try {
      const messages = await session.getMessages();
      for (let i = messages.length - 1; i >= 0; i--) {
        const event = messages[i];
        if (event.type === 'assistant.usage') {
          this.sessionModelInfo.set(session.sessionId, {
            model: event.data.model,
            reasoningEffort: event.data.reasoningEffort,
          });
          break;
        }
      }
    } catch {
      // history unavailable — model info will arrive on next turn
    }
  }

  getSessionModelInfo(sessionId: string): SessionModelInfo | undefined {
    return this.sessionModelInfo.get(sessionId);
  }

  async probeSessionModelInfo(sessionId: string, workingDirectory?: string): Promise<SessionModelInfo | undefined> {
    if (this.sessionModelInfo.has(sessionId)) return this.sessionModelInfo.get(sessionId);
    try {
      const client = this.getOrCreateClient();
      // Resume a temporary session just to read history — don't store in main cache
      // so the next real turn resumes cleanly with its own workingDirectory.
      const session = await client.resumeSession(sessionId, {
        onPermissionRequest: approveAll,
        workingDirectory,
        disableResume: true,
      });
      const messages = await session.getMessages();
      for (let i = messages.length - 1; i >= 0; i--) {
        const event = messages[i];
        if (event.type === 'assistant.usage') {
          this.sessionModelInfo.set(sessionId, { model: event.data.model, reasoningEffort: event.data.reasoningEffort });
          break;
        }
      }
      await session.disconnect().catch(() => {});
    } catch {
      // session may not exist or ACP unavailable
    }
    return this.sessionModelInfo.get(sessionId);
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const client = this.getOrCreateClient();
      const metadata = await client.getSessionMetadata(sessionId);
      return metadata !== undefined;
    } catch {
      return false;
    }
  }

  async getOrResumeSession(
    sessionId: string,
    workingDirectory?: string,
    systemMessage?: string,
    reasoningEffort?: "low" | "medium" | "high" | "xhigh",
  ): Promise<CopilotSession> {
    const existing = this.sessions.get(sessionId);
    // Evict cached session if workingDirectory has changed so the next resume
    // picks up the new project directory as the session cwd.
    if (existing && workingDirectory && this.sessionWorkingDirectory.get(sessionId) !== workingDirectory) {
      this.sessions.delete(sessionId);
      await existing.disconnect().catch(() => {});
    }
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId)!;

    const client = this.getOrCreateClient();
    const config: ResumeSessionConfig = {
      onPermissionRequest: approveAll,
      workingDirectory,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(systemMessage ? { systemMessage: { mode: 'append' as const, content: systemMessage } } : {}),
    };
    const session = await client.resumeSession(sessionId, config);
    this.sessions.set(sessionId, session);
    if (workingDirectory) this.sessionWorkingDirectory.set(sessionId, workingDirectory);
    this.attachModelTracking(session);
    void this.seedModelInfoFromHistory(session);
    return session;
  }

  async createSession(
    workingDirectory: string,
    systemMessage?: string,
    reasoningEffort?: "low" | "medium" | "high" | "xhigh",
  ): Promise<CopilotSession> {
    const client = this.getOrCreateClient();
    const config: SessionConfig = {
      onPermissionRequest: approveAll,
      workingDirectory,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(systemMessage ? { systemMessage: { mode: 'append' as const, content: systemMessage } } : {}),
    };
    const session = await client.createSession(config);
    this.sessions.set(session.sessionId, session);
    this.sessionWorkingDirectory.set(session.sessionId, workingDirectory);
    this.attachModelTracking(session);
    void this.seedModelInfoFromHistory(session);
    return session;
  }

  async setSessionModel(
    sessionId: string,
    model: string,
    reasoningEffort?: "low" | "medium" | "high" | "xhigh",
    workingDirectory?: string,
  ): Promise<void> {
    const session = await this.getOrResumeSession(sessionId, workingDirectory);
    await session.setModel(model, reasoningEffort ? { reasoningEffort } : undefined);
  }

  async listSessions(filter?: SessionListFilter): Promise<SessionMetadata[]> {
    const client = this.getOrCreateClient();
    if (client.getState() !== 'connected') {
      await client.start();
    }
    return client.listSessions(filter);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.disconnect().catch(() => {});
      this.sessions.delete(sessionId);
      this.sessionWorkingDirectory.delete(sessionId);
      this.sessionTitles.delete(sessionId);
    }
    const client = this.getOrCreateClient();
    await client.deleteSession(sessionId);
  }

  async listModels(): Promise<ModelInfo[]> {
    const client = this.getOrCreateClient();
    if (client.getState() !== 'connected') {
      await client.start();
    }
    return client.listModels();
  }

  async getCopilotStatus(): Promise<GetStatusResponse> {
    const client = this.getOrCreateClient();
    if (client.getState() !== 'connected') await client.start();
    return client.getStatus();
  }

  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    const client = this.getOrCreateClient();
    if (client.getState() !== 'connected') await client.start();
    return client.getAuthStatus();
  }

  async getSessionMessages(sessionId: string): Promise<SessionEvent[]> {
    // Use cached session if available; otherwise do a temporary resume (read-only, no caching)
    // to avoid polluting the session cache without a workingDirectory.
    let session = this.sessions.get(sessionId);
    let temporary = false;
    if (!session) {
      const client = this.getOrCreateClient();
      session = await client.resumeSession(sessionId, { onPermissionRequest: approveAll, disableResume: true });
      temporary = true;
    }
    const messages = await session.getMessages();
    if (temporary) {
      await session.disconnect().catch(() => {});
    }
    // seed model info from history while we have the messages
    if (!this.sessionModelInfo.has(sessionId)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const event = messages[i];
        if (event.type === 'assistant.usage') {
          this.sessionModelInfo.set(sessionId, { model: event.data.model, reasoningEffort: event.data.reasoningEffort });
          break;
        }
      }
    }
    if (!this.sessionTitles.has(sessionId)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const event = messages[i];
        if (event.type === 'session.title_changed' && event.data.title.trim()) {
          this.sessionTitles.set(sessionId, event.data.title);
          break;
        }
      }
    }
    return messages;
  }

  getSessionTitle(sessionId: string): string | undefined {
    return this.sessionTitles.get(sessionId);
  }

  private async readSessionTitleFromWorkspace(sessionId: string): Promise<string | undefined> {
    const workspacePath = path.join(copilotSessionStateDir(), sessionId, "workspace.yaml");
    const raw = await fs.readFile(workspacePath, "utf8").catch(() => undefined);
    if (!raw) return undefined;
    const title = parseWorkspaceTitle(raw);
    if (title?.trim()) {
      this.sessionTitles.set(sessionId, title.trim());
      return title.trim();
    }
    return undefined;
  }

  async readSessionTitle(sessionId: string): Promise<string | undefined> {
    if (this.sessionTitles.has(sessionId)) return this.sessionTitles.get(sessionId);
    try {
      await this.getSessionMessages(sessionId);
    } catch {
      // ignore
    }
    return this.sessionTitles.get(sessionId) || this.readSessionTitleFromWorkspace(sessionId);
  }

  async renameSession(sessionId: string, title: string, workingDirectory?: string): Promise<string | undefined> {
    const session = await this.getOrResumeSession(sessionId, workingDirectory);
    const currentTitle = this.sessionTitles.get(sessionId);
    const postIdleTitleGraceMs = 200;
    let resolveDone: (value: string | undefined) => void;
    let rejectDone: (reason?: unknown) => void;
    const done = new Promise<string | undefined>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    let settled = false;
    let idleGraceTimeout: NodeJS.Timeout | undefined;
    let titleSeen = false;
    const finishResolve = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (idleGraceTimeout) clearTimeout(idleGraceTimeout);
      resolveDone(value);
    };
    const finishReject = (reason: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (idleGraceTimeout) clearTimeout(idleGraceTimeout);
      rejectDone(reason);
    };
    const timeoutId = setTimeout(() => {
      finishResolve(this.sessionTitles.get(sessionId) ?? currentTitle ?? title);
    }, 15000);
    const unsubTitleChanged = session.on("session.title_changed", (event) => {
      const nextTitle = event.data.title.trim();
      if (!nextTitle) return;
      titleSeen = true;
      finishResolve(nextTitle);
    });
    const unsubIdle = session.on("session.idle", () => {
      if (settled) return;
      if (titleSeen) {
        finishResolve(this.sessionTitles.get(sessionId) ?? currentTitle ?? title);
        return;
      }
      if (idleGraceTimeout) clearTimeout(idleGraceTimeout);
      idleGraceTimeout = setTimeout(() => {
        finishResolve(this.sessionTitles.get(sessionId) ?? currentTitle ?? title);
      }, postIdleTitleGraceMs);
    });
    const unsubError = session.on("session.error", (event) => {
      const error = new Error(event.data.message);
      error.stack = event.data.stack;
      finishReject(error);
    });
    try {
      await session.send({ prompt: `/rename ${JSON.stringify(title)}` });
      const resolvedTitle = await done;
      if (resolvedTitle?.trim()) {
        this.sessionTitles.set(sessionId, resolvedTitle);
      }
      return resolvedTitle;
    } finally {
      clearTimeout(timeoutId);
      if (idleGraceTimeout) clearTimeout(idleGraceTimeout);
      unsubTitleChanged();
      unsubIdle();
      unsubError();
    }
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.sessionWorkingDirectory.delete(sessionId);
    this.sessionTitles.delete(sessionId);
  }

  async compactSession(sessionId: string, workingDirectory?: string): Promise<{ success: boolean; tokensRemoved: number; messagesRemoved: number }> {
    const session = await this.getOrResumeSession(sessionId, workingDirectory);
    const historyConnection = getSessionHistoryConnection(session);
    if (historyConnection) {
      try {
        return await historyConnection.sendRequest("session.history.compact", { sessionId: historyConnection.sessionId });
      } catch (error) {
        // Compatibility fallback: older SDK/runtime combinations surface
        // "unsupported method" only via error text, so this branch depends on
        // upstream wording remaining recognizable.
        if (!isUnsupportedMethodError(error, "session.history.compact")) throw error;
      }
    }

    const rpc = getSessionCompactRpc(session);
    if (typeof rpc.history?.compact === "function") {
      return rpc.history.compact();
    }
    if (typeof rpc.compaction?.compact === "function") {
      return rpc.compaction.compact();
    }
    throw new Error("Session compaction RPC is unavailable.");
  }

  async getQuota(): Promise<number | undefined> {
    try {
      const client = this.getOrCreateClient();
      const result = await client.rpc.account.getQuota();
      const snapshots = result.quotaSnapshots;
      type Snap = { remainingPercentage: number };
      const get = (key: string) => (snapshots[key] as Snap | undefined)?.remainingPercentage;
      // "premium_interactions" matches native copilot's "Remaining reqs."
      const pct = get("premium_interactions") ?? get("chat");
      if (pct !== undefined) return pct;
      const values = Object.values(snapshots).map(s => (s as Snap).remainingPercentage);
      return values.length > 0 ? Math.min(...values) : undefined;
    } catch {
      return undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.stop().catch(() => {});
      this.client = null;
      this.sessions.clear();
      this.sessionWorkingDirectory.clear();
      this.sessionTitles.clear();
    }
  }
}
