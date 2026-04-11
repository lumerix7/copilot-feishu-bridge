# Copilot compaction notes

`/compact` is a supported Copilot CLI / SDK capability, but this bridge should pass through raw ACP errors because runtime behavior can still vary by session state and SDK/CLI version mix.

## Upstream references

- Copilot SDK / CLI compatibility: <https://docs.github.com/en/copilot/how-tos/copilot-sdk/troubleshooting/sdk-and-cli-compatibility#available-in-sdk>
- Copilot CLI context management / compaction: <https://docs.github.com/en/copilot/concepts/agents/copilot-cli/context-management#compaction>

## What we observed here

- Manual compaction is exposed by the SDK docs as `session.rpc.compaction.compact()`.
- In this bridge/runtime combination, the live ACP path may be `session.history.compact`.
- For some resumed older sessions, ACP can return:

  `Request session.history.compact failed with message: Cannot compact: no active agent context. Send a message first.`

- After sending one normal message in that resumed session, `/compact` succeeds.

## Bridge policy

- Keep `/compact` wired to native ACP compaction.
- Preserve raw SDK / ACP error text in Feishu instead of rewriting it.
- Render `/compact` failures with error severity.
