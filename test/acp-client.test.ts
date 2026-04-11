import assert from "node:assert/strict";
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
