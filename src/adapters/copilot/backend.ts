import type { SessionMetadata, SessionEvent, ModelInfo, GetStatusResponse, GetAuthStatusResponse } from '@github/copilot-sdk';
import { IncomingMessage } from "../../types/domain.js";

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
  model?: string;
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
  getSession(sessionId: string): Promise<string | undefined>;
  listSessions(project?: string, options?: { limit?: number }): Promise<SessionMetadata[]>;
  listModels(): Promise<ModelInfo[]>;
  getCopilotInfo(): Promise<CopilotInfo>;
  getSessionMessages(sessionId: string): Promise<SessionEvent[]>;
}
