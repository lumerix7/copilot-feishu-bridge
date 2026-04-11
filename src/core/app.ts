import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CopilotBackend, CopilotTurnOptions, CopilotTurnResult } from "../adapters/copilot/backend.js";
import type { ModelInfo, SessionEvent, SessionMetadata } from "@github/copilot-sdk";
import { createCopilotBackend } from "../adapters/copilot/copilot-runtime.js";
import { FeishuGateway } from "../adapters/feishu/feishu-gateway.js";
import { AppConfig } from "../config/env.js";
import { conversationKeyFor } from "./conversation-key.js";
import { parseCommand } from "./command-router.js";
import { BindingStore } from "../store/binding-store.js";
import { ActiveRun, IncomingMessage, OutgoingBodyFormat, OutgoingMessage, SessionBinding } from "../types/domain.js";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 30_000;

type SessionListEntry = {
  sessionId: string;
  createdAt?: string;
  modifiedAt?: string;
  cwd?: string;
  preview?: string;
  isRemote?: boolean;
};

type ProjectListEntry = {
  project: string;
  name: string;
  bound: boolean;
  known: boolean;
  updatedAt?: string;
};

type AppResponse = {
  text: string;
  bodyFormat?: OutgoingBodyFormat;
  severity?: "warning" | "error";
};

type RecentSessionReplayMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
};

class ArgCursor {
  private readonly args: string[];

  constructor(args: string[]) {
    this.args = [...args];
  }

  peek(): string | undefined {
    return this.args[0];
  }

  shift(): string | undefined {
    return this.args.shift();
  }

  isEmpty(): boolean {
    return this.args.length === 0;
  }

  remaining(): string[] {
    return [...this.args];
  }

  remainingText(): string {
    return this.args.join(" ").trim();
  }

  takeFlag(...names: string[]): boolean {
    const index = this.args.findIndex((arg) => names.includes(arg));
    if (index < 0) return false;
    this.args.splice(index, 1);
    return true;
  }

  takeOption(...names: string[]): string | undefined {
    const index = this.args.findIndex((arg) => names.includes(arg));
    if (index < 0) return undefined;
    const value = this.args[index + 1];
    this.args.splice(index, value ? 2 : 1);
    if (!value || value.startsWith("-")) {
      return "";
    }
    return value;
  }
}

interface LogQuery {
  limit: number;
  since?: string;
  grep?: string;
}

export class App {
  private readonly store: BindingStore;
  private readonly copilot: CopilotBackend;
  private feishu?: FeishuGateway;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly conversationSystemPrompts = new Map<string, string>();
  private readonly conversationReasoningEffort = new Map<string, "low" | "medium" | "high" | "xhigh">();

  constructor(private readonly config: AppConfig) {
    this.store = new BindingStore(path.resolve(this.config.storePath));
    this.copilot = createCopilotBackend(this.config);
  }

  async start(): Promise<void> {
    console.log("copilot-feishu-bridge starting", {
      nodeEnv: this.config.nodeEnv,
      configPath: this.config.configPath,
      projectAllowedRoots: this.config.project.allowedRoots,
      defaultProject: this.config.project.defaultProject,
      copilotDefaultModel: "(from ACP)"
    });
    this.feishu = new FeishuGateway(this.config.feishu);
    await this.feishu.start(
      async (message) => {
        const parsedCommand = parseCommand(message, this.configuredLocalCommandNames());
        const command = parsedCommand && "args" in parsedCommand ? parsedCommand : undefined;
        const currentBinding = await this.store.get(conversationKeyFor(message));
        const msgKey = conversationKeyFor(message);
        const commandName = command?.name || ("name" in (parsedCommand || {}) ? parsedCommand?.name : undefined);
        const messageTitle = this.titleForCommand(commandName, message.text);
        const messageTemplate = this.templateForCommand(commandName);
        const messageFooter = this.footerForMessage(commandName, msgKey, currentBinding);
        const formatForFeishu = (text: string): string =>
          commandName ? this.stripLeadingMarkdownHeading(text) : text;
        try {
          let streamed = false;
          let lastUpdateText: string | undefined;
          let accumulatedStreamText = "";
          let statusChain = Promise.resolve();
          let streamingSendInFlight = false;
          let queuedStreamingSnapshot: string | undefined;
          let streamDrain = Promise.resolve();
          const streamKey = `${message.chatId}:${message.threadId || "root"}:${message.messageId}:${commandName || "copilot"}`;
          const sendStatusSafely = async (update: string | AppResponse): Promise<void> => {
            statusChain = statusChain.then(async () => {
              try {
                const latestBinding =
                  (await this.store.get(conversationKeyFor(message))) || currentBinding;
                const updateText = typeof update === "string" ? update : update.text;
                const updateBodyFormat = typeof update === "string" ? undefined : update.bodyFormat;
                const formattedUpdate = updateBodyFormat ? updateText : formatForFeishu(updateText);
                const copilotStatusHeading = !commandName && !updateBodyFormat
                  ? this.extractLeadingMarkdownHeading(formattedUpdate)
                  : undefined;
                const statusTitle = copilotStatusHeading
                  ? this.composeTitle("Copilot", "🤖", copilotStatusHeading.heading)
                  : messageTitle;
                const statusText = copilotStatusHeading
                  ? copilotStatusHeading.body
                  : formattedUpdate;
                console.log("Bridge status route", {
                  messageId: message.messageId,
                  chatId: message.chatId,
                  command: commandName || "copilot",
                  route: "status-card",
                  title: statusTitle,
                  textPreview: this.previewText(statusText)
                });
                await this.feishu?.send({
                  chatId: message.chatId,
                  title: statusTitle,
                  template: messageTemplate,
                  footer: commandName
                    ? this.footerForMessage(commandName, msgKey, latestBinding)
                    : this.footerForCopilotReply(msgKey, latestBinding),
                  text: statusText,
                  replyToMessageId: message.messageId,
                  threadId: message.threadId,
                  streaming: false,
                  bodyFormat: updateBodyFormat
                });
              } catch (error) {
                console.error("failed to send Feishu update", {
                  messageId: message.messageId,
                  chatId: message.chatId,
                  error
                });
              }
            });
            await statusChain;
          };
          const sendStreamSnapshot = async (snapshot: string): Promise<void> => {
            try {
              const latestBinding =
                (await this.store.get(conversationKeyFor(message))) || currentBinding;
              console.log("Bridge content route", {
                messageId: message.messageId,
                chatId: message.chatId,
                streamKey,
                route: "stream-card",
                final: false,
                textPreview: this.previewText(snapshot)
              });
              await this.feishu?.send({
                chatId: message.chatId,
                title: messageTitle,
                template: messageTemplate,
                footer: this.footerForCopilotReply(msgKey, latestBinding),
                text: snapshot,
                replyToMessageId: message.messageId,
                threadId: message.threadId,
                streaming: true,
                streamKey,
                suppressChunkFooter: true,
                preserveStreamingPages: true
              });
              streamed = true;
              lastUpdateText = snapshot;
              accumulatedStreamText = snapshot;
            } catch (error) {
              console.error("failed to send Feishu streaming update", {
                messageId: message.messageId,
                chatId: message.chatId,
                error
              });
            }
          };
          const sendUpdateSafely = async (update: string): Promise<void> => {
            if (commandName) {
              await sendStatusSafely(update);
              return;
            }
            const formattedUpdate = formatForFeishu(update);
            queuedStreamingSnapshot = formattedUpdate;
            if (streamingSendInFlight) {
              await streamDrain;
              return;
            }
            streamingSendInFlight = true;
            streamDrain = (async () => {
              while (queuedStreamingSnapshot !== undefined) {
                const snapshot = queuedStreamingSnapshot;
                queuedStreamingSnapshot = undefined;
                await sendStreamSnapshot(snapshot);
              }
              streamingSendInFlight = false;
            })();
            await streamDrain;
          };

          const result = await this.handleIncoming(message, sendUpdateSafely, sendStatusSafely);
          const text = typeof result === "string" ? result : result.text;
          const responseBodyFormat = typeof result === "string" ? undefined : result.bodyFormat;
          const responseSeverity = typeof result === "string" ? undefined : result.severity;
          await statusChain;
          await streamDrain;
          const formattedText = commandName
            ? formatForFeishu(text)
            : accumulatedStreamText || formatForFeishu(text);
          const shouldFinalizeLiveStream = !commandName && streamed;
          if ((formattedText && formattedText !== lastUpdateText) || !streamed || shouldFinalizeLiveStream) {
            const latestBinding =
              (await this.store.get(conversationKeyFor(message))) || currentBinding;
            const finalFooter = commandName
              ? this.footerForMessage(commandName, msgKey, latestBinding)
              : this.footerForCopilotReply(msgKey, latestBinding);
            const finalTemplate =
              commandName
                ? this.templateForSeverity(messageTemplate, responseSeverity)
                : messageTemplate;
            console.log("Bridge final outbound route", {
              messageId: message.messageId,
              chatId: message.chatId,
              command: commandName || "copilot",
              streamed,
              shouldFinalizeLiveStream,
              route: commandName ? "status-card" : "stream-card-finalize",
              textPreview: this.previewText(formattedText)
            });
            await this.feishu?.send({
              chatId: message.chatId,
              title: messageTitle,
              template: finalTemplate,
              footer: finalFooter,
              text: formattedText,
              replyToMessageId: message.messageId,
              threadId: message.threadId,
              streaming: true,
              bodyFormat: responseBodyFormat,
              ...(commandName ? {} : { streamKey, finalizeStreaming: true, suppressChunkFooter: true, preserveStreamingPages: true })
            });
          }
          console.log("bridge handled message", {
            messageId: message.messageId,
            chatId: message.chatId,
            streamed,
            finalPreview: this.previewText(text)
          });
        } catch (error) {
          const text = error instanceof Error ? error.message : "Unknown bridge error.";
          try {
            await this.feishu?.send({
              chatId: message.chatId,
              title: messageTitle || "Bridge Error",
              template: "red",
              footer: this.buildFooter(msgKey, currentBinding),
              text: `bridge error: ${text}`,
              replyToMessageId: message.messageId,
              threadId: message.threadId
            });
          } catch (sendError) {
            console.error("failed to send bridge error to Feishu", sendError);
          }
        }
      },
      async () => {
        await this.sendStartupReadyNotification("Reconnected", "Feishu reconnect ready notification sent");
      }
    );
    await this.sendStartupReadyNotification("Bridge Ready", "Feishu startup ready notification sent");
  }

