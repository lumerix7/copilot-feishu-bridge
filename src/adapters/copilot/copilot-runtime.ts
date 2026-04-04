import { randomUUID } from 'node:crypto';
import { AcpClient } from './acp-client.js';
import type { CopilotBackend, CopilotInfo, CopilotRunHandle, CopilotRunHooks, CopilotTurnOptions } from './backend.js';
import type { IncomingMessage } from '../../types/domain.js';
import type { SessionMetadata, CopilotSession, SessionEvent, ModelInfo } from '@github/copilot-sdk';
import type { AppConfig } from '../../config/env.js';
import type { SessionModelInfo } from './acp-client.js';

// Extract the human-readable argument string from tool arguments.
// Pagination in Feishu handles length, so no truncation here.
function extractArgText(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  // bash/shell: show command directly
  const cmd = args["command"] ?? args["cmd"] ?? args["input"];
  if (typeof cmd === "string") return cmd.trim();
  // file tools: show path
  const filePath = args["path"] ?? args["file"] ?? args["filePath"];
  if (typeof filePath === "string") return String(filePath);
  // Generic: show first non-empty string-valued key
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && v.trim().length > 0 && k !== "session_id") {
      return `${k}: ${v.trim()}`;
    }
  }
  // Fallback: compact JSON
  try { return JSON.stringify(args); } catch { return ""; }
}

// Build the tool start block shown while execution is in progress
function buildToolStartBlock(event: Extract<SessionEvent, { type: 'tool.execution_start' }>): string {
  const { toolName, mcpServerName, mcpToolName, arguments: args } = event.data;
  const displayName = mcpServerName ? `${mcpServerName}/${mcpToolName ?? toolName}` : toolName;
  const argText = extractArgText(toolName, args);
  const lines = ["```text", `🛠️ ${displayName}`];
  if (argText) lines.push(argText);
  lines.push("```");
  return lines.join("\n");
}

// Replace the start block with a completed block including full output.
// Feishu pagination handles long output — no truncation.
function buildToolCompleteBlock(
  startEvent: Extract<SessionEvent, { type: 'tool.execution_start' }>,
  completeEvent: Extract<SessionEvent, { type: 'tool.execution_complete' }>
): string {
  const { toolName, mcpServerName, mcpToolName, arguments: args } = startEvent.data;
  const { success, result } = completeEvent.data;
  const displayName = mcpServerName ? `${mcpServerName}/${mcpToolName ?? toolName}` : toolName;
  const icon = success ? "✅" : "❌";
  const argText = extractArgText(toolName, args);
  const lines = ["```text", `${icon} ${displayName}`];
  if (argText) lines.push(argText);
  // Prefer detailed content (full diffs etc.) over the truncated LLM-facing content
  const output = (result?.detailedContent ?? result?.content ?? "").trim();
  if (output) lines.push("→ " + output.replace(/\n/g, "\n   "));
  lines.push("```");
  return lines.join("\n");
}

// Render a session.info event if it's worth showing
function renderSessionInfo(event: Extract<SessionEvent, { type: 'session.info' }>): string | undefined {
  const { infoType, message } = event.data;
  if (["timing", "context_window", "snapshot"].includes(infoType)) return undefined;
  return ["```text", `ℹ️ ${message}`, "```"].join("\n");
}

// Render full reasoning content — pagination handles length
function renderReasoning(event: Extract<SessionEvent, { type: 'assistant.reasoning' }>): string {
  const text = event.data.content.trim().replace(/\n{3,}/g, "\n\n");
  return ["```text", `🧠 Thinking`, text, "```"].join("\n");
}

