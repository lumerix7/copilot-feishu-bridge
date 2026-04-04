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

export class AcpClient {
  private client: CopilotClient | null = null;
  private sessions = new Map<string, CopilotSession>();

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

  async getOrResumeSession(
    sessionId: string,
    workingDirectory?: string,
    model?: string,
    systemMessage?: string,
  ): Promise<CopilotSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const client = this.getOrCreateClient();
    const config: ResumeSessionConfig = {
      onPermissionRequest: approveAll,
      workingDirectory,
      model,
      ...(systemMessage ? { systemMessage: { mode: 'append' as const, content: systemMessage } } : {}),
    };
    const session = await client.resumeSession(sessionId, config);
    this.sessions.set(sessionId, session);
    return session;
  }

  async createSession(
    workingDirectory: string,
    model?: string,
    systemMessage?: string,
  ): Promise<CopilotSession> {
    const client = this.getOrCreateClient();
    const config: SessionConfig = {
      onPermissionRequest: approveAll,
      workingDirectory,
      model,
      ...(systemMessage ? { systemMessage: { mode: 'append' as const, content: systemMessage } } : {}),
    };
    const session = await client.createSession(config);
    this.sessions.set(session.sessionId, session);
    return session;
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
    }
    return session.getMessages();
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      await this.client.stop().catch(() => {});
      this.client = null;
      this.sessions.clear();
    }
  }
}