  async handleIncoming(
    message: IncomingMessage,
    onUpdate?: (update: string) => Promise<void>,
    onStatus?: (text: string | AppResponse) => Promise<void>
  ): Promise<string | AppResponse> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const parsedCommand = parseCommand(message, this.configuredLocalCommandNames());
    if (parsedCommand && "parseError" in parsedCommand) {
      const title = parsedCommand.name ? this.commandBaseTitle(parsedCommand.name) : "Command";
      return this.renderCommandError(
        title,
        parsedCommand.parseError,
        "close the quoted argument and try again"
      );
    }
    const command = parsedCommand;
    if (command?.name === "help") {
      const helpArgs = new ArgCursor(command.args);
      helpArgs.takeFlag("-h", "--help");
      const rawMarkdownOnly = helpArgs.takeFlag("--raw-markdown");
      if (!helpArgs.isEmpty()) {
        return this.renderCommandError(
          "Help",
          `unsupported help argument \`${helpArgs.peek()}\``,
          "`/help [--raw-markdown]`"
        );
      }
      return this.withBodyFormat([
        "# Bridge Help",
        "",
        "## Core",
        "",
        "- `/help [--raw-markdown]` show commands",
        "- `/status [check-update] [-h|--help]` show current session and run state; `check-update` checks npm versions",
        "- `/new [-C <dir>] [-h|--help]` create and bind a fresh Copilot session",
        "- `/session [<session-id>|list [options]] [-h|--help]` show the current session, inspect a specific session, or browse recent sessions",
        "- `/resume [<session-id>|-|--last|-n <index>|list] [-h|--help]` resume a session",
        "- `/compact` compact the current bound Copilot session",
        "- `/stop` stop the current active run",
        "",
        "## Copilot",
        "",
        "- `/model [list [--no-hidden] | <name>] [--reasoning <level>] [-h|--help]` show, list, or change the Copilot model and reasoning effort for the current session",
        "- `/system [clear|<text>]` show, set, or clear the system prompt for this conversation",
        "",
        "## Project",
        "",
        "- `/project [list|bind [<path>|-n <index>|-m]|unbind <path>] [-h|--help]` show the current project or manage project bindings",
        "- `/git [args...]` run `git` directly in the current bound project",
        `- ${this.localProjectCommandHelpText()} run local project commands`,
        "",
        "## Diagnostics",
        "",
        "- `/feishu [ws|send|doctor]` show Feishu websocket and outbound send diagnostics",
        "- `/log [-n <count>]` show recent bridge service logs from systemd journal",
        ...this.configuredLocalCommandNames().length > 0 ? [
          "",
          "## Mapped",
          "",
          ...Object.entries(this.config.commands.map).map(([alias, bin]) =>
            `- \`/${alias}\` run \`${bin || alias}\``
          )
        ] : [],
        "",
        "## Notes",
        "",
        "- Add `--raw-markdown` to `/help` or `/session` to return fenced source markdown instead of rendered markdown."
      ].join("\n"), rawMarkdownOnly ? "raw-markdown" : undefined);
    }

    const key = conversationKeyFor(message);
    const existing = await this.store.get(key);
    const activeRun = this.activeRuns.get(key);
    let sentEarlyUpdate = false;
    const sendEarlyUpdate = async (text: string): Promise<void> => {
      const target = onStatus || onUpdate;
      if (!target || sentEarlyUpdate) return;
      sentEarlyUpdate = true;
      await target(text);
    };

    if (command?.name === "status") {
      const statusArgs = new ArgCursor(command.args);
      if (statusArgs.peek() === "-h" || statusArgs.peek() === "--help") {
        return this.statusHelpText();
      }
      const checkUpdates = statusArgs.peek() === "check-update" || statusArgs.peek() === "--check-update"
        ? (statusArgs.shift(), true) : false;
      if (!statusArgs.isEmpty()) {
        return this.renderCommandError(
          "Status",
          `unsupported status argument \`${statusArgs.peek()}\``,
          "`/status [check-update] [-h|--help]`"
        );
      }
      if (checkUpdates) {
        await sendEarlyUpdate("Checking npm registry for Copilot, Copilot SDK, and Feishu updates...");
        const copilotInfo = await this.copilot.getCopilotInfo().catch(() => undefined);
        const [sdkInstalled, sdkDeclared, feishuInstalled, feishuDeclared,
               latestCopilot, latestSdk, latestFeishu] = await Promise.all([
          this.readInstalledPackageVersion("@github/copilot-sdk"),
          this.readDeclaredPackageRange("@github/copilot-sdk"),
          this.readInstalledPackageVersion("@larksuiteoapi/node-sdk"),
          this.readDeclaredPackageRange("@larksuiteoapi/node-sdk"),
          this.readLatestNpmPackageVersion("@github/copilot"),
          this.readLatestNpmPackageVersion("@github/copilot-sdk"),
          this.readLatestNpmPackageVersion("@larksuiteoapi/node-sdk"),
        ]);
        const copilotCurrent = copilotInfo?.status.version;
        return [
          "# Bridge Status",
          "",
          "## Copilot",
          "",
          `- **Status**: ${this.formatUpdateStatusBadge(this.describeUpdateStatus(copilotCurrent, latestCopilot))}`,
          `- **Package**: \`@github/copilot\``,
          `- **Current**: \`${copilotCurrent || "(unknown)"}\``,
          `- **Latest**: \`${latestCopilot || "(unavailable)"}\``,
          `- **Note**: Current version comes from the local Copilot CLI reported by the SDK at runtime.`,
          "",
          "## Copilot SDK",
          "",
          `- **Status**: ${this.formatUpdateStatusBadge(this.describeUpdateStatus(sdkInstalled, latestSdk))}`,
          `- **Package**: \`@github/copilot-sdk\``,
          ...(sdkDeclared ? [`- **Declared**: \`${sdkDeclared}\``] : []),
          `- **Installed**: \`${sdkInstalled || "(unknown)"}\``,
          `- **Latest**: \`${latestSdk || "(unavailable)"}\``,
          `- **Note**: The bridge uses this SDK to communicate with the local Copilot CLI over headless JSON-RPC.`,
          "",
          "## Feishu",
          "",
          `- **Status**: ${this.formatUpdateStatusBadge(this.describeUpdateStatus(feishuInstalled, latestFeishu))}`,
          `- **Package**: \`@larksuiteoapi/node-sdk\``,
          ...(feishuDeclared ? [`- **Declared**: \`${feishuDeclared}\``] : []),
          `- **Installed**: \`${feishuInstalled || "(unknown)"}\``,
          `- **Latest**: \`${latestFeishu || "(unavailable)"}\``,
          `- **Note**: Node SDK used by the bridge for Feishu websocket and HTTPS APIs.`
        ].join("\n");
      }
      await sendEarlyUpdate("Collecting Copilot, bridge, and Feishu status...");
      const project = existing?.project || this.config.project.defaultProject;
      const feishuSdkVersion = await this.readInstalledPackageVersion("@larksuiteoapi/node-sdk");
      const sessionId = existing?.copilotSessionId || "(none)";
      const [allSessions, copilotInfo] = await Promise.all([
        existing?.copilotSessionId ? this.copilot.listSessions().catch(() => []) : Promise.resolve([]),
        this.copilot.getCopilotInfo().catch(() => undefined),
      ]);
      const sessionMeta = existing?.copilotSessionId
        ? allSessions.find((s) => s.sessionId === existing.copilotSessionId)
        : undefined;
      let lastUserMessage: string | undefined = sessionMeta?.summary;
      if (existing?.copilotSessionId) {
        try {
          const messages = await this.copilot.getSessionMessages(existing.copilotSessionId);
          for (let i = messages.length - 1; i >= 0; i--) {
            const ev = messages[i];
            if (ev.type === "user.message" && ev.data.content?.trim()) {
              lastUserMessage = ev.data.content.trim();
              break;
            }
          }
        } catch {
          // keep summary fallback
        }
      }
      const feishuDiagnostics = this.feishu?.diagnostics();
      const systemPrompt = this.conversationSystemPrompts.get(key);
      return [
        "# Bridge Status",
        "",
        "## Copilot",
        "",
        `- **Copilot**: \`${copilotInfo?.status.version ?? "(unknown)"}\``,
        `- **Auth**: \`${copilotInfo?.auth.authType ?? "?"}\` (${copilotInfo?.auth.login ?? "unknown"})`,
        `- **Model**: \`${(sessionId ? this.copilot.getSessionModelInfo(sessionId)?.model : undefined) ?? "(from ACP)"}\``,
        `- **Directory**: \`${project}\``,
        `- **Session**: \`${sessionId}\``,
        `- **Session time**: ${this.formatAnyTimestamp(sessionMeta?.startTime?.toISOString())}`,
        ...(sessionMeta?.context?.cwd ? [`- **Session cwd**: \`${sessionMeta.context.cwd}\``] : []),
        ...(lastUserMessage ? [`- **Session last message**: ${this.previewText(lastUserMessage)}`] : []),
        ...(systemPrompt ? [`- **System prompt**: ${this.previewText(systemPrompt)}`] : []),
        "",
        "## Bridge",
        "",
        `- **Conversation**: \`${key}\``,
        `- **Backend**: \`acp\``,
        `- **Run**: \`${activeRun ? `${activeRun.status}:${activeRun.runId}` : "idle"}\``,
        "",
        "## Feishu",
        "",
        `- **SDK**: \`${feishuSdkVersion || "(unknown)"}\``,
        ...(feishuDiagnostics ? [`- **Status**: ${this.formatFeishuDoctorVerdict(feishuDiagnostics)}`] : []),
        ...(feishuDiagnostics ? [`- **Ws**: ${this.formatFeishuWsSummary(feishuDiagnostics)}`] : []),
        ...(feishuDiagnostics ? [`- **Send**: ${this.formatFeishuSendSummary(feishuDiagnostics)}`] : [])
      ].join("\n");
    }

    if (command?.name === "system") {
      const systemArgs = new ArgCursor(command.args);
      if (systemArgs.isEmpty()) {
        const current = this.conversationSystemPrompts.get(key);
        if (!current) return "# System Prompt\n\n- **Status**: `(not set)`";
        return [
          "# System Prompt",
          "",
          "```text",
          current,
          "```"
        ].join("\n");
      }
      if (systemArgs.peek() === "clear") {
        this.conversationSystemPrompts.delete(key);
        return "# System Prompt\n\n- **Status**: `cleared`";
      }
      const text = systemArgs.remainingText();
      this.conversationSystemPrompts.set(key, text);
      return [
        "# System Prompt",
        "",
        "- **Status**: `set`",
        "",
        "```text",
        text,
        "```"
      ].join("\n");
    }

