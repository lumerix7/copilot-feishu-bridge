import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionEvent, SessionMetadata } from "@github/copilot-sdk";
import { App } from "../src/core/app.js";

function makeConfig() {
  return {
    nodeEnv: "test",
    feishu: {
      appId: "test-app",
      appSecret: "test-secret",
      botOpenId: "test-bot",
      connectionMode: "websocket",
      wsAutoReconnect: true,
      wsLoggerLevel: "error",
      wsAgentKeepAliveMsecs: 1000,
      wsAgentMaxSockets: 10,
      wsAgentMaxFreeSockets: 10,
      wsConnectWarnAfterMs: 1000,
      wsReconnectWarnThreshold: 3,
      reconnectReadyDebounceMs: 1000,
      sendRetryMaxAttempts: 1,
      sendRetryBaseDelayMs: 100,
      sendRetryMultiplier: 2,
      sendRetryMaxDelayMs: 1000,
      titleMaxLength: 80,
      footerTitleMaxLength: 50
    },
    copilot: {
      copilotBin: "copilot",
      outputSoftLimit: 4000,
      runTimeoutMs: 60000,
      statusIntervalMs: 1000,
      streamUpdateIntervalMs: 1000,
      sessionListDefaultCount: 20,
      sessionListMaxCount: 100,
      resumeDefaultMessages: 5,
      statusIncludeProject: true,
      inlineBlocks: "off"
    },
    commands: {
      map: {},
      alias: {},
      direct: []
    },
    project: {
      allowedRoots: ["/tmp"],
      defaultProject: "/tmp/project-a",
      defaultSearchEnabled: true,
      knownPaths: [],
      listMaxCount: 100
    },
    storePath: path.join(os.tmpdir(), `copilot-feishu-bridge-test-${process.pid}-${Date.now()}-rename.json`)
  } as const;
}

function makeBackend(options?: {
  sessions?: SessionMetadata[];
  messages?: SessionEvent[];
  sessionExists?: boolean;
  titleBySessionId?: Record<string, string | undefined>;
  onRename?: (sessionId: string, title: string, workingDirectory?: string) => Promise<string | undefined> | string | undefined;
}) {
  const sessions = options?.sessions ?? [];
  const messages = options?.messages ?? [];
  const sessionExists = options?.sessionExists ?? true;
  const titleBySessionId = options?.titleBySessionId ?? {};
  return {
    mode: "acp" as const,
    createSession: async () => "unused",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    compact: async () => ({ success: true, tokensRemoved: 0, messagesRemoved: 0 }),
    getSession: async (sessionId: string) => (sessionExists ? sessionId : undefined),
    getSessionTitle: async (sessionId: string) => titleBySessionId[sessionId],
    listSessions: async () => sessions,
    listModels: async () => [],
    getCopilotInfo: async () => {
      throw new Error("not used");
    },
    getSessionMessages: async () => messages,
    getSessionModelInfo: () => undefined,
    getSessionQuota: () => undefined,
    probeSessionModelInfo: async () => undefined,
    setSessionModel: async () => {},
    renameSession: async (sessionId: string, title: string, workingDirectory?: string) =>
      options?.onRename ? options.onRename(sessionId, title, workingDirectory) : title
  };
}

test("rename help works regardless of -h position", async () => {
  const app = new App(makeConfig());

  for (const text of [
    "/rename -h",
    "/rename 'Review changes' -h",
    "/rename --session session-1 -h",
    "/rename -h --session session-1"
  ]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Rename\n\nShow or change a Copilot session title\./);
  }
});

