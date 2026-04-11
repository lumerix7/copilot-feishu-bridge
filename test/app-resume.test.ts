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
      titleMaxLength: 80
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
    storePath: path.join(os.tmpdir(), `copilot-feishu-bridge-test-${process.pid}-${Date.now()}.json`)
  } as const;
}

function makeBackend(options?: {
  sessions?: SessionMetadata[];
  messages?: SessionEvent[];
  sessionExists?: boolean;
}) {
  const sessions = options?.sessions ?? [];
  const messages = options?.messages ?? [];
  const sessionExists = options?.sessionExists ?? true;
  return {
    mode: "acp" as const,
    createSession: async () => "unused",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    compact: async () => ({ success: true, tokensRemoved: 0, messagesRemoved: 0 }),
    getSession: async (sessionId: string) => (sessionExists ? sessionId : undefined),
    getSessionTitle: async () => undefined,
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
    renameSession: async () => undefined
  };
}

test("resume help works regardless of -h position", async () => {
  const app = new App(makeConfig());

  for (const text of [
    "/resume -h",
    "/resume session-1 -h",
    "/resume -h session-1",
    "/resume --messages 8 -h"
  ]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Resume\n\nResume a session\./);
  }
});

test("session help works regardless of -h position", async () => {
  const app = new App(makeConfig());

  for (const text of [
    "/session -h",
    "/session session-1 -h",
    "/session -h session-1",
    "/session list --project /tmp/project-a -h"
  ]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Session\n\nInspect the current bound session, inspect one specific Copilot session, or browse recent sessions\./);
  }
});

test("session with an explicit session id renders that session without bound flags", async () => {
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
    context: { cwd: "/tmp/project-b" }
  } as SessionMetadata;
  const backend = makeBackend({ sessions: [sessionMeta], sessionExists: true });
  (backend as { getSessionModelInfo: (sessionId: string) => { model?: string } | undefined }).getSessionModelInfo =
    (sessionId: string) => sessionId === "session-2" ? { model: "gpt-5" } : undefined;
  (app as unknown as { copilot: unknown }).copilot = backend;

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/session session-2"
  });

  assert.equal(typeof result, "string");
  assert.match(String(result), /^# Session\n\n- \*\*Session\*\*: `session-2`\n- \*\*Project\*\*: `\/tmp\/project-b`/);
  assert.match(String(result), /- \*\*Flags\*\*: -$/m);
});

test("resume without a selector warns and points to explicit latest aliases", async () => {
  const app = new App(makeConfig());

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume"
  });

  assert.equal(typeof result, "object");
  assert.equal((result as { severity?: string }).severity, "warning");
  assert.match(
    String((result as { text: string }).text),
    /^# Resume\n\n- \*\*Error\*\*: pick a session explicitly, or use `-` to resume the most recent session\n- \*\*Usage\*\*: `\/resume \[<session-id>\|-\|--last\|-n <index>\|list\|-h\]`$/
  );
});

test("resume missing session renders an error card with resume-list guidance", async () => {
  const app = new App(makeConfig());
  (app as unknown as { copilot: unknown }).copilot = makeBackend({ sessionExists: false });

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume session-missing"
  });

  assert.equal(typeof result, "object");
  assert.equal((result as { severity?: string }).severity, "error");
  assert.match(
    String((result as { text: string }).text),
    /^# Resume\n\n- \*\*Error\*\*: Session not found: `session-missing`\n- \*\*Note\*\*: Use `\/resume list` or `\/session list` to find resumable sessions\.$/
  );
});

