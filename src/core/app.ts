import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CopilotBackend, CopilotTurnOptions } from "../adapters/copilot/backend.js";
import type { ModelInfo } from '@github/copilot-sdk';import { createCopilotBackend } from "../adapters/copilot/copilot-runtime.js";
import { FeishuGateway } from "../adapters/feishu/feishu-gateway.js";
import { AppConfig } from "../config/env.js";
import { conversationKeyFor } from "./conversation-key.js";
import { parseCommand } from "./command-router.js";
import { BindingStore } from "../store/binding-store.js";
import { ActiveRun, IncomingMessage, OutgoingMessage, SessionBinding } from "../types/domain.js";

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
  severity?: "warning" | "error";
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
      copilotDefaultModel: this.config.copilot.defaultModel
    });
    this.feishu = new FeishuGateway(this.config.feishu);
    await this.feishu.start(
      async (message) => {
        const parsedCommand = parseCommand(message);
        const command = parsedCommand && "args" in parsedCommand ? parsedCommand : undefined;
        const currentBinding = await this.store.get(conversationKeyFor(message));
        const commandName = command?.name || ("name" in (parsedCommand || {}) ? parsedCommand?.name : undefined);
        const messageTitle = this.titleForCommand(commandName, message.text);
        const messageTemplate = this.templateForCommand(commandName);
        const messageFooter = this.footerForMessage(commandName, currentBinding);
        const includeRawMarkdown = this.shouldIncludeRawMarkdownForMessage(commandName);
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
          const sendStatusSafely = async (update: string): Promise<void> => {
            statusChain = statusChain.then(async () => {
              try {
                const latestBinding =
                  (await this.store.get(conversationKeyFor(message))) || currentBinding;
                const formattedUpdate = formatForFeishu(update);
                const copilotStatusHeading = !commandName
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
                    ? this.footerForMessage(commandName, latestBinding)
                    : this.footerForCopilotReply(latestBinding),
                  text: statusText,
                  replyToMessageId: message.messageId,
                  threadId: message.threadId,
                  streaming: false,
                  includeRawMarkdown
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
                footer: this.footerForCopilotReply(latestBinding),
                text: snapshot,
                includeRawMarkdown,
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
              ? this.footerForMessage(commandName, latestBinding)
              : this.footerForCopilotReply(latestBinding);
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
              includeRawMarkdown,
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
              footer: this.buildIsoFooter(),
              text: `bridge error: ${text}`,
              includeRawMarkdown: false,
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
    onStatus?: (text: string) => Promise<void>
  ): Promise<string | AppResponse> {
    if (message.chatType !== "p2p") {
      return "Only direct messages are supported right now.";
    }

    const parsedCommand = parseCommand(message);
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
      return [
        "# Bridge Help",
        "",
        "## Core",
        "",
        "- `/help` show commands",
        "- `/status [check-update] [-h|--help]` show current session and run state; `check-update` checks npm versions",
        "- `/new [-C <dir>]` create and bind a fresh Copilot session",
        "- `/session [list [-n <count>] [--all] [--project <path>]]` show the current session or browse recent sessions",
        "- `/resume [<session-id>|-n <index>]` resume a session",
        "- `/stop` stop the current active run",
        "",
        "## Copilot",
        "",
        "- `/model [--list|name|clear]` show, list, or change the Copilot model for this conversation",
        "- `/system [clear|<text>]` show, set, or clear the system prompt for this conversation",
        "",
        "## Project",
        "",
        "- `/project [list|bind [<path>|-n <index>|-m]|unbind <path>] [-h|--help]` show the current project or manage project bindings",
        "- `/git [args...]` run `git` directly in the current bound project",
        "- `/cat`, `/find`, `/head`, `/ls`, `/pwd`, `/rg`, `/sha256sum`, `/tail`, `/tree`, `/wc` run local project commands",
        "",
        "## Diagnostics",
        "",
        "- `/feishu [ws|send|doctor]` show Feishu websocket and outbound send diagnostics",
        "- `/log [-n <count>]` show recent bridge service logs from systemd journal"
      ].join("\n");
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
      const feishuDiagnostics = this.feishu?.diagnostics();
      const systemPrompt = this.conversationSystemPrompts.get(key);
      return [
        "# Bridge Status",
        "",
        "## Copilot",
        "",
        `- **Copilot**: \`${copilotInfo?.status.version ?? "(unknown)"}\``,
        `- **Auth**: \`${copilotInfo?.auth.authType ?? "?"}\` (${copilotInfo?.auth.login ?? "unknown"})`,
        `- **Model**: \`${existing?.model || this.config.copilot.defaultModel}\``,
        `- **Directory**: \`${project}\``,
        `- **Session**: \`${sessionId}\``,
        `- **Session Time**: ${this.formatAnyTimestamp(sessionMeta?.startTime?.toISOString())}`,
        ...(sessionMeta?.context?.cwd ? [`- **Session Cwd**: \`${sessionMeta.context.cwd}\``] : []),
        ...(sessionMeta?.summary ? [`- **Session About**: ${this.previewText(sessionMeta.summary)}`] : []),
        ...(systemPrompt ? [`- **System Prompt**: ${this.previewText(systemPrompt)}`] : []),
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
      if (resumeArgs.peek() === "-h" || resumeArgs.peek() === "--help") {
        return this.resumeHelpText();
      }
      const currentProject = existing?.project || this.config.project.defaultProject;

      if (resumeArgs.peek() === "--list") {
        resumeArgs.shift();
        const sessions = await this.listSessionsForDisplay(
          this.config.copilot.sessionListMaxCount,
          currentProject
        );
        if (sessions.length === 0) {
          return this.noSessionsText(currentProject);
        }
        return this.renderSessionList("Resume Sessions", sessions, existing?.copilotSessionId);
      }

      let targetSessionId: string | undefined;
      let resumeSource = "latest";
      let resumeIndex: number | undefined;

      if (resumeArgs.peek() === "-n") {
        resumeArgs.shift();
        const rawIndex = resumeArgs.shift();
        const index = Number(rawIndex || "");
        if (!Number.isInteger(index) || index < 1) {
          return this.renderCommandError("Resume", "invalid resume index", "`/resume -n <index>`");
        }
        const sessions = await this.listSessionsForDisplay(
          Math.min(index, this.config.copilot.sessionListMaxCount),
          currentProject
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
        // Latest session
        const sessions = await this.listSessionsForDisplay(1, currentProject);
        targetSessionId = sessions[0]?.sessionId || existing?.copilotSessionId;
      }

      if (!targetSessionId) {
        return this.noSessionsText(currentProject);
      }
      await sendEarlyUpdate(`Resolving session \`${targetSessionId}\`...`);
      const sessionExists = await this.copilot.getSession(targetSessionId);
      if (!sessionExists) {
        return this.renderCommandError("Resume", `Session not found: ${targetSessionId}`);
      }
      const sessionMeta = (await this.copilot.listSessions()).find((s) => s.sessionId === targetSessionId);
      const binding = this.makeBinding(key, targetSessionId, sessionMeta?.context?.cwd || currentProject, existing);
      await this.store.put(binding);

      const sections = [
        "# Resume Session",
        "",
        `- **Source**: \`${resumeSource}\``,
        ...(resumeIndex ? [`- **Index**: \`${resumeIndex}\``] : []),
        `- **Session**: \`${targetSessionId}\``,
        `- **Project**: \`${binding.project}\``,
        `- **Time**: ${this.formatAnyTimestamp(sessionMeta?.startTime?.toISOString())}`,
        `- **Cwd**: \`${sessionMeta?.context?.cwd || "(unknown)"}\``,
        `- **About**: ${sessionMeta?.summary || "(no preview)"}`
      ];

      return sections.join("\n");
    }

    if (command?.name === "session") {
      const sessionArgs = new ArgCursor(command.args);
      if (sessionArgs.peek() === "-h" || sessionArgs.peek() === "--help") {
        return this.sessionsHelpText();
      }
      const currentProject = existing?.project || this.config.project.defaultProject;

      if (sessionArgs.peek() === "list") {
        sessionArgs.shift();
        const projectScopeArg = sessionArgs.takeOption("--project");
        const allProjects = sessionArgs.takeFlag("--all");
        const countArg = sessionArgs.takeOption("-n");
        const scopedProject = projectScopeArg
          ? await this.resolveProject(projectScopeArg, currentProject)
          : currentProject;
        let limit: number;
        if (countArg !== undefined) {
          const parsed = parseInt(countArg, 10);
          if (!Number.isFinite(parsed) || parsed < 1 || parsed > 1000) {
            return this.renderCommandError("Session", "`-n` must be a number between 1 and 1000", "`/session list [-n <count>] [--all] [--project <path>]`");
          }
          limit = parsed;
        } else {
          limit = allProjects
            ? this.config.copilot.sessionListMaxCount
            : this.config.copilot.sessionListDefaultCount;
        }
        const sessions = await this.listSessionsForDisplay(limit, allProjects ? undefined : scopedProject);
        if (sessions.length === 0) {
          return this.noSessionsText(scopedProject);
        }
        return this.renderSessionList("Sessions", sessions, existing?.copilotSessionId);
      }

      if (!sessionArgs.isEmpty()) {
        return this.renderCommandError(
          "Session",
          `unsupported session subcommand \`${sessionArgs.peek()}\``,
          "`/session [list [-n <count>] [--all] [--project <path>]] [-h|--help]`"
        );
      }

      if (!existing?.copilotSessionId) {
        return "No session is currently bound. Use `/new`, `/resume`, or `/session list`.";
      }
      const sessionMeta = (await this.copilot.listSessions()).find((s) => s.sessionId === existing.copilotSessionId);
      const project = existing.project || this.config.project.defaultProject;
      return [
        "# Current Session",
        "",
        `- **Session**: \`${existing.copilotSessionId}\``,
        `- **Project**: \`${project}\``,
        ...(existing.model ? [`- **Model**: \`${existing.model}\``] : []),
        `- **Time**: ${this.formatAnyTimestamp(sessionMeta?.startTime?.toISOString())}`,
        `- **Cwd**: \`${sessionMeta?.context?.cwd || "(unknown)"}\``,
        `- **About**: ${sessionMeta?.summary || "(no preview)"}`
      ].join("\n");
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
        model: existing?.model || this.config.copilot.defaultModel
      });
      const nextBinding = this.makeBinding(key, sessionId, project, existing);
      await this.store.put(nextBinding);
      return [
        "# New Session",
        "",
        `- **Session**: \`${sessionId}\``,
        `- **Project**: \`${nextBinding.project}\``,
        `- **Model**: \`${nextBinding.model || this.config.copilot.defaultModel}\``
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

    if (command?.name === "model") {
      const modelArgs = new ArgCursor(command.args);
      if (modelArgs.peek() === "-h" || modelArgs.peek() === "--help") {
        return this.modelHelpText();
      }
      if (modelArgs.peek() === "--list" || modelArgs.peek() === "list") {
        modelArgs.shift();
        await sendEarlyUpdate("Fetching Copilot model list...");
        const models = await this.copilot.listModels().catch(() => []);
        return this.modelListText(models);
      }
      const current = existing?.model || this.config.copilot.defaultModel;
      if (modelArgs.isEmpty()) {
        return `# Model\n\n- **Model**: \`${current}\``;
      }
      if (activeRun) {
        return `Cannot change model while run=${activeRun.runId} is ${activeRun.status}. Use /stop first.`;
      }
      const nextValue = modelArgs.remainingText();
      const nextBinding = existing
        ? {
            ...existing,
            model: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue,
            updatedAt: new Date().toISOString()
          }
        : this.makeBinding(
            key,
            undefined,
            this.config.project.defaultProject,
            { model: ["clear", "default", "reset"].includes(nextValue.toLowerCase()) ? undefined : nextValue }
          );
      await sendEarlyUpdate(`Switching model to \`${nextBinding.model || this.config.copilot.defaultModel}\`...`);
      await this.store.put(nextBinding);
      return `# Model\n\n- **Model**: \`${nextBinding.model || this.config.copilot.defaultModel}\``;
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
          `- **Allowed Roots**: ${this.config.project.allowedRoots.map((root) => `\`${root}\``).join(", ")}`
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
          `- **Removed Bindings**: \`${removed}\``
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
      await sendEarlyUpdate(`Running Git in project \`${project}\`...`);
      return this.runGitCommand(project, command.args);
    }

    if (
      command?.name === "cat" ||
      command?.name === "find" ||
      command?.name === "head" ||
      command?.name === "ls" ||
      command?.name === "pwd" ||
      command?.name === "rg" ||
      command?.name === "sha256sum" ||
      command?.name === "tail" ||
      command?.name === "tree" ||
      command?.name === "wc"
    ) {
      const localCommandName = command.name;
      const project = existing?.project || this.config.project.defaultProject;
      await sendEarlyUpdate(`Running ${localCommandName} in project \`${project}\`...`);
      return this.runLocalCommand(localCommandName, project, command.args);
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
        model: existing?.model || this.config.copilot.defaultModel,
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
      const feishuDiagnostics = this.feishu?.diagnostics();
      const text = [
        `- **Backend**: \`acp\``,
        `- **Default Project**: \`${this.config.project.defaultProject}\``,
        ...(binding?.project ? [`- **Current Project**: \`${binding.project}\``] : []),
        `- **Default Model**: \`${this.config.copilot.defaultModel}\``,
        ...(feishuDiagnostics ? [`- **Feishu**: ${this.formatFeishuStatusSummary(feishuDiagnostics)}`] : [])
      ].join("\n");
      await this.feishu?.sendStartupReady(text, this.buildIsoFooter(), title, false);
      console.log(logLabel, { chatId: this.config.feishu.startupNotifyChatId });
    } catch (error) {
      console.error(`failed to send ${title.toLowerCase()} notification`, error);
    }
  }

  private titleForCommand(commandName?: string, rawInput?: string): string {
    if (!commandName) {
      return this.composeTitle("Copilot", "🤖", rawInput || "reply");
    }
    const base = this.commandBaseTitle(commandName);
    const emoji = this.commandTitleEmoji(commandName);
    return this.composeTitle(base, emoji, rawInput || `/${commandName}`);
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
    switch (commandName) {
      case "help": return "Help";
      case "status": return "Status";
      case "new": return "New Session";
      case "session": return "Session";
      case "resume": return "Resume Session";
      case "stop": return "Stop";
      case "model": return "Model";
      case "system": return "System";
      case "project": return "Project";
      case "log": return "Log";
      case "git": return "Git";
      case "feishu": return "Feishu";
      case "pwd": return "PWD";
      case "ls": return "LS";
      case "cat": return "Cat";
      case "tree": return "Tree";
      case "find": return "Find";
      case "rg": return "RG";
      default: return "Copilot";
    }
  }

  private commandTitleEmoji(commandName: string): string | undefined {
    switch (commandName) {
      case "help": return "❓";
      case "status": return "📊";
      case "new": return "✨";
      case "session": return "🧭";
      case "resume": return "↩️";
      case "stop": return "⏹️";
      case "model": return "🤖";
      case "system": return "⚙️";
      case "project": return "📁";
      case "log": return "📜";
      case "git": return "🌿";
      case "feishu": return "🪶";
      case "pwd":
      case "ls":
      case "cat":
      case "tree":
      case "find":
      case "rg":
        return "📂";
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
      case "git":
      case "pwd":
      case "ls":
      case "cat":
      case "tree":
      case "find":
      case "rg":
        return "wathet";
      default:
        return "blue";
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

  private footerForMessage(commandName: string | undefined, binding?: SessionBinding): string | undefined {
    if (!commandName) return undefined;
    if (this.commandUsesCopilotFooter(commandName)) {
      return `${this.buildIsoFooter()}  |  ${this.buildCopilotFooterSummary(binding, true)}`;
    }
    const project = binding?.project || this.config.project.defaultProject;
    return `${this.buildIsoFooter()}  |  ${project}`;
  }

  private footerForCopilotReply(binding?: SessionBinding): string {
    return `${this.buildIsoFooter()}  |  ${this.buildCopilotFooterSummary(binding, true)}`;
  }

  private buildCopilotFooterSummary(binding?: SessionBinding, includeSession = false): string {
    const model = binding?.model || this.config.copilot.defaultModel;
    const session = includeSession ? binding?.copilotSessionId : undefined;
    const shortSession = session ? session.slice(0, 8) : undefined;
    return [`🤖 Copilot`, `model=${model}`, ...(shortSession ? [`session=${shortSession}`] : [])].join(" · ");
  }

  private commandUsesCopilotFooter(commandName: string): boolean {
    return ["status", "session", "new", "resume"].includes(commandName);
  }

  private shouldIncludeRawMarkdownForMessage(commandName?: string): boolean {
    return commandName === "help";
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
      model: defaults?.model,
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
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.startTime?.toISOString(),
      modifiedAt: s.modifiedTime?.toISOString(),
      cwd: s.context?.cwd,
      preview: s.summary,
      isRemote: s.isRemote,
    }));
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
      "| # | Project | Updated | Session | About | Flags |",
      "| --- | --- | --- | --- | --- | --- |"
    ];
    for (const [index, session] of sessions.entries()) {
      const flags = [
        session.sessionId === boundSessionId ? "bound" : "",
        session.isRemote ? "remote" : ""
      ].filter(Boolean);
      lines.push(
        `| ${index + 1} | ${escapeMarkdownCell(session.cwd || "(unknown)")} | ${escapeMarkdownCell(this.formatAnyTimestamp(session.modifiedAt ?? session.createdAt))} | ${escapeMarkdownCell(session.sessionId.slice(0, 8))} | ${escapeMarkdownCell(session.preview || "(no preview)")} | ${escapeMarkdownCell(flags.join(", ") || "-")} |`
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
        `| ${index + 1} | ${escapeMarkdownCell(item.name)} | ${escapeMarkdownCell(flags.join(", ") || "-")} | ${escapeMarkdownCell(item.updatedAt ? this.formatAnyTimestamp(item.updatedAt) : "-")} | ${escapeMarkdownCell(item.project)} |`
      );
    }
    return lines.join("\n");
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
    const commandText = ["git", ...args].join(" ");
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: project,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      return [
        "# Git",
        "",
        `- **Project**: \`${project}\``,
        `- **Command**: \`${commandText}\``,
        "",
        "```text",
        this.truncateOutput(combined || "(no output)"),
        "```"
      ].join("\n");
    } catch (error) {
      const maybe = error as Error & { code?: number | string; stdout?: string; stderr?: string; signal?: NodeJS.Signals };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return {
        severity: "warning",
        text: [
          "# Git",
          "",
          `- **Project**: \`${project}\``,
          `- **Command**: \`${commandText}\``,
          `- **Status**: ⚠️ \`failed\``,
          `- **Code**: \`${String(maybe.code ?? "(unknown)")}\``,
          "",
          "```text",
          this.truncateOutput(output || maybe.message || "git command failed"),
          "```"
        ].join("\n")
      };
    }
  }

  private async runLocalCommand(
    command: "cat" | "find" | "head" | "ls" | "pwd" | "rg" | "sha256sum" | "tail" | "tree" | "wc",
    project: string,
    args: string[]
  ): Promise<string | AppResponse> {
    const commandText = [command, ...args].join(" ");
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: project,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024
      });
      const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? "\n" : "");
      return [
        `# ${command.toUpperCase()}`,
        "",
        `- **Project**: \`${project}\``,
        `- **Command**: \`${commandText || command}\``,
        "",
        "```text",
        this.truncateOutput(combined || "(no output)"),
        "```"
      ].join("\n");
    } catch (error) {
      const maybe = error as Error & { code?: number | string; stdout?: string; stderr?: string; signal?: NodeJS.Signals };
      const output = [maybe.stdout, maybe.stderr].filter(Boolean).join(maybe.stdout && maybe.stderr ? "\n" : "");
      return {
        severity: "warning",
        text: [
          `# ${command.toUpperCase()}`,
          "",
          `- **Project**: \`${project}\``,
          `- **Command**: \`${commandText || command}\``,
          `- **Status**: ⚠️ \`failed\``,
          `- **Code**: \`${String(maybe.code ?? "(unknown)")}\``,
          "",
          "```text",
          this.truncateOutput(output || maybe.message || `${command} command failed`),
          "```"
        ].join("\n")
      };
    }
  }

  private truncateOutput(value: string): string {
    const limit = this.config.copilot.outputSoftLimit;
    if (value.length <= limit) return value;
    return `${value.slice(0, limit)}\n\n[output truncated]`;
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
      `- **Connected Once**: \`${diagnostics.wsConnectedOnce ? "yes" : "no"}\``,
      `- **Reconnecting**: \`${diagnostics.wsReconnecting ? "yes" : "no"}\``,
      `- **Reconnect Count**: \`${diagnostics.reconnectCount}\``,
      `- **Auto Reconnect**: \`${this.config.feishu.wsAutoReconnect ? "yes" : "no"}\``,
      `- **Logger Level**: \`${this.config.feishu.wsLoggerLevel}\``,
      `- **Last Reconnect Started**: ${this.formatAnyTimestamp(diagnostics.lastReconnectStartedAt, "(never)")}`,
      `- **Last Ws Ready**: ${this.formatAnyTimestamp(diagnostics.lastWsReadyAt)}`,
      `- **Last Inbound Message**: ${this.formatAnyTimestamp(diagnostics.lastInboundMessageAt)}`,
      `- **Last Inbound Message Id**: \`${diagnostics.lastInboundMessageId || "(unknown)"}\``
    ].join("\n");
  }

  private renderFeishuSend(diagnostics: ReturnType<FeishuGateway["diagnostics"]>): string {
    return [
      "# Feishu Send",
      "",
      `- **Retry Max Attempts**: \`${this.config.feishu.sendRetryMaxAttempts}\``,
      `- **Retry Base Delay Ms**: \`${this.config.feishu.sendRetryBaseDelayMs}\``,
      `- **Outbound Retries**: \`${diagnostics.outboundRetryCount}\``,
      `- **Outbound Failures**: \`${diagnostics.outboundFailureCount}\``,
      `- **Active Streaming Cards**: \`${diagnostics.activeStreamingCards}\``,
      `- **Last Send Error**: ${diagnostics.lastSendError || "(none)"}`
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
      `- **Ws Summary**: ${this.formatFeishuWsSummary(diagnostics)}`,
      `- **Send Summary**: ${this.formatFeishuSendSummary(diagnostics)}`,
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
      "Resume a Copilot session.",
      "",
      "## Usage",
      "",
      "- `/resume [<session-id>|-n <index>|--list]`",
      "- `/resume -h|--help`"
    ].join("\n");
  }

  private sessionsHelpText(): string {
    return [
      "# Session",
      "",
      "Inspect the current bound session or browse recent Copilot sessions.",
      "",
      "## Usage",
      "",
      "- `/session [list [-n <count>] [--all] [--project <path>]]`",
      "- `/session -h|--help`",
      "",
      "## Options",
      "",
      "**List**",
      "- `list` — browse recent sessions",
      "- `-n <count>` — limit the list size; accepts values from 1 to 1000",
      "- `--all` — include sessions from all projects",
      "- `--project <path>` — filter to one specific project path"
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
      "# Model",
      "",
      "Show or change the Copilot model override for this conversation.",
      "",
      "## Usage",
      "",
      "- `/model [--list|name|clear]`",
      "- `/model -h|--help`"
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
        "# Model List",
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
        "- Use `/model <name>` to set one for future turns.",
        "- Use `/model clear` to remove the override."
      ].join("\n");
    }
    return [
      "# Model List",
      "",
      "- Live model list unavailable.",
      "- Use `/model <name>` to set one for future turns.",
      "- Use `/model clear` to remove the override."
    ].join("\n");
  }
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();
}