    if (command?.name === "feishu") {
      const feishuArgs = new ArgCursor(command.args);
      const feishuMode = feishuArgs.shift();
      if (feishuMode === "-h" || feishuMode === "--help") {
        return this.feishuHelpText();
      }
      const diagnostics = this.feishu?.diagnostics();
      if (!diagnostics) {
        return "# Feishu\n\n- **Status**: `(gateway unavailable)`";
      }
      if (!feishuMode) {
        return this.renderFeishuSummary(diagnostics);
      }
      if (feishuMode === "ws") {
        return this.renderFeishuWs(diagnostics);
      }
      if (feishuMode === "send") {
        return this.renderFeishuSend(diagnostics);
      }
      if (feishuMode === "doctor") {
        return this.renderFeishuDoctor(diagnostics);
      }
      return this.renderCommandError(
        "Feishu",
        `unknown subcommand \`${feishuMode}\``,
        "`/feishu [ws|send|doctor] [-h|--help]`",
        ["- **Choices**: `ws`, `send`, `doctor`"]
      );
    }

    if (command?.name === "resume") {
      if (activeRun) {
        return `Cannot resume while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const resumeArgs = new ArgCursor(command.args);
      if (resumeArgs.takeFlag("-h", "--help")) {
        return this.resumeHelpText();
      }
      const currentProject = existing?.project || this.config.project.defaultProject;
      const cdArg = resumeArgs.takeOption("-C", "--cd");
      if (cdArg === "") {
        return this.renderCommandError(
          "Resume",
          "missing value for `-C|--cd <dir>`",
          "`/resume [<session-id>|-|--last|-n <index>] [--messages <count>] [-C|--cd <dir>]`"
        );
      }
      const messagesArg = resumeArgs.takeOption("--messages");
      if (messagesArg === "") {
        return this.renderCommandError(
          "Resume",
          "missing value for `--messages <count>`",
          "`/resume [<session-id>|-|--last|-n <index>] [--messages <count>] [-C|--cd <dir>]`"
        );
      }
      let replayMessages = this.config.copilot.resumeDefaultMessages;
      if (messagesArg !== undefined) {
        const parsed = Number.parseInt(messagesArg, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          return this.renderCommandError(
            "Resume",
            "invalid `--messages <count>` value",
            "`/resume [<session-id>|-|--last|-n <index>] [--messages <count>]`"
          );
        }
        replayMessages = parsed;
      }

      const wantsList = resumeArgs.peek() === "list";
      const allProjects = resumeArgs.takeFlag("--all");
      const projectScopeArg = resumeArgs.takeOption("--project");
      if (projectScopeArg === "") {
        return this.renderCommandError(
          "Resume",
          "missing value for `--project <path>`",
          "`/resume list [--all] [--project <path>]`"
        );
      }
      if (projectScopeArg && !wantsList) {
        return this.renderCommandError(
          "Resume",
          "use `--project <path>` with `/resume list`, or use `-C|--cd <dir>` to switch project while resuming",
          "`/resume list [--project <path>]`"
        );
      }
      if (allProjects && !wantsList) {
        return this.renderCommandError(
          "Resume",
          "use `--all` with `/resume list` to browse across projects, then resume by session id",
          "`/resume list --all`"
        );
      }
      const scopedProject = projectScopeArg
        ? await this.resolveProject(projectScopeArg, currentProject)
        : currentProject;
      const listProject = allProjects ? undefined : scopedProject;

      if (wantsList) {
        resumeArgs.shift();
      }

      if (wantsList) {
        const sessions = await this.listSessionsForDisplay(this.config.copilot.sessionListMaxCount, listProject);
        if (sessions.length === 0) {
          return this.noSessionsText(scopedProject);
        }
        return this.renderSessionList("Resume Sessions", sessions, existing?.copilotSessionId);
      }

      let targetSessionId: string | undefined;
      let resumeSource = "last";
      let resumeIndex: number | undefined;

      let wantsLast = false;
      if (resumeArgs.peek() === "--last") {
        resumeArgs.shift();
        wantsLast = true;
      }
      if (resumeArgs.peek() === "-") {
        resumeArgs.shift();
        wantsLast = true;
      }
      if ((resumeArgs.peek() || "").startsWith("-") && resumeArgs.peek() !== "-n") {
        return this.renderCommandError(
          "Resume",
          `unsupported bridge option \`${resumeArgs.peek()}\``,
          "`/resume [<session-id>|-|--last|-n <index>|list]`"
        );
      }
      if (resumeArgs.isEmpty() && !wantsLast) {
        return this.renderCommandError(
          "Resume",
          "pick a session explicitly, or use `-` to resume the most recent session",
          "`/resume [<session-id>|-|--last|-n <index>|list|-h]`"
        );
      }

      if (wantsLast) {
        const sessions = await this.listSessionsForDisplay(1, listProject);
        targetSessionId = sessions[0]?.sessionId;
        resumeSource = "last";
      } else if (resumeArgs.peek() === "-n") {
        resumeArgs.shift();
        const rawIndex = resumeArgs.shift();
        if (!resumeArgs.isEmpty()) {
          return this.renderCommandError(
            "Resume",
            `unsupported resume argument \`${resumeArgs.peek()}\``,
            "`/resume -n <index>`"
          );
        }
        const index = Number(rawIndex || "");
        if (!Number.isInteger(index) || index < 1) {
          return this.renderCommandError("Resume", "invalid resume index", "`/resume -n <index>`");
        }
        const sessions = await this.listSessionsForDisplay(
          Math.min(index, this.config.copilot.sessionListMaxCount),
          listProject
        );
        const selected = sessions[index - 1];
        if (!selected) {
          return this.renderCommandError("Resume", `session index out of range: ${index}`, "`/session list`");
        }
        targetSessionId = selected.sessionId;
        resumeSource = "indexed";
        resumeIndex = index;
      } else if (resumeArgs.peek() && !resumeArgs.peek()?.startsWith("-")) {
        targetSessionId = resumeArgs.shift();
        resumeSource = "explicit";
      } else {
        return this.renderCommandError(
          "Resume",
          `unsupported resume argument \`${resumeArgs.peek()}\``,
          "`/resume [<session-id>|-|--last|-n <index>|list]`"
        );
      }

      if (!targetSessionId) {
        return this.noSessionsText(scopedProject);
      }
      await sendEarlyUpdate(`Resolving session \`${targetSessionId}\`...`);
      const resolvedSessionId = await this.copilot.getSession(targetSessionId);
      if (!resolvedSessionId) {
        return this.renderCommandError("Resume", `Session not found: \`${targetSessionId}\``);
      }
      targetSessionId = resolvedSessionId;
      const sessionMeta = (await this.copilot.listSessions()).find((s) => s.sessionId === targetSessionId);

      // -C/--cd: only apply if it matches the session's own project
      let resolvedProject = sessionMeta?.context?.cwd || currentProject;
      if (cdArg) {
        try {
          const requestedProject = await this.resolveProject(cdArg, currentProject);
          if (requestedProject === resolvedProject) {
            resolvedProject = requestedProject;
          }
        } catch {
          // ignore invalid -C
        }
      }

      const binding = this.makeBinding(key, targetSessionId, resolvedProject, existing);
      await this.store.put(binding);

      // Probe model info in background so /status shows the real model before the first turn
      void this.copilot.probeSessionModelInfo(targetSessionId, resolvedProject).catch(() => {});

