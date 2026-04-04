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

// Build a compact tool status block. Used for both the start (🛠️) and the
// in-place update on complete (✅/❌).  Keeping the same compact structure for
// both ensures the entry size barely changes on completion, which prevents
// page-boundary shifts that would cause other blocks to visually "replace" it.
function buildToolStatusBlock(
  event: Extract<SessionEvent, { type: 'tool.execution_start' }>,
  icon: string
): string {
  const { toolName, mcpServerName, mcpToolName, arguments: args } = event.data;
  const displayName = mcpServerName ? `${mcpServerName}/${mcpToolName ?? toolName}` : toolName;
  const argText = extractArgText(toolName, args);
  const lines = ["```text", `${icon} ${displayName}`];
  if (argText) lines.push(argText);
  lines.push("```");
  return lines.join("\n");
}

// Build a standalone output block for tool results. Appended as a NEW timeline
// entry at the end so it always lands on the active page and never shifts
// already-frozen pages.
function buildToolOutputBlock(
  completeEvent: Extract<SessionEvent, { type: 'tool.execution_complete' }>
): string | undefined {
  const { result } = completeEvent.data;
  const output = (result?.detailedContent ?? result?.content ?? "").trim();
  if (!output) return undefined;
  return ["```text", `→ ${output.replace(/\n/g, "\n   ")}`, "```"].join("\n");
}

// Render a session.info event if it's worth showing
function renderSessionInfo(event: Extract<SessionEvent, { type: 'session.info' }>): string | undefined {
  const { infoType, message } = event.data;
  if (["timing", "context_window", "snapshot"].includes(infoType)) return undefined;
  return ["```text", `ℹ️ ${message}`, "```"].join("\n");
}

// Render a reasoning block from accumulated raw text.
// Used both for assistant.reasoning (full snapshot) and assistant.reasoning_delta (incremental).
function renderReasoningBlock(rawText: string): string {
  const text = rawText.trim().replace(/\n{3,}/g, "\n\n");
  return ["```text", `🧠 Thinking`, text, "```"].join("\n");
}

// Build the full streamed output: event blocks then assistant text
// Ordered timeline of mutable entries — text and blocks interleaved in arrival order.
// Entries are updated in place; new entries always append at end so page splits stay stable.
type TimelineEntry = { text: string };

function buildTimelineText(timeline: TimelineEntry[]): string {
  return timeline.map(e => e.text.trim()).filter(Boolean).join('\n\n');
}