test("rename show path supports --session without rebinding and escapes markdown", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void>; get: (key: string) => Promise<any> } }).store;
  await fs.mkdir("/tmp/project-b", { recursive: true });
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-1",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });
  const sessionMeta = {
    sessionId: "session-2",
    summary: "preview session-2",
    startTime: new Date("2026-04-09T12:00:00.000Z"),
    modifiedTime: new Date("2026-04-09T12:30:00.000Z"),
    isRemote: false,
    context: { cwd: "/tmp/project-b" }
  } as SessionMetadata;
  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    sessions: [sessionMeta],
    titleBySessionId: { "session-2": "# Review `changes`" }
  });

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/rename --session session-2"
  });

  assert.equal(typeof result, "string");
  const binding = await store.get("p2p:chat_test");
  assert.equal(binding.copilotSessionId, "session-1");
  assert.match(String(result), /^# Rename\n\n- \*\*Session\*\*: `session-2`\n- \*\*Title\*\*: \\# Review \\`changes\\`$/);
});

test("rename supports --session without rebinding", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await fs.mkdir("/tmp/project-b", { recursive: true });
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-1",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });
  const sessionMeta = {
    sessionId: "session-2",
    summary: "preview session-2",
    startTime: new Date("2026-04-09T12:00:00.000Z"),
    modifiedTime: new Date("2026-04-09T12:30:00.000Z"),
    isRemote: false,
    context: { cwd: "/tmp/project-b" }
  } as SessionMetadata;
  let seen: { sessionId?: string; title?: string; project?: string } = {};
  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    sessions: [sessionMeta],
    onRename: async (sessionId: string, title: string, workingDirectory?: string) => {
      seen = { sessionId, title, project: workingDirectory };
      return title;
    }
  });

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/rename --session session-2 'Review changes'"
  });

  assert.equal(typeof result, "string");
  assert.deepEqual(seen, {
    sessionId: "session-2",
    title: "Review changes",
    project: "/tmp/project-b"
  });
  assert.match(String(result), /^# Rename\n\n- \*\*Session\*\*: `session-2`\n- \*\*Title\*\*: Review changes$/);
});

test("rename without a bound session renders a warning card", async () => {
  const app = new App(makeConfig());

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/rename"
  });

  assert.equal(typeof result, "object");
  assert.equal(result?.severity, "warning");
  assert.match(result?.text ?? "", /- \*\*Warning\*\*: No session is currently bound\. Use `\/new`, `\/resume`, or `\/session list` first/);
});

test("rename trusts the freshly bound session after /new", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-new",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  let seen: { sessionId?: string; title?: string; project?: string } = {};
  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    sessionExists: false,
    onRename: async (sessionId: string, title: string, workingDirectory?: string) => {
      seen = { sessionId, title, project: workingDirectory };
      return title;
    }
  });

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/rename 'rename-after-new-test'"
  });

  assert.equal(typeof result, "string");
  assert.deepEqual(seen, {
    sessionId: "session-new",
    title: "rename-after-new-test",
    project: "/tmp/project-a"
  });
  assert.match(String(result), /^# Rename\n\n- \*\*Session\*\*: `session-new`\n- \*\*Title\*\*: rename-after-new-test$/);
});

test("rename emits an early status update for the current bound session", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-2",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    onRename: async (_sessionId: string, title: string) => title
  });

  const statuses: Array<string | object> = [];
  await app.handleIncoming(
    {
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text: "/rename 'Review changes'"
    },
    undefined,
    async (status) => {
      statuses.push(status);
    }
  );

  assert.deepEqual(statuses, ["Renaming Copilot session `session-2`..."]);
});

test("rename returns a warning instead of a bridge error on ACP 400 failures", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-2",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    onRename: async () => {
      throw new Error("Execution failed: CAPIError: 400 400 Bad Request");
    }
  });

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/rename 'Review changes'"
  });

  assert.equal(typeof result, "object");
  assert.equal(result?.severity, "warning");
  assert.match(result?.text ?? "", /Copilot ACP could not rename this session/);
  assert.match(result?.text ?? "", /- \*\*Details\*\*: Execution failed: CAPIError: 400 400 Bad Request/);
});

