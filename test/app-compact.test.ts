import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
    storePath: path.join(os.tmpdir(), `copilot-feishu-bridge-test-${process.pid}-${Date.now()}-compact.json`)
  } as const;
}

test("compact passes through ACP errors to Feishu", async () => {
  const app = new App(makeConfig());
  const store = (app as unknown as { store: { put: (value: unknown) => Promise<void> } }).store;
  await fs.mkdir("/tmp/project-a", { recursive: true });
  await store.put({
    conversationKey: "p2p:chat_test",
    copilotSessionId: "session-1",
    project: "/tmp/project-a",
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z"
  });

  const statuses: string[] = [];
  (app as unknown as { copilot: unknown }).copilot = {
    mode: "acp" as const,
    createSession: async () => "unused",
    runTurn: async () => {
      throw new Error("not used");
    },
    stop: async () => false,
    compact: async () => {
      throw new Error("Request session.history.compact failed with message: Cannot compact: no active agent context. Send a message first.");
    },
    getSession: async () => "session-1",
    getSessionTitle: async () => undefined,
    listSessions: async () => [],
    listModels: async () => [],
    getCopilotInfo: async () => {
      throw new Error("not used");
    },
    getSessionMessages: async () => [],
    getSessionModelInfo: () => undefined,
    getSessionQuota: () => undefined,
    probeSessionModelInfo: async () => undefined,
    setSessionModel: async () => {},
    renameSession: async () => undefined
  };

  const result = await app.handleIncoming({
    chatId: "chat_test",
    messageId: "msg_test",
    chatType: "p2p",
    text: "/compact"
  }, undefined, async (status) => {
    statuses.push(String(status));
  });

  assert.equal(typeof result, "object");
  assert.equal(result?.severity, "error");
  assert.match(result?.text ?? "", /Request session\.history\.compact failed with message: Cannot compact: no active agent context\. Send a message first\./);
  assert.deepEqual(statuses, ["Compacting session `session-1`..."]);
});