export class AcpCopilotBackend implements CopilotBackend {
  readonly mode = 'acp' as const;
  private readonly acpClient = new AcpClient();
  private readonly activeRuns = new Map<string, () => void>();
  private readonly sessionQuotas = new Map<string, number>();

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
        // Proactively verify the session still exists on ACP before using it
        const exists = await this.acpClient.sessionExists(sessionId);
        if (!exists) {
          // Session gone from ACP — evict stale cache, try resume (ACP may still accept it), fall back to create
          this.acpClient.removeSession(sessionId);
          try {
            session = await this.acpClient.getOrResumeSession(
              sessionId, project, options?.systemMessage, options?.reasoningEffort,
            );
            resolvedSessionId = sessionId;
          } catch {
            session = await this.acpClient.createSession(project, options?.systemMessage, options?.reasoningEffort);
            resolvedSessionId = session.sessionId;
          }
        } else {
          try {
            session = await this.acpClient.getOrResumeSession(
              sessionId, project, options?.systemMessage, options?.reasoningEffort,
            );
            resolvedSessionId = sessionId;
          } catch {
            session = await this.acpClient.createSession(project, options?.systemMessage, options?.reasoningEffort);
            resolvedSessionId = session.sessionId;
          }
        }
      } else {
        session = await this.acpClient.createSession(project, options?.systemMessage, options?.reasoningEffort);
        resolvedSessionId = session.sessionId;
      }

      const timeline: TimelineEntry[] = [];
      // Current agent text entry — reset to null when a block is appended so
      // text arriving after a tool call creates a new entry after the block.
      let currentAgentEntry: TimelineEntry | null = null;
      let cancelled = false;
      const inlineBlocks = this.config.copilot.inlineBlocks;
      // Tool entries tracked by toolCallId for in-place complete-block update
      // Tool entries no longer needed for in-place updates — start blocks are permanent
      const toolStartEvents = new Map<string, Extract<SessionEvent, { type: 'tool.execution_start' }>>();
      // Track reasoning entries by reasoningId so repeated/delta events update the same block
      const reasoningEntries = new Map<string, TimelineEntry>();
      const reasoningTexts = new Map<string, string>();

      const appendAgentDelta = (delta: string): void => {
        if (!currentAgentEntry) {
          currentAgentEntry = { text: '' };
          timeline.push(currentAgentEntry);
        }
        currentAgentEntry.text += delta;
      };

      const addBlock = (text: string): TimelineEntry => {
        currentAgentEntry = null; // next text delta starts a new entry after this block
        const entry: TimelineEntry = { text };
        timeline.push(entry);
        return entry;
      };

      const runStartedAt = Date.now();
      // Track last VISIBLE update (onUpdate call) — probe fires when no visible output for statusIntervalMs
      let lastVisibleUpdateAt = runStartedAt;
      let probeEntry: TimelineEntry | undefined;

      const elapsedString = (ms: number): string => {
        const secs = Math.round(ms / 1000);
        const mins = Math.floor(secs / 60);
        return mins > 0 ? `${mins}m ${secs % 60}s` : `${secs}s`;
      };

      // Emit a visible streaming update and record the time
      const emitUpdate = (): void => {
        lastVisibleUpdateAt = Date.now();
        hooks?.onUpdate?.(buildTimelineText(timeline));
      };

      const subscribeSession = (s: CopilotSession): (() => void) => s.on((event: SessionEvent) => {
        if (event.type === 'assistant.message_delta') {
          appendAgentDelta(event.data.deltaContent);
          emitUpdate();
        } else if (inlineBlocks !== "off") {
          if (event.type === 'tool.execution_start') {
            toolStartEvents.set(event.data.toolCallId, event);
            addBlock(buildToolStatusBlock(event, "🛠️"));
            emitUpdate();
          } else if (event.type === 'tool.execution_complete') {
            const startEv = toolStartEvents.get(event.data.toolCallId);
            const icon = event.data.success ? "✅" : "❌";
            if (startEv !== undefined) {
              // 🛠️ start block stays as-is; ✅/❌ complete block appended as a new entry after it
              addBlock(buildToolStatusBlock(startEv, icon));
            } else {
              addBlock(["```text", `${icon} tool done`, "```"].join("\n"));
            }
            // Output appended as yet another new entry at the end
            const outputBlock = buildToolOutputBlock(event);
            if (outputBlock) addBlock(outputBlock);
            emitUpdate();
          } else if (event.type === 'assistant.reasoning') {
            // assistant.reasoning carries the COMPLETE text for this reasoning block.
            // Reuse the same entry for repeated events with the same reasoningId.
            const { reasoningId, content } = event.data;
            reasoningTexts.set(reasoningId, content);
            let entry = reasoningEntries.get(reasoningId);
            if (!entry) {
              entry = addBlock(renderReasoningBlock(content));
              reasoningEntries.set(reasoningId, entry);
            } else {
              entry.text = renderReasoningBlock(content);
            }
            emitUpdate();
          } else if (event.type === 'assistant.reasoning_delta') {
            // Accumulate incremental reasoning deltas into the same entry.
            const { reasoningId, deltaContent } = event.data;
            const accumulated = (reasoningTexts.get(reasoningId) ?? "") + deltaContent;
            reasoningTexts.set(reasoningId, accumulated);
            let entry = reasoningEntries.get(reasoningId);
            if (!entry) {
              entry = addBlock(renderReasoningBlock(accumulated));
              reasoningEntries.set(reasoningId, entry);
            } else {
              entry.text = renderReasoningBlock(accumulated);
            }
            emitUpdate();
          } else if (event.type === 'session.info') {
            const block = renderSessionInfo(event);
            if (block) {
              addBlock(block);
              emitUpdate();
            }
          }
        }
      });

      let unsubscribe = subscribeSession(session);

      // Probe: inject/update a "still running" inline block when no visible output for statusIntervalMs
      const statusIntervalMs = this.config.copilot.statusIntervalMs;
      let probeTimer: ReturnType<typeof setInterval> | undefined;
      if (statusIntervalMs > 0) {
        probeTimer = setInterval(() => {
          if (Date.now() - lastVisibleUpdateAt < statusIntervalMs) return;
          const elapsed = elapsedString(Date.now() - runStartedAt);
          const block = ["```text", `⏳ Running… (elapsed: ${elapsed})`, "```"].join("\n");
          if (!probeEntry) {
            probeEntry = addBlock(block);
          } else {
            probeEntry.text = block;
          }
          emitUpdate();
        }, statusIntervalMs);
        probeTimer.unref();
      }

      this.activeRuns.set(runId, () => {
        cancelled = true;
        session.abort().catch(() => {});
      });

      const finalizeTimeline = (finalContent?: string): string => {
        // Use server's authoritative final text if provided and differs from streamed deltas
        if (finalContent !== undefined) {
          if (currentAgentEntry) {
            currentAgentEntry.text = finalContent;
          } else if (finalContent.trim()) {
            timeline.push({ text: finalContent });
          }
        }
        return buildTimelineText(timeline);
      };

      try {
        const result = await session.sendAndWait(
          { prompt: input.text },
          this.config.copilot.runTimeoutMs || 600_000
        );
        // On success: if a probe block was shown, replace it with a completion marker
        if (probeEntry) {
          const elapsed = elapsedString(Date.now() - runStartedAt);
          probeEntry.text = ["```text", `⏱️ Completed (${elapsed})`, "```"].join("\n");
        }
        const finalOutput = finalizeTimeline(result?.data?.content);
        // Push final clean state so accumulatedStreamText in app.ts is up to date
        emitUpdate();
        return {
          runId,
          sessionId: resolvedSessionId,
          output: finalOutput,
          status: cancelled ? 'cancelled' : 'completed',
        };
      } catch (err) {
        // Stale cached session — evict, try resume first, fall back to create, then retry once
        if (err instanceof Error && err.message.includes("Session not found") && !cancelled) {
          this.acpClient.removeSession(resolvedSessionId);
          unsubscribe();
          try {
            try {
              session = await this.acpClient.getOrResumeSession(
                resolvedSessionId, project, options?.systemMessage, options?.reasoningEffort
              );
            } catch {
              session = await this.acpClient.createSession(project, options?.systemMessage, options?.reasoningEffort);
              resolvedSessionId = session.sessionId;
            }
            unsubscribe = subscribeSession(session);
            this.activeRuns.set(runId, () => { cancelled = true; session.abort().catch(() => {}); });
            const result = await session.sendAndWait(
              { prompt: input.text },
              this.config.copilot.runTimeoutMs || 600_000
            );
            if (probeEntry) {
              const elapsed = elapsedString(Date.now() - runStartedAt);
              probeEntry.text = ["```text", `⏱️ Completed (${elapsed})`, "```"].join("\n");
            }
            const finalOutput = finalizeTimeline(result?.data?.content);
            emitUpdate();
            return { runId, sessionId: resolvedSessionId, output: finalOutput, status: cancelled ? 'cancelled' : 'completed' };
          } catch (retryErr) {
            err = retryErr;
          }
        }
        // On failure/timeout: replace or append an error inline block
        const elapsed = elapsedString(Date.now() - runStartedAt);
        const isTimeout = !cancelled && (
          (err instanceof Error && err.message.toLowerCase().includes("timeout")) ||
          (Date.now() - runStartedAt >= (this.config.copilot.runTimeoutMs || 600_000) - 5_000)
        );
        const errorBlock = isTimeout
          ? ["```text", `❌ Turn timed out (${elapsed})`, "```"].join("\n")
          : ["```text", `❌ Turn failed (${elapsed}): ${err instanceof Error ? err.message : String(err)}`, "```"].join("\n");
        if (probeEntry) {
          probeEntry.text = errorBlock;
        } else {
          addBlock(errorBlock);
        }
        const errorOutput = buildTimelineText(timeline);
        emitUpdate();
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
        // Fire-and-forget: update quota cache after turn
        void this.acpClient.getQuota().then(q => {
          if (q !== undefined) this.sessionQuotas.set(resolvedSessionId, q);
        });
      }
    })();

    return { runId, done };
  }

  async compact(sessionId: string): Promise<{ success: boolean; tokensRemoved: number; messagesRemoved: number }> {
    return this.acpClient.compactSession(sessionId);
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

  getSessionQuota(sessionId: string): number | undefined {
    return this.sessionQuotas.get(sessionId);
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
