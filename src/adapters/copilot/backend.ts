import type { SessionMetadata, SessionEvent, ModelInfo, GetStatusResponse, GetAuthStatusResponse } from '@github/copilot-sdk';
import { IncomingMessage } from "../../types/domain.js";
import type { SessionModelInfo } from "./acp-client.js";

export interface CopilotTurnResult {
  runId: string;
  sessionId: string;
  output: string;
  status: "completed" | "cancelled";
}

export interface CopilotRunHandle {
  runId: string;
  done: Promise<CopilotTurnResult>;
}

export interface CopilotRunHooks {
  onStatus?: (text: string) => Promise<void> | void;
  onUpdate?: (update: string) => Promise<void> | void;
}

export interface CopilotTurnOptions {
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  systemMessage?: string;
}

export interface CopilotInfo {
  status: GetStatusResponse;
  auth: GetAuthStatusResponse;
}

export interface CopilotBackend {
  readonly mode: "acp";
  createSession(project: string, options?: CopilotTurnOptions): Promise<string>;
  runTurn(
    input: IncomingMessage,
    sessionId: string | undefined,
    project: string,
    options?: CopilotTurnOptions,
    hooks?: CopilotRunHooks
  ): Promise<CopilotRunHandle>;
  stop(runId: string): Promise<boolean>;
  compact(sessionId: string): Promise<{ success: boolean; tokensRemoved: number; messagesRemoved: number }>;
  getSession(sessionId: string): Promise<string | undefined>;
  listSessions(project?: string, options?: { limit?: number }): Promise<SessionMetadata[]>;
  listModels(): Promise<ModelInfo[]>;
  getCopilotInfo(): Promise<CopilotInfo>;
  getSessionMessages(sessionId: string): Promise<SessionEvent[]>;
  getSessionModelInfo(sessionId: string): SessionModelInfo | undefined;
  probeSessionModelInfo(sessionId: string, workingDirectory?: string): Promise<SessionModelInfo | undefined>;
  setSessionModel(sessionId: string, model: string, reasoningEffort?: "low" | "medium" | "high" | "xhigh"): Promise<void>;
}
