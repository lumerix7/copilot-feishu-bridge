# copilot-feishu-bridge

A **Feishu-native bridge for GitHub Copilot** conversations. Chat with the local `copilot` CLI directly from Feishu via direct message, with full session management and streaming responses.

## Goal & Principles

- **DM-native**: all interaction is via Feishu direct messages; no web UI required
- **Local auth**: uses the existing local `copilot` CLI auth — no `GITHUB_TOKEN` required
- **ACP/headless backend**: drives Copilot via the `@github/copilot-sdk` Agent Communication Protocol, same as the CLI's headless mode
- **Session persistence**: conversation history is preserved across restarts
- **Streaming**: Copilot responses stream to Feishu cards with live token updates

## Setup

### 1. Prerequisites

- Node.js 18+
- `copilot` CLI installed and authenticated (run `copilot auth login` first)
- A Feishu app with websocket event subscription enabled

### 2. Install

```sh
npm install && npm run build
```

Or install globally (used by the systemd service):

```sh
bash install.sh
```

### 3. Configure

Primary secrets go in `~/.config/copilot-feishu-bridge/bridge.env` (used as systemd `EnvironmentFile`):

```ini
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BOT_OPEN_ID=ou_xxx
FEISHU_STARTUP_NOTIFY_CHAT_ID=oc_xxx   # optional: p2p chat to notify on startup
BRIDGE_CONFIG_JSON=/home/<user>/.config/copilot-feishu-bridge/config.json
```

Additional settings live in `config.json` (pointed to by `BRIDGE_CONFIG_JSON`):

```json
{
  "copilot": {
    "defaultModel": "claude-sonnet-4.5"
  },
  "project": {
    "allowedRoots": ["/home/<user>", "/volumes"],
    "defaultPath": "/path/to/default/project",
    "knownPaths": ["/path/to/project-a", "/path/to/project-b"],
    "listMaxCount": 100
  },
  "paths": {
    "storePath": "/home/<user>/.local/share/copilot-feishu-bridge/bindings.json"
  }
}
```

### 4. Run (systemd)

```sh
systemctl --user start copilot-feishu-bridge
systemctl --user enable copilot-feishu-bridge   # start on login
```

Or run directly:

```sh
npm start
```

## Commands

All commands are slash commands in a Feishu DM to the bot.

| Command | Description |
|---|---|
| `/help` | Show command list |
| `/status [check-update]` | Show Copilot, session, project, and bridge state; `check-update` checks npm versions |
| `/new [-C <dir>]` | Create and bind a fresh Copilot session |
| `/session [list [--project <path>] [--all]]` | Inspect current session or browse recent sessions |
| `/resume [<id>\|-n <index>]` | Resume a session by ID or list index |
| `/stop` | Stop the active Copilot run |
| `/model [--list\|<name>\|clear]` | Show, list (with details), or change the Copilot model |
| `/system [clear\|<text>]` | Show, set, or clear the system prompt |
| `/project [list\|bind [<path>\|-n <index>\|-m]\|unbind <path>] [-h\|--help]` | Manage project bindings |
| `/git [args...]` | Run `git` in the current bound project |
| `/cat`, `/find`, `/head`, `/ls`, `/pwd`, `/rg`, `/sha256sum`, `/tail`, `/tree`, `/wc` | Run read-only commands in the project |
| `/feishu [ws\|send\|doctor]` | Feishu transport diagnostics |
| `/log [-n <N>]` | Recent bridge service logs (systemd journal) |

## Environment Variables

All variables can also be set via the JSON config file (takes precedence over defaults but not over env vars).

### Required

| Variable | Description |
|---|---|
| `FEISHU_APP_ID` | Feishu app ID |
| `FEISHU_APP_SECRET` | Feishu app secret |
| `FEISHU_BOT_OPEN_ID` | Bot's own Open ID |

### Copilot

| Variable | Default | Description |
|---|---|---|
| `COPILOT_BIN` | `/opt/node/lib/node_modules/@github/copilot/npm-loader.js` | Path to local copilot CLI entry point |
| `COPILOT_DEFAULT_MODEL` | `gpt-4o` | Default model for new conversations |
| `COPILOT_OUTPUT_SOFT_LIMIT` | `100000` | Soft character limit per response |
| `COPILOT_RUN_TIMEOUT_MS` | `600000` | Max run duration in ms (10 min) |
| `COPILOT_STATUS_INTERVAL_MS` | `60000` | Status ping interval in ms |
| `COPILOT_STREAM_UPDATE_INTERVAL_MS` | `120` | Card update interval while streaming in ms |
| `COPILOT_SESSION_LIST_DEFAULT_COUNT` | `20` | Default number of sessions shown by `/session list` |
| `COPILOT_SESSION_ALL_DEFAULT_COUNT` | `100` | Max sessions shown with `--all` |

### Project

| Variable | Default | Description |
|---|---|---|
| `PROJECT_ALLOWED_ROOTS` | *(from config)* | Comma-separated allowed root paths for project binding |
| `PROJECT_LIST_MAX_COUNT` | `100` | Max projects shown by `/project list` |

### Feishu

| Variable | Default | Description |
|---|---|---|
| `FEISHU_STARTUP_NOTIFY_CHAT_ID` | *(none)* | Chat ID to send "Bridge Ready" on startup |
| `FEISHU_WS_AUTO_RECONNECT` | `true` | Auto-reconnect websocket on disconnect |
| `FEISHU_WS_LOGGER_LEVEL` | `debug` | Feishu SDK logger level |
| `FEISHU_TITLE_MAX_LENGTH` | `120` | Max message title length |
| `FEISHU_SEND_RETRY_MAX_ATTEMPTS` | `5` | Max outbound send retries |

### Other

| Variable | Default | Description |
|---|---|---|
| `BRIDGE_CONFIG_JSON` | *(none)* | Path to the JSON config file |
| `STORE_PATH` | `.data/bindings.json` | Binding store file path |

## Architecture

```
Feishu DM ──► FeishuGateway (WebSocket)
                      │
                     App
                    /   \
          CopilotRuntime  BindingStore
                │
         AcpCopilotBackend
                │
        @github/copilot-sdk  (ACP/headless)
                │
        local copilot CLI process
```
