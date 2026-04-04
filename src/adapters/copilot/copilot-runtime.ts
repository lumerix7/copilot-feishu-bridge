import { randomUUID } from 'node:crypto';
import { AcpClient } from './acp-client.js';
import type { CopilotBackend, CopilotInfo, CopilotRunHandle, CopilotRunHooks, CopilotTurnOptions } from './backend.js';
import type { IncomingMessage } from '../../types/domain.js';
import type { SessionMetadata, CopilotSession, SessionEvent, ModelInfo } from '@github/copilot-sdk';
import type { AppConfig } from '../../config/env.js';
import type { SessionModelInfo } from './acp-client.js';

// Render a tool execution_start event as a compact ```text block
function renderToolStart(event: Extract<SessionEvent, { type: 'tool.execution_start' }>): string {
  const { toolName, mcpServerName, mcpToolName } = event.data;
  const displayName = mcpServerName ? `${mcpServerName}/${mcpToolName ?? toolName}` : toolName;
  return ["```text", `🛠️ Tool: ${displayName}`, "```"].join("\n");
}

// Render a tool execution_complete event as a compact ```text block
function renderToolComplete(event: Extract<SessionEvent, { type: 'tool.execution_complete' }>, mode: "compact" | "full"): string {
  const { toolCallId, success, result } = event.data;
  const icon = success ? "✅" : "❌";
  const id = toolCallId.slice(0, 8);
  if (mode === "full" && result?.detailedContent) {
    const detail = result.detailedContent.slice(0, 800).trim();
    return ["```text", `${icon} Tool done (${id})`, detail ? `output: ${detail}` : "", "```"].filter(l => l !== "").join("\n");
  }
  return ["```text", `${icon} Tool done (${id})`, "```"].join("\n");
}

// Render a session.info event if it's worth showing
function renderSessionInfo(event: Extract<SessionEvent, { type: 'session.info' }>): string | undefined {
  const { infoType, message } = event.data;
  // Skip noisy low-value categories
  if (["timing", "context_window", "snapshot"].includes(infoType)) return undefined;
  return ["```text", `ℹ️ ${message}`, "```"].join("\n");
}

// Render assistant reasoning as a collapsible-style block
function renderReasoning(event: Extract<SessionEvent, { type: 'assistant.reasoning' }>): string {
  const preview = event.data.content.slice(0, 300).replace(/\n+/g, " ").trim();
  return ["```text", `🧠 Thinking: ${preview}${event.data.content.length > 300 ? "…" : ""}`, "```"].join("\n");
}

// Build the full streamed output: event blocks + assistant text
function buildTimelineText(blocks: string[], assistantText: string): string {
  const parts = [...blocks];
  if (assistantText) parts.push(assistantText);
  return parts.join("\n\n");
}

export class AcpCopilotBackend implements CopilotBackend {
  readonly mode = 'acp' as const;
  private readonly acpClient = new AcpClient();
  private readonly activeRuns = new Map<string, () => void>();

  constructor(private readonly config: AppConfig) {}

  async createSession(project: string, options?: CopilotTurnOptions): Promise<string> {
    const session = await this.acpClient.createSession(project, options?.systemMessage, options?.reasoningEffort);
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
            options?.systemMessage,
            options?.reasoningEffort,
          );
          resolvedSessionId = sessionId;
        } catch {
          session = await this.acpClient.createSession(project, options?.systemMessage, options?.reasoningEffort);
          resolvedSessionId = session.sessionId;
        }
      } else {
        session = await this.acpClient.createSession(project, options?.systemMessage, options?.reasoningEffort);
        resolvedSessionId = session.sessionId;
      }

      let accumulated = '';
      let cancelled = false;
      const eventBlocks: string[] = [];
      const inlineBlocks = this.config.copilot.inlineBlocks;

      const unsubscribe = session.on((event: SessionEvent) => {
        if (event.type === 'assistant.message_delta') {
          accumulated += event.data.deltaContent;
          hooks?.onUpdate?.(buildTimelineText(eventBlocks, accumulated));
        } else if (inlineBlocks !== "off") {
          if (event.type === 'tool.execution_start') {
            eventBlocks.push(renderToolStart(event));
            hooks?.onUpdate?.(buildTimelineText(eventBlocks, accumulated));
          } else if (event.type === 'tool.execution_complete') {
            eventBlocks.push(renderToolComplete(event, inlineBlocks));
            hooks?.onUpdate?.(buildTimelineText(eventBlocks, accumulated));
          } else if (event.type === 'assistant.reasoning') {
            eventBlocks.push(renderReasoning(event));
            hooks?.onUpdate?.(buildTimelineText(eventBlocks, accumulated));
          } else if (event.type === 'session.info') {
            const block = renderSessionInfo(event);
            if (block) {
              eventBlocks.push(block);
              hooks?.onUpdate?.(buildTimelineText(eventBlocks, accumulated));
            }
          }
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
        const finalOutput = buildTimelineText(eventBlocks, result?.data?.content ?? accumulated);
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

  getSessionModelInfo(sessionId: string): SessionModelInfo | undefined {
    return this.acpClient.getSessionModelInfo(sessionId);
  }

  async probeSessionModelInfo(sessionId: string, workingDirectory?: string): Promise<SessionModelInfo | undefined> {
    return this.acpClient.probeSessionModelInfo(sessionId, workingDirectory);
  }

  async setSessionModel(sessionId: string, model: string, reasoningEffort?: "low" | "medium" | "high" | "xhigh"): Promise<void> {
    await this.acpClient.setSessionModel(sessionId, model, reasoningEffort);
  }

  async shutdown(): Promise<void> {
    await this.acpClient.shutdown();
  }
}

export function createCopilotBackend(config: AppConfig): CopilotBackend {
  return new AcpCopilotBackend(config);
}