test("rename warning includes structured SDK details when present", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-2",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    onRename: async () => {
      const error = new Error("Execution failed: CAPIError: 400 400 Bad Request(Request ID: test-request-id)");
      Object.assign(error, {
        code: -32001,
        data: {
          status: 400,
          requestId: "test-request-id"
        }
      });
      throw error;
    }
  });

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/rename 'Review changes'"
  });

  assert.equal(typeof result, "object");
  assert.equal(result?.severity, "warning");
  assert.match(result?.text ?? "", /- \*\*Details\*\*: Execution failed: CAPIError: 400 400 Bad Request\\\(Request ID: test-request-id\\\)/);
  assert.match(result?.text ?? "", /- \*\*Code\*\*: `-32001`/);
  assert.match(result?.text ?? "", /- \*\*SDK data\*\*: \\\{"status":400,"requestId":"test-request-id"\\\}/);
});

test("bound session title persists across restart for rename, session, and session list", async () => {
  const config = makeConfig();
  await fs.mkdir("/tmp/project-a", { recursive: true });
  const app = new App(config);
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-1",
    sessionTitle: "rename-test",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  const sessionMeta = {
    sessionId: "session-1",
    summary: "preview session-1",
    startTime: new Date("2026-04-09T12:00:00.000Z"),
    modifiedTime: new Date("2026-04-09T12:30:00.000Z"),
    isRemote: false,
    context: { cwd: "/tmp/project-a" }
  } as SessionMetadata;

  const restartedApp = new App(config);
  (restartedApp as unknown as { copilot: unknown }).copilot = makeBackend({
    sessions: [sessionMeta],
    titleBySessionId: {
      "session-1": undefined
    }
  });

  const renameResult = await restartedApp.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/rename"
  });
  const sessionResult = await restartedApp.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/session"
  });
  const listResult = await restartedApp.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/session list"
  });

  assert.equal(typeof renameResult, "string");
  assert.match(String(renameResult), /- \*\*Title\*\*: rename-test/);
  assert.equal(typeof sessionResult, "string");
  assert.match(String(sessionResult), /- \*\*Title\*\*: rename-test/);
  assert.equal(typeof listResult, "string");
  assert.match(String(listResult), /\| 1 \| \/tmp\/project-a \| .* \| session-1 \| preview session-1 \| rename-test \| `current`, bound \|/);
});

test("session detail and list render session titles", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-1",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  const sessionMeta = {
    sessionId: "session-1",
    summary: "preview session-1",
    startTime: new Date("2026-04-09T12:00:00.000Z"),
    modifiedTime: new Date("2026-04-09T12:30:00.000Z"),
    isRemote: false,
    context: { cwd: "/tmp/project-a" }
  } as SessionMetadata;
  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    sessions: [sessionMeta],
    titleBySessionId: {
      "session-1": "# Review `changes`"
    }
  });

  const sessionResult = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/session"
  });
  const listResult = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/session list"
  });

  assert.equal(typeof sessionResult, "string");
  assert.match(String(sessionResult), /- \*\*Title\*\*: \\# Review \\`changes\\`/);
  assert.equal(typeof listResult, "string");
  assert.match(String(listResult), /\| # \| Project \| Updated \| Session \| Last message \| Title \| Flags \|/);
  assert.match(String(listResult), /\| 1 \| \/tmp\/project-a \| .* \| session-1 \| preview session-1 \| # Review `changes` \| `current`, bound \|/);
});

test("session detail keeps hyphens readable while escaping markdown punctuation", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-1",
    project: "/tmp/project-a",
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z"
  });

  const sessionMeta = {
    sessionId: "session-1",
    summary: "preview session-1",
    startTime: new Date("2026-04-09T12:00:00.000Z"),
    modifiedTime: new Date("2026-04-09T12:30:00.000Z"),
    isRemote: false,
    context: { cwd: "/tmp/project-a" }
  } as SessionMetadata;
  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    sessions: [sessionMeta],
    titleBySessionId: {
      "session-1": "review-since-0407 #tag"
    }
  });

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/session"
  });

  assert.equal(typeof result, "string");
  assert.match(String(result), /- \*\*Title\*\*: review-since-0407 \\#tag/);
  assert.doesNotMatch(String(result), /review\\-since\\-0407/);
});
