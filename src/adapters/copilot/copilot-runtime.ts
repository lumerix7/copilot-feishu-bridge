import { randomUUID } from 'node:crypto';
import { AcpClient } from './acp-client.js';
import type { CopilotBackend, CopilotInfo, CopilotRunHandle, CopilotRunHooks, CopilotTurnOptions } from './backend.js';
import type { IncomingMessage } from '../../types/domain.js';
import type { SessionMetadata, CopilotSession, SessionEvent, ModelInfo } from '@github/copilot-sdk';
import type { AppConfig } from '../../config/env.js';

export class AcpCopilotBackend implements CopilotBackend {
  readonly mode = 'acp' as const;
  private readonly acpClient = new AcpClient();
  private readonly activeRuns = new Map<string, () => void>();

  constructor(private readonly config: AppConfig) {}

  async createSession(project: string, options?: CopilotTurnOptions): Promise<string> {
    const session = await this.acpClient.createSession(project, options?.model, options?.systemMessage);
    return session.sessionId;
  }

  async runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: CopilotTurnOptions,
    hooks?: CopilotRunHooks
  ): Promise<CopilotRunHandle> {
    const runId = randomUUID();

    const done = (async (): Promise<{ runId: string; sessionId: string; output: string; status: 'completed' | 'cancelled' }> => {
      let session: CopilotSession;
      let resolvedSessionId: string;

      if (sessionId) {
        try {
          session = await this.acpClient.getOrResumeSession(
            sessionId,
            project,
            options?.model,
            options?.systemMessage,
          );
          resolvedSessionId = sessionId;
        } catch {
          session = await this.acpClient.createSession(project, options?.model, options?.systemMessage);
          resolvedSessionId = session.sessionId;
        }
      } else {
        session = await this.acpClient.createSession(project, options?.model, options?.systemMessage);
        resolvedSessionId = session.sessionId;
      }

      let accumulated = '';
      let cancelled = false;

      const unsubscribe = session.on((event: SessionEvent) => {
        if (event.type === 'assistant.message_delta') {
          accumulated += event.data.deltaContent;
          hooks?.onUpdate?.(accumulated);
        }
      });

      this.activeRuns.set(runId, () => {
        cancelled = true;
        session.abort().catch(() => {});
      });

      try {
        const result = await session.sendAndWait(
          { prompt: input.text },
          this.config.copilot.runTimeoutMs || 600_000
        );
        const finalOutput = result?.data?.content ?? accumulated;
        return {
          runId,
          sessionId: resolvedSessionId,
          output: finalOutput,
          status: cancelled ? 'cancelled' : 'completed',
        };
      } finally {
        unsubscribe();
        this.activeRuns.delete(runId);
      }
    })();

    return { runId, done };
  }

  async stop(runId: string): Promise<boolean> {
    const abort = this.activeRuns.get(runId);
    if (abort) {
      abort();
      return true;
    }
    return false;
  }

  async getSession(sessionId: string): Promise<string | undefined> {
    try {
      const sessions = await this.acpClient.listSessions();
      return sessions.some((s) => s.sessionId === sessionId) ? sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  async listSessions(project?: string, options?: { limit?: number }): Promise<SessionMetadata[]> {
    try {
      const filter = project ? { cwd: project } : undefined;
      const all = await this.acpClient.listSessions(filter);
      const sorted = [...all].sort((a, b) => {
        const cwdA = a.context?.cwd ?? "";
        const cwdB = b.context?.cwd ?? "";
        const byCwd = cwdA.localeCompare(cwdB);
        if (byCwd !== 0) return byCwd;
        return b.modifiedTime.getTime() - a.modifiedTime.getTime();
      });
      return options?.limit ? sorted.slice(0, options.limit) : sorted;
    } catch {
      return [];
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      return await this.acpClient.listModels();
    } catch {
      return [];
    }
  }

  async getCopilotInfo(): Promise<CopilotInfo> {
    const [status, auth] = await Promise.all([
      this.acpClient.getCopilotStatus(),
      this.acpClient.getAuthStatus(),
    ]);
    return { status, auth };
  }

  async getSessionMessages(sessionId: string): Promise<SessionEvent[]> {
    try {
      return await this.acpClient.getSessionMessages(sessionId);
    } catch {
      return [];
    }
  }

  async shutdown(): Promise<void> {
    await this.acpClient.shutdown();
  }
}

export function createCopilotBackend(config: AppConfig): CopilotBackend {
  return new AcpCopilotBackend(config);
}
