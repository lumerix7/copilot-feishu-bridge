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

export interface SessionModelInfo {
  model: string;
  reasoningEffort?: string;
}

export class AcpClient {
  private client: CopilotClient | null = null;
  private sessions = new Map<string, CopilotSession>();
  private sessionModelInfo = new Map<string, SessionModelInfo>();

  private getOrCreateClient(): CopilotClient {
    if (!this.client || this.client.getState() === 'error') {
      if (this.client && this.client.getState() === 'error') {
        this.sessions.clear();
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
    if (existing) return existing;

    const client = this.getOrCreateClient();
    const config: ResumeSessionConfig = {
      onPermissionRequest: approveAll,
      workingDirectory,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(systemMessage ? { systemMessage: { mode: 'append' as const, content: systemMessage } } : {}),
    };
    const session = await client.resumeSession(sessionId, config);
    this.sessions.set(sessionId, session);
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
    this.attachModelTracking(session);
    void this.seedModelInfoFromHistory(session);
    return session;
  }

  async setSessionModel(
    sessionId: string,
    model: string,
    reasoningEffort?: "low" | "medium" | "high" | "xhigh",
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not active: ${sessionId}`);
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
    // Reuse cached session or do a minimal resume just to read history
    let session = this.sessions.get(sessionId);
    if (!session) {
      const client = this.getOrCreateClient();
      session = await client.resumeSession(sessionId, { onPermissionRequest: approveAll });
      this.sessions.set(sessionId, session);
      this.attachModelTracking(session);
    }
    const messages = await session.getMessages();
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
    return messages;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async compactSession(sessionId: string): Promise<{ success: boolean; tokensRemoved: number; messagesRemoved: number }> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const client = this.getOrCreateClient();
      session = await client.resumeSession(sessionId, { onPermissionRequest: approveAll });
      this.sessions.set(sessionId, session);
      this.attachModelTracking(session);
    }
    return session.rpc.compaction.compact();
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
    }
  }
}
