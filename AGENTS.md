# copilot-feishu-bridge

`copilot-feishu-bridge` is a Feishu-native control surface for real local GitHub Copilot sessions. Feishu is the chat UI, Copilot CLI plus ACP is the execution engine, and native Copilot sessions remain the source of truth for conversation state. The bridge should keep only conversation-to-session bindings, project/runtime metadata, and transport state; it should not invent a second assistant or fake continuity outside the real Copilot session lifecycle.

## Refs & Docs

- Main project doc: [`README.md`](./README.md)
- Sibling bridge reference: `../codex-feishu-bridge/`
- Copilot SDK package: <https://www.npmjs.com/package/@github/copilot-sdk>
- Feishu long connection docs: <https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode>
- Feishu CardKit streaming docs: <https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview>

## Development / Install

- Build + install: `./install.sh --yes`
- Deps: `npm install`
- Local dev watch: `npm run dev`
- Direct run from source: `npm run cli`
- Production start: `npm start`
- Service template: [`deploy/systemd/copilot-feishu-bridge.service.in`](./deploy/systemd/copilot-feishu-bridge.service.in)
- Main config template: [`deploy/config/config.json`](./deploy/config/config.json)

## Testing

- Typecheck: `npm run check`
- Build: `npm run build`
- Tests: `npm test`
- Gateway-focused tests: `npm test -- --test-name-pattern='splitMessageText|buildStreamingLineFrames|renderOutgoingBody'`
- Manual verification still matters for Feishu rendering: use targeted checks in DM plus local `/status`, `/new`, `/resume`, `/model`, `/project`, and wrapped local-command flows.

## Tips

- Be proactive: when a durable rule changes, update this file concisely; keep details in `README.md` or `docs/`.
- Prefer ACP-backed behavior over bridge-side emulation. Session existence, resume behavior, model state, and conversation history should come from the real Copilot session whenever possible.
- Keep command parsing centralized in [`src/core/command-router.ts`](./src/core/command-router.ts). If the slash-command surface changes, update the router, help text, and this file together.
- Keep Feishu rendering decisions centralized in [`src/adapters/feishu/feishu-gateway.ts`](./src/adapters/feishu/feishu-gateway.ts). Streaming pagination and retry behavior should stay in one place.
- Large fenced output can still render differently across Feishu desktop and mobile clients; keep the gateway line-safe and keep the caveat documented in [`docs/feishu-rendering-caveats.md`](./docs/feishu-rendering-caveats.md).
- Keep app-level policy in [`src/core/app.ts`](./src/core/app.ts): binding lookup, command dispatch, message titles/footers, severity mapping, and when to stream vs. send status cards.
- Copilot timeline rendering should stay append-only in spirit: tool starts, tool completions, tool output blocks, reasoning blocks, and idle probes should not reshuffle already-sent streamed pages.
- Treat stale ACP sessions as normal. Verify existence before reuse, evict dead cached sessions, and fall back cleanly to resume-or-create behavior rather than hard failing.
- Local project commands are intentionally explicit and allowlisted. Prefer extending the configured command map or the built-in list rather than introducing ad hoc shell execution.
- Keep project path enforcement strict. New project-binding behavior must respect allowed roots and default project constraints from config.
- Useful runtime checks:
  - `systemctl --user status copilot-feishu-bridge`
  - `systemctl --user cat copilot-feishu-bridge`
  - `journalctl --user -u copilot-feishu-bridge -n 200 --no-pager`
  - `which -a copilot-feishu-bridge`
