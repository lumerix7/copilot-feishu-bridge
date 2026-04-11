export type FeishuConversationKey = string;
export type CopilotSessionId = string;
export type OutgoingBodyFormat = "raw-markdown" | "raw-text";

export interface SessionBinding {
  conversationKey: FeishuConversationKey;
  copilotSessionId?: CopilotSessionId;
  lastCopilotSessionId?: CopilotSessionId;
  lastProject?: string;
  sessionTitle?: string;
  project: string;
  searchEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveRun {
  conversationKey: FeishuConversationKey;
  copilotSessionId: CopilotSessionId;
  runId: string;
  startedAt: string;
  status: "starting" | "running" | "stopping";
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group" | "unknown";
  threadId?: string;
  rootId?: string;
  senderOpenId?: string;
  text: string;
}

export interface OutgoingMessage {
  chatId: string;
  title?: string;
  text?: string;
  bodyFormat?: OutgoingBodyFormat;
  template?: "blue" | "wathet" | "turquoise" | "green" | "yellow" | "orange" | "red" | "carmine" | "violet" | "purple" | "indigo" | "grey" | "default";
  footer?: string;
  replyToMessageId?: string;
  threadId?: string;
  streaming?: boolean;
  streamKey?: string;
  finalizeStreaming?: boolean;
  suppressChunkFooter?: boolean;
  preserveStreamingPages?: boolean;
}
