import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AcpClient } from "../src/adapters/copilot/acp-client.js";

test("renameSession caches the requested title when no title_changed event arrives", async () => {
  const handlers = new Map<string, Set<(event: any) => void>>();
  const fakeSession = {
    on(eventType: string, handler: (event: any) => void) {
      if (!handlers.has(eventType)) handlers.set(eventType, new Set());
      handlers.get(eventType)!.add(handler);
      return () => handlers.get(eventType)?.delete(handler);
    },
    async send(_options: { prompt: string }) {
      for (const handler of handlers.get("session.idle") ?? []) {
        handler({ type: "session.idle", data: { backgroundTasks: [] } });
      }
      return "msg-1";
    }
  };

  const client = new AcpClient() as any;
  client.getOrResumeSession = async () => fakeSession;

  const title = await client.renameSession("session-1", "rename-after-new-test", "/tmp/project-a");

  assert.equal(title, "rename-after-new-test");
  assert.equal(client.getSessionTitle("session-1"), "rename-after-new-test");
});

test("renameSession waits briefly for title_changed after idle", async () => {
  const handlers = new Map<string, Set<(event: any) => void>>();
  const fakeSession = {
    on(eventType: string, handler: (event: any) => void) {
      if (!handlers.has(eventType)) handlers.set(eventType, new Set());
      handlers.get(eventType)!.add(handler);
      return () => handlers.get(eventType)?.delete(handler);
    },
    async send(_options: { prompt: string }) {
      for (const handler of handlers.get("session.idle") ?? []) {
        handler({ type: "session.idle", data: { backgroundTasks: [] } });
      }
      setTimeout(() => {
        for (const handler of handlers.get("session.title_changed") ?? []) {
          handler({ type: "session.title_changed", data: { title: "review-since-0404" } });
        }
      }, 50);
      return "msg-1";
    }
  };

  const client = new AcpClient() as any;
  client.getOrResumeSession = async () => fakeSession;

  const title = await client.renameSession("session-1", "rename-after-new-test", "/tmp/project-a");

  assert.equal(title, "review-since-0404");
  assert.equal(client.getSessionTitle("session-1"), "review-since-0404");
});

test("compactSession uses session.history.compact through the raw ACP connection", async () => {
  const client = new AcpClient() as any;
  client.getOrResumeSession = async () => ({
    sessionId: "session-1",
    connection: {
      async sendRequest(method: string, params: { sessionId: string }) {
        assert.equal(method, "session.history.compact");
        assert.deepEqual(params, { sessionId: "session-1" });
        return { success: true, tokensRemoved: 12, messagesRemoved: 3 };
      }
    },
    rpc: {
      compaction: {
        async compact() {
          throw new Error("legacy fallback should not be used");
        }
      }
    }
  });

  const result = await client.compactSession("session-1", "/tmp/project-a");

  assert.deepEqual(result, { success: true, tokensRemoved: 12, messagesRemoved: 3 });
});

test("compactSession falls back to legacy session.compaction.compact when history RPC is unsupported", async () => {
  const client = new AcpClient() as any;
  client.getOrResumeSession = async () => ({
    sessionId: "session-1",
    connection: {
      async sendRequest() {
        throw new Error("Unhandled method session.history.compact");
      }
    },
    rpc: {
      compaction: {
        async compact() {
          return { success: true, tokensRemoved: 7, messagesRemoved: 2 };
        }
      }
    }
  });

  const result = await client.compactSession("session-1", "/tmp/project-a");

  assert.deepEqual(result, { success: true, tokensRemoved: 7, messagesRemoved: 2 });
});

test("readSessionTitle falls back to workspace summary or name", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-session-state-"));
  const sessionId = "session-1";
  const workspaceDir = path.join(tempDir, sessionId);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, "workspace.yaml"),
    [
      `id: ${sessionId}`,
      "cwd: /tmp/project-a",
      "summary: Review changes",
      "name: Review changes",
      ""
    ].join("\n"),
    "utf8"
  );
  const previousDir = process.env.COPILOT_SESSION_STATE_DIR;
  process.env.COPILOT_SESSION_STATE_DIR = tempDir;

  try {
    const client = new AcpClient() as any;
    client.getSessionMessages = async () => [];

    const title = await client.readSessionTitle(sessionId);

    assert.equal(title, "Review changes");
    assert.equal(client.getSessionTitle(sessionId), "Review changes");
  } finally {
    if (previousDir === undefined) {
      delete process.env.COPILOT_SESSION_STATE_DIR;
    } else {
      process.env.COPILOT_SESSION_STATE_DIR = previousDir;
    }
  }
});