test("resume last aliases render source as last", async () => {
  const app = new App(makeConfig());
  const sessionMeta = {
    sessionId: "session-1",
    summary: "session summary",
    startTime: new Date("2026-04-09T12:00:00.000Z"),
    context: { cwd: "/tmp/project-a" }
  } as SessionMetadata;
  (app as unknown as { copilot: unknown }).copilot = makeBackend({ sessions: [sessionMeta] });

  for (const text of ["/resume -", "/resume --last"]) {
    const result = await app.handleIncoming({
      chatId: "chat_test",
      messageId: "msg_test",
      chatType: "p2p",
      text
    });

    assert.equal(typeof result, "string");
    assert.match(String(result), /^# Resume Session\n\n- \*\*Source\*\*: `last`\n\n- \*\*Session\*\*: `session-1`/);
    assert.match(String(result), /- \*\*Last message\*\*:\n\n```text\nsession summary\n```\n- \*\*Title\*\*: \\\(none\\\)\n- \*\*Flags\*\*: `current`, bound$/);
  }
});

test("recent replay messages render as Copilot and User fenced text blocks", () => {
  const app = new App(makeConfig());

  const assistantRendered = (app as unknown as {
    renderRecentSessionReplayMessage: (message: { role: "assistant"; text: string; timestamp?: string }, index: number) => { text: string; bodyFormat?: string };
  }).renderRecentSessionReplayMessage(
    {
      role: "assistant",
      text: "before ``` inside",
      timestamp: "2026-04-09T12:27:10.194Z"
    },
    0
  );
  const userRendered = (app as unknown as {
    renderRecentSessionReplayMessage: (message: { role: "user"; text: string; timestamp?: string }, index: number) => { text: string; bodyFormat?: string };
  }).renderRecentSessionReplayMessage(
    {
      role: "user",
      text: "plain user text"
    },
    1
  );

  assert.deepEqual(assistantRendered, {
    text: "[Copilot] 2026-04-09T20:27:10.194+08:00\n\nbefore ``` inside",
    bodyFormat: "raw-text"
  });
  assert.deepEqual(userRendered, {
    text: "[User]\n\nplain user text",
    bodyFormat: "raw-text"
  });
});

test("resume emits recent replay messages as separate status updates", async () => {
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
    summary: "summary preview",
    startTime: new Date("2026-04-09T12:00:00.000Z"),
    context: { cwd: "/tmp/project-a" }
  } as SessionMetadata;
  const messages = [
    {
      type: "assistant.message",
      data: { content: "hello from copilot" },
      timestamp: "2026-04-09T12:27:10.194Z"
    },
    {
      type: "user.message",
      data: { content: "follow-up" },
      timestamp: "2026-04-09T12:27:20.194Z"
    }
  ] as SessionEvent[];
  (app as unknown as { copilot: unknown }).copilot = makeBackend({
    sessions: [sessionMeta],
    messages
  });
  const statusUpdates: Array<string | { text: string; bodyFormat?: string }> = [];

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/resume session-1"
  }, undefined, async (text) => {
    statusUpdates.push(text);
  });

  assert.equal(typeof result, "string");
  assert.match(String(result), /^# Resume Session\n\n- \*\*Source\*\*: `explicit`/);
  assert.equal(statusUpdates.length, 3);
  assert.equal(statusUpdates[0], "Resolving session `session-1`...");
  assert.deepEqual(statusUpdates[1], {
    text: "[Copilot] 2026-04-09T20:27:10.194+08:00\n\nhello from copilot",
    bodyFormat: "raw-text"
  });
  assert.deepEqual(statusUpdates[2], {
    text: "[User] 2026-04-09T20:27:20.194+08:00\n\nfollow-up",
    bodyFormat: "raw-text"
  });
});

test("local command alias can prepend args and direct commands run unchanged", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-feishu-bridge-local-"));
  const projectDir = path.join(tempRoot, "project");
  const storePath = path.join(tempRoot, "store.json");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, ".hidden"), "hidden\n");

  const app = new App({
    ...makeConfig(),
    project: {
      allowedRoots: [tempRoot],
      defaultProject: projectDir,
      defaultSearchEnabled: true,
      knownPaths: [],
      listMaxCount: 100
    },
    commands: {
      map: {},
      alias: {
        ll: "ls -A"
      },
      direct: ["node"]
    },
    storePath
  });

  const updates: string[] = [];
  const lsResult = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_ls_alias",
    chatType: "p2p",
    text: "/ll"
  }, undefined, async (update) => {
    if (typeof update === "string") updates.push(update);
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0], "Running `ll`...\n\n```text\nll\n```");
  assert.equal(typeof lsResult, "object");
  assert.equal(lsResult?.bodyFormat, "raw-text");
  assert.match(lsResult?.text || "", /\.hidden/);

  const nodeResult = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_node_direct",
    chatType: "p2p",
    text: `/node -e "process.stdout.write('direct')"`
  });

  assert.equal(typeof nodeResult, "object");
  assert.equal(nodeResult?.bodyFormat, "raw-text");
  assert.equal(nodeResult?.text, "direct");
});

test("malformed local command alias is ignored with a warning", async () => {
  const app = new App({
    ...makeConfig(),
    commands: {
      map: {},
      alias: {
        broken: "\"unterminated"
      },
      direct: []
    }
  });
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const result = (app as any).resolveLocalProjectCommand("broken");
    const repeatedResult = (app as any).resolveLocalProjectCommand("broken");

    assert.equal(result, undefined);
    assert.equal(repeatedResult, undefined);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], [
      "invalid local command alias ignored",
      {
        commandName: "broken",
        alias: "\"unterminated",
        parseError: "unterminated double quote"
      }
    ]);
  } finally {
    console.warn = originalWarn;
  }
});