// Build the full streamed output: event blocks then assistant text
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
      // Track toolCallId -> block index for replacing start block with complete block
      const toolBlockIndex = new Map<string, number>();
      const toolStartEvents = new Map<string, Extract<SessionEvent, { type: 'tool.execution_start' }>>();

      const runStartedAt = Date.now();
      // Track last VISIBLE update (onUpdate call) — probe fires when no visible output for statusIntervalMs
      let lastVisibleUpdateAt = runStartedAt;
      let probeBlockIndex: number | undefined;

      const elapsedString = (ms: number): string => {
        const secs = Math.round(ms / 1000);
        const mins = Math.floor(secs / 60);
        return mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
      };

      // Emit a visible streaming update and record the time
      const emitUpdate = (text: string): void => {
        lastVisibleUpdateAt = Date.now();
        hooks?.onUpdate?.(text);
      };

      const unsubscribe = session.on((event: SessionEvent) => {
        if (event.type === 'assistant.message_delta') {
          accumulated += event.data.deltaContent;
          emitUpdate(buildTimelineText(eventBlocks, accumulated));
        } else if (inlineBlocks !== "off") {
          if (event.type === 'tool.execution_start') {
            toolStartEvents.set(event.data.toolCallId, event);
            const idx = eventBlocks.length;
            toolBlockIndex.set(event.data.toolCallId, idx);
            eventBlocks.push(buildToolStartBlock(event));
            emitUpdate(buildTimelineText(eventBlocks, accumulated));
          } else if (event.type === 'tool.execution_complete') {
            const startEv = toolStartEvents.get(event.data.toolCallId);
            const idx = toolBlockIndex.get(event.data.toolCallId);
            if (startEv !== undefined && idx !== undefined) {
              eventBlocks[idx] = buildToolCompleteBlock(startEv, event);
            } else {
              const icon = event.data.success ? "✅" : "❌";
              eventBlocks.push(["```text", `${icon} tool done`, "```"].join("\n"));
            }
            emitUpdate(buildTimelineText(eventBlocks, accumulated));
          } else if (event.type === 'assistant.reasoning') {
            eventBlocks.push(renderReasoning(event));
            emitUpdate(buildTimelineText(eventBlocks, accumulated));
          } else if (event.type === 'session.info') {
            const block = renderSessionInfo(event);
            if (block) {
              eventBlocks.push(block);
              emitUpdate(buildTimelineText(eventBlocks, accumulated));
            }
          }
        }
      });

      // Probe: inject/update a "still running" inline block when no visible output for statusIntervalMs
      const statusIntervalMs = this.config.copilot.statusIntervalMs;
      let probeTimer: ReturnType<typeof setInterval> | undefined;
      if (statusIntervalMs > 0) {
        probeTimer = setInterval(() => {
          if (Date.now() - lastVisibleUpdateAt < statusIntervalMs) return;
          const elapsed = elapsedString(Date.now() - runStartedAt);
          const block = ["```text", `⏳ Running… (elapsed: ${elapsed})`, "```"].join("\n");
          if (probeBlockIndex === undefined) {
            probeBlockIndex = eventBlocks.length;
            eventBlocks.push(block);
          } else {
            eventBlocks[probeBlockIndex] = block;
          }
          emitUpdate(buildTimelineText(eventBlocks, accumulated));
        }, statusIntervalMs);
        probeTimer.unref();
      }

      this.activeRuns.set(runId, () => {
        cancelled = true;
        session.abort().catch(() => {});
      });

      try {
        const result = await session.sendAndWait(
          { prompt: input.text },
          this.config.copilot.runTimeoutMs || 600_000
        );
        // On success: if a probe block was shown, replace it with a completion marker
        if (probeBlockIndex !== undefined) {
          const elapsed = elapsedString(Date.now() - runStartedAt);
          eventBlocks[probeBlockIndex] = ["```text", `⏱️ Completed (${elapsed})`, "```"].join("\n");
        }
        const finalOutput = buildTimelineText(eventBlocks, result?.data?.content ?? accumulated);
        // Push final clean state so accumulatedStreamText in app.ts is up to date
        emitUpdate(finalOutput);
        return {
          runId,
          sessionId: resolvedSessionId,
          output: finalOutput,
          status: cancelled ? 'cancelled' : 'completed',
        };
      } catch (err) {
        // On failure/timeout: replace or append an error inline block
        const elapsed = elapsedString(Date.now() - runStartedAt);
        const isTimeout = !cancelled && (
          (err instanceof Error && err.message.toLowerCase().includes("timeout")) ||
          (Date.now() - runStartedAt >= (this.config.copilot.runTimeoutMs || 600_000) - 5_000)
        );
        const errorBlock = isTimeout
          ? ["```text", `❌ Turn timed out (${elapsed})`, "```"].join("\n")
          : ["```text", `❌ Turn failed (${elapsed}): ${err instanceof Error ? err.message : String(err)}`, "```"].join("\n");
        if (probeBlockIndex !== undefined) {
          eventBlocks[probeBlockIndex] = errorBlock;
        } else {
          eventBlocks.push(errorBlock);
        }
        const errorOutput = buildTimelineText(eventBlocks, accumulated);
        emitUpdate(errorOutput);
        return {
          runId,
          sessionId: resolvedSessionId,
          output: errorOutput,
          status: 'cancelled',
        };
      } finally {
        unsubscribe();
        if (probeTimer !== undefined) clearInterval(probeTimer);
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