      const sections = this.renderSessionDetailText({
        title: "Resume Session",
        sessionId: targetSessionId,
        project: binding.project,
        sessionMeta,
        flags: ["current", "bound"],
        leadingLines: [
          `- **Source**: \`${resumeSource}\``,
          ...(resumeIndex ? [`- **Index**: \`${resumeIndex}\``] : [])
        ]
      });
      if (replayMessages > 0 && onStatus) {
        const recentMessages = await this.renderRecentSessionReplayMessages(targetSessionId, replayMessages);
        for (const recentMessage of recentMessages) {
          await onStatus(recentMessage);
        }
      }
      return sections;
    }

    if (command?.name === "session") {
      const sessionArgs = new ArgCursor(command.args);
      const rawMarkdownOnly = sessionArgs.takeFlag("--raw-markdown");
      const sessionBodyFormat: OutgoingBodyFormat | undefined = rawMarkdownOnly ? "raw-markdown" : undefined;
      if (sessionArgs.takeFlag("-h", "--help")) {
        return this.withBodyFormat(this.sessionsHelpText(), sessionBodyFormat);
      }
      const currentProject = existing?.project || this.config.project.defaultProject;

      if (sessionArgs.peek() === "list") {
        sessionArgs.shift();
        const projectScopeArg = sessionArgs.takeOption("--project");
        if (projectScopeArg === "") {
          return this.withBodyFormat(
            this.renderCommandError("Session", "missing value for `--project <path>`", "`/session list [-n <count>] [--all] [--project <path>] [--raw-markdown]`"),
            sessionBodyFormat
          );
        }
        const allProjects = sessionArgs.takeFlag("--all");
        const countArg = sessionArgs.takeOption("-n");
        const scopedProject = projectScopeArg
          ? await this.resolveProject(projectScopeArg, currentProject)
          : currentProject;
        let limit: number;
        if (countArg !== undefined) {
          const parsed = parseInt(countArg, 10);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1000) {
            return this.withBodyFormat(
              this.renderCommandError("Session", "`-n` must be a number between 1 and 1000", "`/session list [-n <count>] [--all] [--project <path>] [--raw-markdown]`"),
              sessionBodyFormat
            );
          }
          limit = parsed;
        } else {
          limit = allProjects
            ? this.config.copilot.sessionListMaxCount
            : this.config.copilot.sessionListDefaultCount;
        }
        const leftoverListArgs = sessionArgs.remaining();
        if (leftoverListArgs.length > 0) {
          return this.withBodyFormat(leftoverListArgs[0].startsWith("/")
            ? this.renderCommandError(
                "Session",
                "use `--project <path>` to filter sessions by project path",
                "`/session list --project <path> [-n <count>] [--all]`"
              )
            : this.renderCommandError(
                "Session",
                `unsupported session list argument \`${leftoverListArgs[0]}\``,
                "`/session list [-n <count>] [--all] [--project <path>]`"
              ), sessionBodyFormat);
        }
        const sessions = await this.listSessionsForDisplay(limit, allProjects ? undefined : scopedProject);
        if (sessions.length === 0) {
          return this.withBodyFormat(this.noSessionsText(scopedProject), sessionBodyFormat);
        }
        return this.withBodyFormat(this.renderSessionList("Sessions", sessions, existing?.copilotSessionId), sessionBodyFormat);
      }

      if ((sessionArgs.peek() || "").startsWith("-")) {
        return this.withBodyFormat(this.renderCommandError(
          "Session",
          `unsupported bridge option \`${sessionArgs.peek()}\``,
          "`/session [<session-id>|list [options]|-h]`"
        ), sessionBodyFormat);
      }

      if (!sessionArgs.isEmpty()) {
        const targetSessionId = sessionArgs.shift();
        if (!targetSessionId) {
          return this.withBodyFormat(this.renderCommandError(
            "Session",
            "missing session id",
            "`/session [<session-id>|list [options]|-h]`"
          ), sessionBodyFormat);
        }
        if (!sessionArgs.isEmpty()) {
          return this.withBodyFormat(this.renderCommandError(
            "Session",
            `unsupported session argument \`${sessionArgs.peek()}\``,
            "`/session <session-id> [--raw-markdown]`"
          ), sessionBodyFormat);
        }
        const sessionMeta = (await this.copilot.listSessions()).find((s) => s.sessionId === targetSessionId);
        if (!sessionMeta) {
          const sessionExists = await this.copilot.getSession(targetSessionId).catch(() => undefined);
          if (!sessionExists) {
            return this.withBodyFormat(this.renderCommandError(
              "Session",
              `Session not found: ${targetSessionId}`
            ), sessionBodyFormat);
          }
        }
        const resolvedProject =
          sessionMeta?.context?.cwd
            ? await this.resolveProject(sessionMeta.context.cwd, currentProject)
            : currentProject;
        const modelInfo = this.copilot.getSessionModelInfo(targetSessionId);
        return this.withBodyFormat(this.renderSessionDetailText({
          title: "Session",
          sessionId: targetSessionId,
          project: resolvedProject,
          sessionMeta,
          modelInfo,
          flags: existing?.copilotSessionId === targetSessionId ? ["current", "bound"] : []
        }), sessionBodyFormat);
      }

      if (!existing?.copilotSessionId) {
        return this.withBodyFormat("No session is currently bound. Use `/new`, `/resume`, or `/session list`.", sessionBodyFormat);
      }
      const sessionMeta = (await this.copilot.listSessions()).find((s) => s.sessionId === existing.copilotSessionId);
      const sessionInfo = existing.copilotSessionId ? this.copilot.getSessionModelInfo(existing.copilotSessionId) : undefined;
      const project = existing.project || this.config.project.defaultProject;
      return this.withBodyFormat(this.renderSessionDetailText({
        title: "Current Session",
        sessionId: existing.copilotSessionId,
        project,
        sessionMeta,
        modelInfo: sessionInfo,
        flags: ["current", "bound"]
      }), sessionBodyFormat);
    }

    if (command?.name === "new") {
      const newArgs = new ArgCursor(command.args);
      if (newArgs.peek() === "-h" || newArgs.peek() === "--help") {
        return this.newHelpText();
      }
      if (activeRun) {
        return `Cannot create a new session while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      let project = existing?.project || this.config.project.defaultProject;
      const newProjectArg = newArgs.takeOption("-C", "--cd");
      if (newProjectArg === "") {
        return "Usage: `/new [-C|--cd <dir>]`";
      }
      if (newProjectArg) {
        project = await this.resolveProject(newProjectArg, project);
      }
      if (!newArgs.isEmpty()) {
        return "Usage: `/new [-C|--cd <dir>]`";
      }
      await sendEarlyUpdate(`Creating a new Copilot session for project \`${project}\`...`);
      const sessionId = await this.copilot.createSession(project, {
        reasoningEffort: this.conversationReasoningEffort.get(key)
      });
      const nextBinding = this.makeBinding(key, sessionId, project, existing);
      await this.store.put(nextBinding);
      return [
        "# New Session",
        "",
        `- **Session**: \`${sessionId}\``,
        `- **Project**: \`${nextBinding.project}\``
      ].join("\n");
    }

    if (command?.name === "stop") {
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.stopHelpText();
      }
      if (!activeRun) {
        return "No active run for this conversation.";
      }
      await sendEarlyUpdate(`Stopping run \`${activeRun.runId}\`...`);
      this.activeRuns.set(key, { ...activeRun, status: "stopping" });
      const stopped = await this.copilot.stop(activeRun.runId);
      return stopped
        ? `# Stop Run\n\n- **Run**: \`${activeRun.runId}\`\n- **Status**: \`stop requested\``
        : "Run already finished before stop completed.";
    }

    if (command?.name === "compact") {
      if (command.args[0] === "-h" || command.args[0] === "--help") {
        return this.compactHelpText();
      }
      if (command.args.length > 0) {
        return this.renderCommandError("Compact", `Unknown argument: \`${command.args[0]}\``, "`/compact [-h|--help]`");
      }
      const sessionId = existing?.copilotSessionId;
      const project = existing?.project || this.config.project.defaultProject;
      if (!sessionId) {
        return "No session is currently bound. Use `/new` or `/resume` first.";
      }
      if (activeRun) {
        return `Cannot compact while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      await sendEarlyUpdate(`Compacting session \`${sessionId}\`...`);
      try {
        const result = await this.copilot.compact(sessionId, project);
        return [
          "# Compact",
          "",
          `- **Session**: \`${sessionId}\``,
          `- **Success**: \`${result.success}\``,
          `- **Tokens removed**: \`${result.tokensRemoved}\``,
          `- **Messages removed**: \`${result.messagesRemoved}\``,
        ].join("\n");
      } catch (err) {
        return this.renderCommandError("Compact", err instanceof Error ? err.message : String(err), "`/compact`");
      }
    }

    if (command?.name === "model") {
      const EFFORT_VALUES = ["low", "medium", "high", "xhigh"] as const;
      type EffortLevel = typeof EFFORT_VALUES[number];
      const isEffort = (v: string): v is EffortLevel => EFFORT_VALUES.includes(v as EffortLevel);

      const modelArgs = new ArgCursor(command.args);
      if (modelArgs.peek() === "-h" || modelArgs.peek() === "--help") {
        return this.modelHelpText();
      }

      const noHidden = modelArgs.takeFlag("--no-hidden");
      if (modelArgs.peek() === "list") {
        modelArgs.shift();
        await sendEarlyUpdate("Fetching Copilot model list...");
        const models = await this.copilot.listModels().catch(() => []);
        const filtered = noHidden
          ? models.filter(m => m.policy?.state === "enabled")
          : models;
        return this.modelListText(filtered);
      }

      const reasoningArg = modelArgs.takeOption("--reasoning");
      const sessionId = existing?.copilotSessionId;
      const project = existing?.project || this.config.project.defaultProject;
      const sessionInfo = sessionId ? this.copilot.getSessionModelInfo(sessionId) : undefined;
      const currentModel = sessionInfo?.model ?? "(from ACP)";
      const currentEffort = sessionInfo?.reasoningEffort || (reasoningArg === undefined ? this.conversationReasoningEffort.get(key) : undefined);

      if (modelArgs.isEmpty() && reasoningArg === undefined) {
        const effortLine = currentEffort ? `\n- **Effort**: \`${currentEffort}\`` : "";
        return `# 🧠 Model\n\n- **Model**: \`${currentModel}\`${effortLine}`;
      }
      if (activeRun) {
        return `Cannot change model while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }

      if (reasoningArg !== undefined) {
        if (!isEffort(reasoningArg)) {
          return `Invalid effort level \`${reasoningArg}\`. Valid: ${EFFORT_VALUES.join(", ")}.`;
        }
        this.conversationReasoningEffort.set(key, reasoningArg);
      }

      const nextEffort: EffortLevel | undefined = reasoningArg !== undefined && isEffort(reasoningArg)
        ? reasoningArg
        : (this.conversationReasoningEffort.get(key) as EffortLevel | undefined);

      if (!modelArgs.isEmpty()) {
        const nextModel = modelArgs.remainingText();
        if (sessionId) {
          await sendEarlyUpdate(`Switching model to \`${nextModel}\`${nextEffort ? ` (effort: ${nextEffort})` : ""}...`);
          await this.copilot.setSessionModel(sessionId, nextModel, nextEffort, project);
          const effortLine = nextEffort ? `\n- **Effort**: \`${nextEffort}\`` : "";
          return `# 🧠 Model\n\n- **Model**: \`${nextModel}\`${effortLine}`;
        }
        return `No active session — start a conversation first to change the model.`;
      }

      const effortLine = nextEffort ? `\n- **Effort**: \`${nextEffort}\`` : "";
      return `# 🧠 Model\n\n- **Model**: \`${currentModel}\`${effortLine}`;
    }

    if (command?.name === "project") {
      const projectArgs = new ArgCursor(command.args);
      const currentProject = existing?.project || this.config.project.defaultProject;
      if (projectArgs.peek() === "-h" || projectArgs.peek() === "--help") {
        return this.projectHelpText();
      }
      if (projectArgs.isEmpty()) {
        return [
          "# Project",
          "",
          `- **Project**: \`${currentProject}\``,
          `- **Allowed roots**: ${this.config.project.allowedRoots.map((root) => `\`${root}\``).join(", ")}`
        ].join("\n");
      }
      const projectSubcommand = projectArgs.shift();

      if (projectSubcommand === "list") {
        if (!projectArgs.isEmpty()) {
          return this.renderCommandError("Project", `unsupported project list argument \`${projectArgs.peek()}\``, "`/project list`");
        }
        const projects = await this.listProjects(currentProject);
        if (projects.length === 0) return "# Projects\n\n- No projects found.";
        return this.renderProjectList("Projects", projects, currentProject);
      }

      if (projectSubcommand === "unbind") {
        if (activeRun) {
          return `Cannot change project while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
        }
        const requested = projectArgs.remainingText();
        if (!requested) {
          return this.renderCommandError("Project", "missing project path for `unbind`", "`/project unbind <path>`");
        }
        const project = await this.resolveProject(requested, currentProject, false, false);
        if (project === currentProject) {
          return [
            "# Project",
            "",
            `- **Error**: refusing to unbind the current conversation project \`${project}\``,
            "- Bind this conversation to another project first."
          ].join("\n");
        }
        await sendEarlyUpdate(`Removing stored bindings for project \`${project}\`...`);
        const removed = await this.store.deleteProject(project);
        return [
          "# Project",
          "",
          `- **Project**: \`${project}\``,
          `- **Removed bindings**: \`${removed}\``
        ].join("\n");
      }

      if (projectSubcommand !== "bind") {
        return this.renderCommandError(
          "Project",
          `unsupported project subcommand \`${projectSubcommand}\``,
          "`/project [list|bind [options]|unbind <path>] [-h|--help]`"
        );
      }
      if (activeRun) {
        return `Cannot change project while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }

      const bindArgs = new ArgCursor(projectArgs.remaining());
      const createMissing = bindArgs.takeFlag("-m", "--mkdir");

      let project: string | undefined;
      let bindWarning: string | undefined;
      if (bindArgs.peek() === "-n") {
        bindArgs.shift();
        const rawIndex = bindArgs.shift();
        const index = Number(rawIndex || "");
        if (!Number.isInteger(index) || index < 1) {
          return "Usage: `/project bind -n <index>` where `<index>` is an integer >= 1.";
        }
        const projects = await this.listProjects(currentProject);
        const selected = projects[index - 1];
        if (!selected) {
          return `project index out of range: ${index}. Use \`/project list\` first.`;
        }
        project = selected.project;
        bindWarning = "Index-based bind uses the current `/project list` ordering and may change.";
      } else {
        const requested = bindArgs.remainingText();
        if (!requested) {
          return this.renderCommandError("Project", "missing project path for `bind`", "`/project bind <path>`");
        }
        project = await this.resolveProject(requested, currentProject, createMissing);
      }

      const nextBinding = existing
        ? { ...existing, project, updatedAt: new Date().toISOString() }
        : this.makeBinding(key, undefined, project);
      await sendEarlyUpdate(`Binding project \`${project}\`...`);
      await this.store.put(nextBinding);
      return [
        "# Project",
        "",
        `- **Project**: \`${project}\``,
        ...(bindWarning ? [`- **Warning**: ${bindWarning}`] : [])
      ].join("\n");
    }

    if (command?.name === "log") {
      const logArgs = new ArgCursor(command.args);
      if (logArgs.peek() === "-h" || logArgs.peek() === "--help") {
        return this.logHelpText();
      }
      const query = this.parseLogQuery(logArgs.remaining());
      if (query instanceof Error) {
        return this.renderCommandError("Log", query.message, "`/log [-n <count>] [-h|--help]`");
      }
      await sendEarlyUpdate(`Reading last ${query.limit} lines for \`copilot-feishu-bridge.service\`...`);
      return this.readBridgeLogs(query);
    }

    if (command?.name === "git") {
      const project = existing?.project || this.config.project.defaultProject;
      const commandText = ["git", ...command.args].join(" ");
      await sendEarlyUpdate(this.commandMetaCard("Git", project, commandText));
      return this.runGitCommand(project, command.args);
    }

    const resolvedLocalBin = command ? this.resolveLocalProjectCommand(command.name) : undefined;
    if (command && resolvedLocalBin) {
      const displayName = command.name;
      const project = existing?.project || this.config.project.defaultProject;
      const commandText = [displayName, ...command.args].join(" ");
      await sendEarlyUpdate(this.commandMetaCard(displayName, project, commandText));
      return this.runLocalCommand(resolvedLocalBin, project, command.args, displayName);
    }

    if (activeRun) {
      return [
        "# Active Run",
        "",
        `- **Run**: \`${activeRun.runId}\``,
        `- **Status**: \`${activeRun.status}\``
      ].join("\n");
    }

    // Plain message -> Copilot turn
    const project = existing?.project || this.config.project.defaultProject;
    await sendEarlyUpdate("Starting Copilot session...");
    const provisionalRunId = `pending:${randomUUID()}`;
    this.activeRuns.set(key, {
      conversationKey: key,
      copilotSessionId: existing?.copilotSessionId || "(pending)",
      runId: provisionalRunId,
      startedAt: new Date().toISOString(),
      status: "starting"
    });

    try {
      const runOptions: CopilotTurnOptions = {
        reasoningEffort: this.conversationReasoningEffort.get(key),
        systemMessage: this.conversationSystemPrompts.get(key),
      };

      const handle = await this.copilot.runTurn(
        message,
        existing?.copilotSessionId,
        project,
        runOptions,
        {
          onStatus: onStatus || onUpdate,
          onUpdate
        }
      );
      this.activeRuns.set(key, {
        conversationKey: key,
        copilotSessionId: existing?.copilotSessionId || "(pending)",
        runId: handle.runId,
        startedAt: new Date().toISOString(),
        status: "running"
      });

      const result = await handle.done;
      const nextBinding =
        existing && existing.copilotSessionId === result.sessionId
          ? { ...existing, updatedAt: new Date().toISOString() }
          : this.makeBinding(key, result.sessionId, project, existing);
      await this.store.put(nextBinding);
      return result.output;
    } finally {
      this.activeRuns.delete(key);
    }
  }

  private async sendStartupReadyNotification(title: string, logLabel: string): Promise<void> {
    if (!this.config.feishu.startupNotifyChatId) return;
    try {
      const binding = await this.store.get(`p2p:${this.config.feishu.startupNotifyChatId}`);
      if (binding?.copilotSessionId) {
        await this.copilot.probeSessionModelInfo(binding.copilotSessionId, binding.project).catch(() => {});
      }
      const [copilotInfo, feishuDiagnostics] = await Promise.all([
        this.copilot.getCopilotInfo().catch(() => undefined),
        Promise.resolve(this.feishu?.diagnostics()),
      ]);
      const text = [
        `- **Copilot**: \`${copilotInfo?.status.version ?? "(unknown)"}\``,
        `- **Backend**: \`acp\``,
        `- **Default project**: \`${this.config.project.defaultProject}\``,
        ...(binding?.project ? [`- **Current project**: \`${binding.project}\``] : []),
        ...(feishuDiagnostics ? [`- **Feishu**: ${this.formatFeishuStatusSummary(feishuDiagnostics)}`] : [])
      ].join("\n");
      await this.feishu?.sendStartupReady(text, this.buildFooter(undefined, binding), title);
      console.log(logLabel, { chatId: this.config.feishu.startupNotifyChatId });
    } catch (error) {
      console.error(`failed to send ${title.toLowerCase()} notification`, error);
    }
  }

  private configuredLocalCommandNames(): string[] {
    return Object.keys(this.config.commands.map);
  }

  private builtinLocalProjectCommandNames(): string[] {
    return [
      "cat", "cp", "find", "head", "ln", "ls", "mkdir", "mv", "pwd",
      "readlink", "rg", "rmdir", "sha256sum", "tail", "tar", "touch",
      "trash", "trash-list", "trash-restore", "tree", "wc"
    ];
  }

  private resolveLocalProjectCommand(commandName: string): string | undefined {
    if (this.builtinLocalProjectCommandNames().includes(commandName)) return commandName;
    return this.config.commands.map[commandName];
  }

  private isLocalProjectCommand(commandName: string): boolean {
    return Boolean(this.resolveLocalProjectCommand(commandName));
  }

  private localProjectCommandNames(): string[] {
    return Array.from(new Set([
      ...this.builtinLocalProjectCommandNames(),
      ...this.configuredLocalCommandNames()
    ])).sort((a, b) => a.localeCompare(b));
  }

  private localProjectCommandHelpText(): string {
    return this.localProjectCommandNames().map((name) => `\`/${name}\``).join(", ");
  }

  private titleForCommand(commandName?: string, rawInput?: string): string {
    const detail = rawInput ? rawInput.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") : undefined;
    if (!commandName) {
      return this.composeTitle("Copilot", "🤖", detail || "reply");
    }
    const base = this.commandBaseTitle(commandName);
    const emoji = this.commandTitleEmoji(commandName);
    return this.composeTitle(base, emoji, detail || `/${commandName}`);
  }

  private composeTitle(base: string, emoji: string | undefined, detail: string): string {
    const maxLength = this.config.feishu.titleMaxLength;
    const prefix = `${base} | ${emoji ? `${emoji} ` : ""}`;
    if (prefix.length >= maxLength) {
      return this.shortenTitleInput(`${prefix}${detail}`, maxLength);
    }
    return `${prefix}${this.shortenTitleInput(detail, maxLength - prefix.length)}`;
  }

  private commandBaseTitle(commandName: string): string {
    if (this.isLocalProjectCommand(commandName)) return commandName;
    switch (commandName) {
      case "help": return "Help";
      case "status": return "Status";
      case "new": return "New Session";
      case "session": return "Session";
      case "resume": return "Resume Session";
      case "stop": return "Stop";
      case "compact": return "Compact";
      case "model": return "Model";
      case "system": return "System";
      case "project": return "Project";
      case "log": return "Log";
      case "git": return "Git";
      case "feishu": return "Feishu";
      default: return commandName.charAt(0).toUpperCase() + commandName.slice(1);
    }
  }

  private commandTitleEmoji(commandName: string): string | undefined {
    if (this.isLocalProjectCommand(commandName)) return "📂";
    switch (commandName) {
      case "help": return "❓";
      case "status": return "📊";
      case "new": return "✨";
      case "session": return "🧭";
      case "resume": return "↩️";
      case "stop": return "⏹️";
      case "compact": return "🗜️";
      case "model": return "🧠";
      case "system": return "⚙️";
      case "project": return "📁";
      case "log": return "📜";
      case "git": return "🌿";
      case "feishu": return "🪶";
      default: return undefined;
    }
  }

  private shortenTitleInput(input: string, maxLength = this.config.feishu.titleMaxLength): string {
    const normalized = input.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) return normalized;
    const edge = Math.max(8, Math.floor((maxLength - 3) / 2));
    return `${normalized.slice(0, edge)}...${normalized.slice(-edge)}`;
  }

  private templateForCommand(commandName?: string): OutgoingMessage["template"] {
    if (!commandName) return "blue";
    switch (commandName) {
      case "help":
      case "status":
      case "session":
      case "project":
      case "model":
      case "system":
      case "feishu":
      case "log":
        return "indigo";
      case "new":
      case "resume":
      case "stop":
      case "compact":
      case "git":
      case "cat":
      case "cp":
      case "find":
      case "head":
      case "ln":
      case "ls":
      case "mkdir":
      case "mv":
      case "pwd":
      case "readlink":
      case "rg":
      case "rmdir":
      case "sha256sum":
      case "tail":
      case "tar":
      case "touch":
      case "trash":
      case "trash-list":
      case "trash-restore":
      case "tree":
      case "wc":
        return "wathet";
      default:
        return this.isLocalProjectCommand(commandName) ? "wathet" : "blue";
    }
  }

  private templateForSeverity(
    baseTemplate: OutgoingMessage["template"],
    severity?: AppResponse["severity"]
  ): OutgoingMessage["template"] {
    if (severity === "warning") return "orange";
    if (severity === "error") return "red";
    return baseTemplate;
  }

  private renderCommandError(
    title: string,
    error: string,
    usage?: string,
    extraLines: string[] = []
  ): AppResponse {
    return {
      severity: "warning",
      text: [
        `# ${title}`,
        "",
        `- **Error**: ${error}`,
        ...(usage ? [`- **Usage**: ${usage}`] : []),
        ...extraLines
      ].join("\n")
    };
  }

  private stripLeadingMarkdownHeading(text: string): string {
    const normalized = text.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("# ")) return text;
    const firstNewline = normalized.indexOf("\n");
    if (firstNewline < 0) return "";
    return normalized.slice(firstNewline + 1).replace(/^\n+/, "");
  }

  private extractLeadingMarkdownHeading(text: string): { heading: string; body: string } | undefined {
    const normalized = text.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("# ")) return undefined;
    const firstNewline = normalized.indexOf("\n");
    const heading = normalized.slice(2, firstNewline < 0 ? undefined : firstNewline).trim();
    if (!heading) return undefined;
    const body = firstNewline < 0 ? "" : normalized.slice(firstNewline + 1).replace(/^\n+/, "");
    return { heading, body };
  }

  private footerForMessage(commandName: string | undefined, key: string, binding?: SessionBinding): string | undefined {
    if (!commandName) return undefined;
    return this.buildFooter(key, binding);
  }

  private footerForCopilotReply(key: string, binding?: SessionBinding): string {
    return this.buildFooter(key, binding);
  }

  private buildFooter(key: string | undefined, binding?: SessionBinding): string {
    const sessionId = binding?.copilotSessionId;
    const sessionInfo = sessionId ? this.copilot.getSessionModelInfo(sessionId) : undefined;
    const explicitEffort = key ? this.conversationReasoningEffort.get(key) : undefined;
    const model = sessionInfo?.model;
    const effort = explicitEffort || sessionInfo?.reasoningEffort;
    const project = binding?.project;
    const quota = sessionId ? this.copilot.getSessionQuota(sessionId) : undefined;
    const quotaStr = quota !== undefined ? `${quota.toFixed(1)}%` : undefined;
    const parts: string[] = [
      ...(model ? [effort ? `${model} ${effort}` : model] : []),
      ...(project ? [`\`${project}\``] : []),
      ...(sessionId ? [sessionId] : []),
      ...(quotaStr ? [quotaStr] : []),
    ];
    return `${this.buildIsoFooter()}  |  ${parts.join(" · ")}`;
  }

  private withBodyFormat(
    result: string | AppResponse,
    bodyFormat?: OutgoingBodyFormat
  ): string | AppResponse {
    if (!bodyFormat) return result;
    if (typeof result === "string") {
      return {
        text: result,
        bodyFormat
      };
    }
    return {
      ...result,
      bodyFormat
    };
  }

  private buildIsoFooter(): string {
    return this.formatLocalIsoTimestamp(new Date());
  }

  private formatLocalIsoTimestamp(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const millis = String(date.getMilliseconds()).padStart(3, "0");
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absoluteOffset = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
    const offsetMins = String(absoluteOffset % 60).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${sign}${offsetHours}:${offsetMins}`;
  }

  private makeBinding(
    conversationKey: string,
    copilotSessionId: string | undefined,
    project: string,
    defaults?: Partial<SessionBinding>
  ): SessionBinding {
    const now = new Date().toISOString();
    return {
      conversationKey,
      copilotSessionId,
      project,
      searchEnabled: defaults?.searchEnabled ?? this.config.project.defaultSearchEnabled,
      createdAt: defaults?.createdAt || now,
      updatedAt: now
    };
  }

  private async resolveProject(
    requested: string,
    currentProject: string,
    createMissing = false,
    requireExists = true
  ): Promise<string> {
    const resolved = path.resolve(
      requested.startsWith("/")
        ? requested
        : path.resolve(currentProject || this.config.project.defaultProject, requested)
    );
    const allowed = this.config.project.allowedRoots.some((root) => {
      const relative = path.relative(root, resolved);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    if (!allowed) {
      throw new Error(`Project must stay under one of: ${this.config.project.allowedRoots.join(", ")}`);
    }
    let stats = requireExists ? await fs.stat(resolved).catch(() => null) : null;
    if (!stats && createMissing) {
      await fs.mkdir(resolved, { recursive: true });
      stats = await fs.stat(resolved).catch(() => null);
    }
    if (requireExists && !stats?.isDirectory()) {
      throw new Error(`Project does not exist: ${resolved}`);
    }
    return resolved;
  }

  private async listProjects(currentProject: string): Promise<ProjectListEntry[]> {
    const max = this.config.project.listMaxCount;
    const seen = new Set<string>();

    // Collect all sources in parallel
    const [bindings, sessions] = await Promise.all([
      this.store.list(),
      this.copilot.listSessions(undefined, { limit: max }).catch(() => []),
    ]);

    const boundProjects = new Set(bindings.map((b) => b.project));

    // Build updatedAt map from bindings (most recent per project)
    const bindingUpdatedAt = new Map<string, string>();
    for (const b of bindings) {
      const existing = bindingUpdatedAt.get(b.project);
      if (!existing || b.updatedAt > existing) bindingUpdatedAt.set(b.project, b.updatedAt);
    }

    // Collect all unique allowed project paths
    const allPaths = new Set<string>();
    for (const b of bindings) {
      if (this.isAllowedProject(b.project)) allPaths.add(b.project);
    }
    for (const s of sessions) {
      if (s.context?.cwd && this.isAllowedProject(s.context.cwd)) allPaths.add(s.context.cwd);
    }
    for (const p of this.config.project.knownPaths) {
      if (this.isAllowedProject(p)) allPaths.add(p);
    }
    if (this.isAllowedProject(currentProject)) allPaths.add(currentProject);

    const entries: ProjectListEntry[] = [...allPaths].map((p) => ({
      project: p,
      name: path.basename(p) || p,
      bound: boundProjects.has(p),
      known: this.config.project.knownPaths.includes(p),
      updatedAt: bindingUpdatedAt.get(p),
    }));

    // Sort: current first, then Name asc, then Path asc as tie-breaker
    entries.sort((a, b) => {
      if (a.project === currentProject) return -1;
      if (b.project === currentProject) return 1;
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.project.localeCompare(b.project);
    });

    return entries.slice(0, max);
  }

  private isAllowedProject(project: string): boolean {
    return this.config.project.allowedRoots.some((root) => {
      const relative = path.relative(root, project);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  }

  private renderSessionDetailText(options: {
    title: string;
    sessionId: string;
    project: string;
    sessionMeta?: SessionMetadata;
    modelInfo?: { model?: string; reasoningEffort?: string };
    leadingLines?: string[];
    flags?: string[];
  }): string {
    const { title, sessionId, project, sessionMeta, modelInfo, leadingLines = [], flags = [] } = options;
    const lastMessage = sessionMeta?.summary || "(no preview)";
    return [
      `# ${title}`,
      "",
      ...leadingLines,
      ...(leadingLines.length > 0 ? [""] : []),
      `- **Session**: \`${sessionId}\``,
      `- **Project**: \`${project}\``,
      ...(modelInfo?.model
        ? [`- **Model**: \`${modelInfo.model}\`${modelInfo.reasoningEffort ? ` (effort: ${modelInfo.reasoningEffort})` : ""}`]
        : []),
      `- **Time**: ${this.formatAnyTimestamp(sessionMeta?.startTime?.toISOString())}`,
      `- **Cwd**: \`${sessionMeta?.context?.cwd || "(unknown)"}\``,
      "- **Last message**:",
      "",
      this.renderFencedBlock("text", lastMessage),
      `- **Flags**: ${flags.length > 0 ? flags.map((flag) => this.formatListFlag(flag)).join(", ") : "-"}`
    ].join("\n");
  }

  private async renderRecentSessionReplayMessages(
    sessionId: string,
    limit: number
  ): Promise<AppResponse[]> {
    if (limit < 1) return [];
    const messages = await this.copilot.getSessionMessages(sessionId);
    const replayMessages = this.extractRecentReplayMessages(messages, limit);
    return replayMessages.map((message, index) => this.renderRecentSessionReplayMessage(message, index));
  }

  private extractRecentReplayMessages(
    events: SessionEvent[],
    limit: number
  ): RecentSessionReplayMessage[] {
    const messages: RecentSessionReplayMessage[] = [];
    for (const event of events) {
      if (event.type !== "user.message" && event.type !== "assistant.message") {
        continue;
      }
      const content = typeof event.data?.content === "string" ? event.data.content.trim() : "";
      if (!content) continue;
      const message: RecentSessionReplayMessage = {
        role: event.type === "assistant.message" ? "assistant" : "user",
        text: content
      };
      const rawTimestamp = (event as SessionEvent & { timestamp?: unknown }).timestamp;
      if (typeof rawTimestamp === "string" && rawTimestamp.trim()) {
        message.timestamp = rawTimestamp;
      }
      const previous = messages[messages.length - 1];
      if (
        previous &&
        previous.role === message.role &&
        previous.text === message.text &&
        previous.timestamp === message.timestamp
      ) {
        continue;
      }
      messages.push(message);
    }
    return messages.slice(-limit);
  }

  private renderRecentSessionReplayMessage(
    message: RecentSessionReplayMessage,
    _index: number
  ): AppResponse {
    const title = message.role === "assistant" ? "[Copilot]" : "[User]";
    const prefix = message.timestamp
      ? `${title} ${this.formatAnyTimestamp(message.timestamp, message.timestamp)}`
      : title;
    return {
      text: `${prefix}\n\n${message.text}`,
      bodyFormat: "raw-text"
    };
  }

  private previewText(value: string, maxLength = 120): string {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 3)}...`;
  }

  private formatAnyTimestamp(value: unknown, fallback = "(unknown)"): string {
    if (typeof value !== "string" || !value.trim()) return fallback;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return this.formatLocalIsoTimestamp(parsed);
  }

  private async listSessionsForDisplay(
    limit: number,
    project?: string
  ): Promise<SessionListEntry[]> {
    const sessions = await this.copilot.listSessions(project, { limit: Math.max(1, limit) });
    const entries = sessions.map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.startTime?.toISOString(),
      modifiedAt: s.modifiedTime?.toISOString(),
      cwd: s.context?.cwd,
      preview: s.summary,
      isRemote: s.isRemote,
    }));
    // Enrich with last user message in parallel (best-effort)
    await Promise.allSettled(entries.map(async (entry) => {
      try {
        const messages = await this.copilot.getSessionMessages(entry.sessionId);
        for (let i = messages.length - 1; i >= 0; i--) {
          const ev = messages[i];
          if (ev.type === "user.message" && ev.data.content?.trim()) {
            entry.preview = this.previewText(ev.data.content.trim(), 80);
            break;
          }
        }
      } catch {
        // keep summary fallback
      }
    }));
    return entries;
  }

  private noSessionsText(project: string): string {
    return [
      `No Copilot sessions found for project \`${project}\``,
      "",
      `Use \`/new -C ${project}\` to start a fresh session there.`
    ].join("\n");
  }

  private renderSessionList(
    title: string,
    sessions: SessionListEntry[],
    boundSessionId?: string
  ): string {
    const lines = [
      `# ${title}`,
      "",
      "| # | Project | Updated | Session | Last message | Flags |",
      "| --- | --- | --- | --- | --- | --- |"
    ];
    for (const [index, session] of sessions.entries()) {
      const isCurrentSession = session.sessionId === boundSessionId;
      const flags = [
        isCurrentSession ? "current" : "",
        isCurrentSession ? "bound" : "",
        session.isRemote ? "remote" : ""
      ].filter(Boolean);
      lines.push(
        `| ${index + 1} | ${escapeMarkdownCell(session.cwd || "(unknown)")} | ${escapeMarkdownCell(this.formatAnyTimestamp(session.modifiedAt ?? session.createdAt))} | ${escapeMarkdownCell(session.sessionId)} | ${escapeMarkdownCell(session.preview || "(no preview)")} | ${escapeMarkdownCell(flags.length > 0 ? flags.map((flag) => this.formatListFlag(flag)).join(", ") : "-")} |`
      );
    }
    return lines.join("\n");
  }

  private renderProjectList(
    title: string,
    projects: ProjectListEntry[],
    currentProject: string
  ): string {
    const lines = [
      `# ${title}`,
      "",
      "| # | Name | Flags | Updated | Path |",
      "| --- | --- | --- | --- | --- |"
    ];
    for (const [index, item] of projects.entries()) {
      const flags = [
        item.project === currentProject ? "current" : "",
        item.bound ? "bound" : "",
        item.known && !item.bound ? "known" : ""
      ].filter(Boolean);
      lines.push(
        `| ${index + 1} | ${escapeMarkdownCell(item.name)} | ${escapeMarkdownCell(flags.length > 0 ? flags.map((flag) => this.formatListFlag(flag)).join(", ") : "-")} | ${escapeMarkdownCell(item.updatedAt ? this.formatAnyTimestamp(item.updatedAt) : "-")} | ${escapeMarkdownCell(item.project)} |`
      );
    }
    return lines.join("\n");
  }

  private formatListFlag(flag: string): string {
    return flag === "current" ? `\`${flag}\`` : flag;
  }

  private parseLogQuery(args: string[]): LogQuery | Error {
    const query: LogQuery = { limit: 200 };
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "-n") {
        const limit = Number(args[index + 1] || "");
        if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
          return new Error("`-n` must be an integer between 1 and 2000");
        }
        query.limit = limit;
        index += 1;
        continue;
      }
      if (arg === "--since") {
        const since = (args[index + 1] || "").trim();
        if (!since) return new Error("`--since` requires a value");
        query.since = since;
        index += 1;
        continue;
      }
      if (arg === "--grep") {
        const grep = (args[index + 1] || "").trim();
        if (!grep) return new Error("`--grep` requires a value");
        query.grep = grep;
        index += 1;
        continue;
      }
      return new Error(`unsupported option \`${arg}\``);
    }
    return query;
  }

  private async readBridgeLogs(query: LogQuery): Promise<string> {
    try {
      const journalArgs = [
        "--user",
        "-u",
        "copilot-feishu-bridge.service",
        "-n",
        String(query.limit),
        "--no-pager"
      ];
      if (query.since) {
        journalArgs.push("--since", query.since);
      }
      const { stdout, stderr } = await execFileAsync("journalctl", journalArgs, {
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      const filtered = query.grep
        ? combined
            .split(/\r?\n/)
            .filter((line) => line.toLowerCase().includes(query.grep!.toLowerCase()))
            .join("\n")
        : combined;
      return [
        "# Log",
        "",
        `- **Unit**: \`copilot-feishu-bridge.service\``,
        `- **Lines**: \`${query.limit}\``,
        ...(query.since ? [`- **Since**: \`${query.since}\``] : []),
        ...(query.grep ? [`- **Grep**: \`${query.grep}\``] : []),
        "",
        "```text",
        this.truncateOutput(filtered || "(no output)"),
        "```"
      ].join("\n");
    } catch (error) {
      const maybe = error as Error & { stdout?: string; stderr?: string; code?: number | string };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return [
        "# Log",
        "",
        `- **Unit**: \`copilot-feishu-bridge.service\``,
        `- **Status**: \`failed\``,
        `- **Code**: \`${String(maybe.code ?? "(unknown)")}\``,
        "",
        "```text",
        this.truncateOutput(output || maybe.message || "journalctl failed"),
        "```"
      ].join("\n");
    }
  }

  private async runGitCommand(project: string, args: string[]): Promise<string | AppResponse> {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: project,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      return this.renderFencedBlock("text", this.truncateOutput(combined || "(no output)"));
    } catch (error) {
      const maybe = error as Error & { code?: number | string; stdout?: string; stderr?: string; signal?: NodeJS.Signals };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return {
        severity: "warning",
        text: [
          `- **Status**: ⚠️ \`failed\``,
          `- **Code**: \`${String(maybe.code ?? "(unknown)")}\``,
          "",
          this.renderFencedBlock("text", this.truncateOutput(output || maybe.message || "git command failed"))
        ].join("\n")
      };
    }
  }

  private async runLocalCommand(
    bin: string,
    project: string,
    args: string[],
    displayName = bin
  ): Promise<string | AppResponse> {
    // Feishu auto-converts filenames (e.g. README.md) to markdown links [README.md](http://readme.md/)
    // Strip these back to plain text before passing to the binary
    args = args.map(arg => arg.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"));
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        cwd: project,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      return this.renderFencedBlock("text", this.truncateOutput(combined || "(no output)"));
    } catch (error) {
      const maybe = error as Error & { code?: number | string; stdout?: string; stderr?: string; signal?: NodeJS.Signals };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return {
        severity: "warning",
        text: [
          `- **Status**: ⚠️ \`failed\``,
          `- **Code**: \`${String(maybe.code ?? "(unknown)")}\``,
          "",
          this.renderFencedBlock("text", this.truncateOutput(output || maybe.message || `${displayName} command failed`))
        ].join("\n")
      };
    }
  }

  private truncateOutput(value: string): string {
    const limit = this.config.copilot.outputSoftLimit;
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}\n\n[output truncated]`;
  }

  private renderFencedBlock(language: string, value: string): string {
    const longestBacktickRun = Math.max(
      0,
      ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)
    );
    const fence = "`".repeat(longestBacktickRun > 0 ? longestBacktickRun + 1 : 3);
    return `${fence}${language}\n${value}\n${fence}`;
  }

  private commandMetaCard(displayName: string, project: string, _commandText: string): string {
    return `Running \`${displayName}\` in project \`${project}\`...`;
  }

  private async readInstalledPackageVersion(packageName: string): Promise<string | undefined> {
    const packagePath = new URL(`../../node_modules/${packageName}/package.json`, import.meta.url);
    const raw = await fs.readFile(packagePath, "utf8").catch(() => "");
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { version?: string };
      return typeof parsed.version === "string" ? parsed.version : undefined;
    } catch {
      return undefined;
    }
  }

  private async readDeclaredPackageRange(packageName: string): Promise<string | undefined> {
    const packagePath = new URL("../../package.json", import.meta.url);
    const raw = await fs.readFile(packagePath, "utf8").catch(() => "");
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      return parsed.dependencies?.[packageName] ?? parsed.devDependencies?.[packageName];
    } catch {
      return undefined;
    }
  }

  private async readLatestNpmPackageVersion(packageName: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        "npm",
        ["view", packageName, "version", "--json"],
        { timeout: 15_000, maxBuffer: 512 * 1024 }
      );
      const trimmed = stdout.trim();
      if (!trimmed) return undefined;
      const parsed = JSON.parse(trimmed) as string;
      return typeof parsed === "string" ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private describeUpdateStatus(current?: string, latest?: string): string {
    if (!latest) return "latest unavailable";
    if (!current) return "current unknown";
    return this.normalizeVersion(current) === this.normalizeVersion(latest) ? "up to date" : "update available";
  }

  private formatUpdateStatusBadge(status: string): string {
    return status === "up to date" ? `\`${status}\`` : `**${status}**`;
  }

  private normalizeVersion(value: string): string {
    return value.trim().replace(/^v/i, "");
  }

  // Feishu diagnostics rendering

  private renderFeishuSummary(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return [
      "# Feishu",
      "",
      `- **Status**: ${this.formatFeishuDoctorVerdict(diagnostics)}`,
      `- **Ws**: ${this.formatFeishuWsSummary(diagnostics)}`,
      `- **Send**: ${this.formatFeishuSendSummary(diagnostics)}`,
      "",
      "## More",
      "",
      "- `/feishu ws`",
      "- `/feishu send`",
      "- `/feishu doctor`"
    ].join("\n");
  }

  private renderFeishuWs(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return [
      "# Feishu WS",
      "",
      `- **Connected once**: \`${diagnostics.wsConnectedOnce ? "yes" : "no"}\``,
      `- **Reconnecting**: \`${diagnostics.wsReconnecting ? "yes" : "no"}\``,
      `- **Reconnect count**: \`${diagnostics.reconnectCount}\``,
      `- **Auto reconnect**: \`${this.config.feishu.wsAutoReconnect ? "yes" : "no"}\``,
      `- **Logger level**: \`${this.config.feishu.wsLoggerLevel}\``,
      `- **Last reconnect started**: ${this.formatAnyTimestamp(diagnostics.lastReconnectStartedAt, "(never)")}`,
      `- **Last ws ready**: ${this.formatAnyTimestamp(diagnostics.lastWsReadyAt)}`,
      `- **Last inbound message**: ${this.formatAnyTimestamp(diagnostics.lastInboundMessageAt)}`,
      `- **Last inbound message Id**: \`${diagnostics.lastInboundMessageId || "(unknown)"}\``
    ].join("\n");
  }

  private renderFeishuSend(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return [
      "# Feishu Send",
      "",
      `- **Retry max attempts**: \`${this.config.feishu.sendRetryMaxAttempts}\``,
      `- **Retry base delay ms**: \`${this.config.feishu.sendRetryBaseDelayMs}\``,
      `- **Outbound retries**: \`${diagnostics.outboundRetryCount}\``,
      `- **Outbound failures**: \`${diagnostics.outboundFailureCount}\``,
      `- **Active streaming cards**: \`${diagnostics.activeStreamingCards}\``,
      `- **Last send error**: ${diagnostics.lastSendError || "(none)"}`
    ].join("\n");
  }

  private renderFeishuDoctor(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    const findings: string[] = [];
    const startedAtMs = Date.parse(diagnostics.startedAt);
    if (!diagnostics.wsConnectedOnce) findings.push("- websocket has not connected yet");
    if (
      !diagnostics.wsConnectedOnce &&
      Number.isFinite(startedAtMs) &&
      Date.now() - startedAtMs >= this.config.feishu.wsConnectWarnAfterMs
    ) {
      findings.push(`- websocket has not become ready within \`${this.config.feishu.wsConnectWarnAfterMs}\` ms since startup`);
    }
    if (diagnostics.wsReconnecting) findings.push("- websocket is currently reconnecting");
    if (diagnostics.reconnectCount >= this.config.feishu.wsReconnectWarnThreshold) {
      findings.push(`- websocket has reconnected multiple times: \`${diagnostics.reconnectCount}\``);
    }
    if (diagnostics.outboundFailureCount > 0) {
      findings.push(`- outbound send failures observed: \`${diagnostics.outboundFailureCount}\``);
    }
    if (!diagnostics.lastInboundMessageAt) {
      findings.push("- no inbound Feishu message has been observed since startup");
    }
    return [
      "# Feishu Doctor",
      "",
      `- **Verdict**: ${this.formatFeishuDoctorVerdict(diagnostics)}`,
      `- **Ws summary**: ${this.formatFeishuWsSummary(diagnostics)}`,
      `- **Send summary**: ${this.formatFeishuSendSummary(diagnostics)}`,
      "",
      "## Findings",
      "",
      ...(findings.length ? findings : ["- no obvious transport issues from the current in-memory diagnostics"])
    ].join("\n");
  }

  private formatFeishuStatusSummary(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return `${this.formatFeishuDoctorVerdict(diagnostics)}; ${this.formatFeishuWsSummary(diagnostics)}; ${this.formatFeishuSendSummary(diagnostics)}`;
  }

  private formatFeishuDoctorVerdict(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    if (!diagnostics.wsConnectedOnce) return "`attention` (ws not connected yet)";
    if (diagnostics.wsReconnecting) return "`attention` (reconnecting)";
    if (diagnostics.outboundFailureCount > 0) return "`attention` (outbound failures seen)";
    return "✅ ok";
  }

  private formatFeishuWsSummary(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    const parts = [
      `connected=\`${diagnostics.wsConnectedOnce ? "yes" : "no"}\``,
      `reconnecting=\`${diagnostics.wsReconnecting ? "yes" : "no"}\``,
      `reconnects=\`${diagnostics.reconnectCount}\``,
    ];
    if (diagnostics.lastWsReadyAt) parts.push(`lastReady=${diagnostics.lastWsReadyAt}`);
    if (diagnostics.lastInboundMessageAt) parts.push(`lastInbound=${diagnostics.lastInboundMessageAt}`);
    return parts.join(" ");
  }

  private formatFeishuSendSummary(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return `retries=\`${diagnostics.outboundRetryCount}\` failures=\`${diagnostics.outboundFailureCount}\` streaming=\`${diagnostics.activeStreamingCards}\``;
  }

  // Help texts

  private statusHelpText(): string {
    return [
      "# Status",
      "",
      "Show current bridge conversation state, bound session, project, and live run details.",
      "",
      "## Usage",
      "",
      "- `/status`",
      "- `/status check-update`",
      "- `/status -h|--help`",
      "",
      "## Options",
      "",
      "- `check-update` check npm registry for updates to Copilot, Copilot SDK, and Feishu packages",
      "- `-h, --help` show status help",
      "",
      "## Behavior",
      "",
      "- Sends a short progress update first because `/status` may read session metadata and SDK state.",
      "- `check-update` queries npm for the latest versions of `@github/copilot`, `@github/copilot-sdk`, and `@larksuiteoapi/node-sdk`.",
      "",
      "## Examples",
      "",
      "- `/status`",
      "- `/status check-update`"
    ].join("\n");
  }

  private newHelpText(): string {
    return [
      "# New",
      "",
      "Create and bind a fresh Copilot session for the current project.",
      "",
      "## Usage",
      "",
      "- `/new [-C|--cd <dir>]`",
      "- `/new -h|--help`"
    ].join("\n");
  }

  private resumeHelpText(): string {
    return [
      "# Resume",
      "",
      "Resume a session.",
      "",
      "## Usage",
      "",
      "### `/resume <session-id>|[options]` - Resume a session.",
      "",
      "- `<session-id>` Resume one specific session id.",
      "",
      "#### Options",
      "",
      "- `-, --last` Resume the most recent session in the current scope.",
      "- `-n <index>` Resume the Nth session from the current `/session list` ordering.",
      `- \`--messages <count>\` Append the last \`${this.config.copilot.resumeDefaultMessages}\` thread messages by default after a successful session change.`,
      "- `-C, --cd <dir>` Require the resumed session to stay in that project.",
      "",
      "### `/resume list [options]` - List resumable sessions.",
      "",
      "- `/resume list` Show resumable sessions instead of rebinding.",
      "",
      "#### Options",
      "",
      "- `--all` Expand list beyond the current project.",
      "- `--project <path>` Scope list to one project path.",
      "",
      "### General",
      "",
      "- `-h, --help` Show resume help.",
      "",
      "## Examples",
      "",
      "- `/resume <session-id>` - resume one specific session",
      "- `/resume -` - resume the most recent session in the current scope"
    ].join("\n");
  }

  private sessionsHelpText(): string {
    return [
      "# Session",
      "",
      "Inspect the current bound session, inspect one specific Copilot session, or browse recent sessions.",
      "",
      "## Usage",
      "",
      "### `/session [<session-id>]` - Show session details.",
      "",
      "- `/session` Show the current bound session for this conversation.",
      "- `<session-id>` Show one specific session id without rebinding.",
      "",
      "#### Options",
      "",
      "### `/session list [options]` - List recent sessions.",
      "",
      "- `/session list` Browse recent sessions instead of rendering one session detail view.",
      "",
      "#### Options",
      "",
      "- `-n <count>` Limit the list size; accepts values from `1` to `1000`.",
      "- `--all` Expand browsing beyond the current project.",
      "- `--project <path>` Scope the list to one specific project path.",
      "",
      "### General",
      "",
      "- `--raw-markdown` Return fenced source markdown instead of rendered markdown.",
      "- `-h, --help` Show session help.",
      "",
      "## Examples",
      "",
      "- `/session` - show the current bound session for this conversation",
      "- `/session <session-id>` - inspect one specific session without rebinding",
      "- `/session list` - browse recent sessions for the current project"
    ].join("\n");
  }

  private stopHelpText(): string {
    return [
      "# Stop",
      "",
      "Stop the active Copilot run for this conversation.",
      "",
      "## Usage",
      "",
      "- `/stop`",
      "- `/stop -h|--help`"
    ].join("\n");
  }

  private compactHelpText(): string {
    return [
      "# Compact",
      "",
      "Compact the current bound Copilot session to reduce token usage.",
      "",
      "## Usage",
      "",
      "- `/compact`",
      "- `/compact -h|--help`"
    ].join("\n");
  }

  private projectHelpText(): string {
    return [
      "# Project",
      "",
      "Inspect the current bound project or manage project bindings.",
      "",
      "## Usage",
      "",
      "- `/project [list|bind [<path>|-n <index>|-m]|unbind <path>] [-h|--help]`",
      "- `/project -h|--help`"
    ].join("\n");
  }

  private modelHelpText(): string {
    return [
      "# 🧠 Model",
      "",
      "## Usage",
      "",
      "- `/model [list [--no-hidden] | <name>] [--reasoning <level>]`",
      "- `/model -h|--help`",
      "",
      "## Options",
      "",
      "- `list` show available Copilot model IDs",
      "- `--no-hidden` hide models marked as non-public",
      "",
      "## Effort Levels",
      "",
      "- `low`, `medium`, `high`, `xhigh`",
      "",
      "Effort is not persisted — resets on bridge restart (defaults to Copilot config)."
    ].join("\n");
  }

  private feishuHelpText(): string {
    return [
      "# Feishu",
      "",
      "Show Feishu websocket and outbound send diagnostics.",
      "",
      "## Usage",
      "",
      "- `/feishu [ws|send|doctor]`",
      "- `/feishu -h|--help`"
    ].join("\n");
  }

  private logHelpText(): string {
    return [
      "# Log",
      "",
      "Read recent bridge service logs from the systemd journal.",
      "",
      "## Usage",
      "",
      "- `/log [-n <count>]`",
      "- `/log -h|--help`"
    ].join("\n");
  }

  private modelListText(models: ModelInfo[]): string {
    if (models.length > 0) {
      const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
      const lines = [
        "# 🧠 Model List",
        "",
        "| # | Model | Reasoning | Input | Context | Premium | Notes |",
        "| --- | --- | --- | --- | --- | --- | --- |"
      ];
      for (const [i, m] of sorted.entries()) {
        const efforts = m.supportedReasoningEfforts;
        const reasoning = efforts && efforts.length > 0
          ? `${m.defaultReasoningEffort ?? efforts[0]} (${efforts.map(e => e[0]).join('/')})`
          : "-";
        const vision = m.capabilities?.supports?.vision;
        const input = vision ? "text, image" : "text";
        const ctx = m.capabilities?.limits?.max_context_window_tokens;
        const context = ctx ? (ctx >= 1000 ? `${Math.round(ctx / 1000)}K` : String(ctx)) : "-";
        const premium = (m.billing?.multiplier ?? 1) > 1 ? `${m.billing!.multiplier}×` : "-";
        const notes = m.name && m.name !== m.id ? escapeMarkdownCell(m.name) : "-";
        lines.push(`| ${i + 1} | ${escapeMarkdownCell(m.id)} | ${reasoning} | ${input} | ${context} | ${premium} | ${notes} |`);
      }
      return [
        ...lines,
        "",
        "- Use `/model <name>` to switch for this session."
      ].join("\n");
    }
    return [
      "# 🧠 Model List",
      "",
      "- Live model list unavailable.",
      "- Use `/model <name>` to switch for this session."
    ].join("\n");
  }
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
