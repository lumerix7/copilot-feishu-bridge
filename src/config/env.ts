import { config as loadEnv } from "dotenv";
import fs from "node:fs";
import path from "node:path";

if (!process.env.FEISHU_APP_ID) {
  loadEnv();
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export interface AppConfig {
  nodeEnv: string;
  configPath?: string;
  feishu: {
    appId: string;
    appSecret: string;
    botOpenId: string;
    startupNotifyChatId?: string;
    connectionMode: "websocket";
    wsAutoReconnect: boolean;
    wsLoggerLevel: "error" | "warn" | "info" | "debug" | "trace";
    wsAgentKeepAliveMsecs: number;
    wsAgentMaxSockets: number;
    wsAgentMaxFreeSockets: number;
    wsConnectWarnAfterMs: number;
    wsReconnectWarnThreshold: number;
    reconnectReadyDebounceMs: number;
    sendRetryMaxAttempts: number;
    sendRetryBaseDelayMs: number;
    sendRetryMultiplier: number;
    sendRetryMaxDelayMs: number;
    titleMaxLength: number;
  };
  copilot: {
    copilotBin: string;
    outputSoftLimit: number;
    runTimeoutMs: number;
    statusIntervalMs: number;
    streamUpdateIntervalMs: number;
    sessionListDefaultCount: number;
    sessionListMaxCount: number;
    resumeDefaultMessages: number;
    statusIncludeProject: boolean;
    inlineBlocks: "off" | "on";
  };
  commands: {
    map: Record<string, string>;
  };
  project: {
    allowedRoots: string[];
    defaultProject: string;
    defaultSearchEnabled: boolean;
    knownPaths: string[];
    listMaxCount: number;
  };
  storePath: string;
}

interface JsonConfigShape {
  __path?: string;
  feishu?: {
    wsAutoReconnect?: unknown;
    wsLoggerLevel?: unknown;
    wsAgent?: {
      keepAliveMsecs?: unknown;
      maxSockets?: unknown;
      maxFreeSockets?: unknown;
    };
    wsConnectWarnAfterMs?: unknown;
    wsReconnectWarnThreshold?: unknown;
    reconnectReadyDebounceMs?: unknown;
    sendRetry?: {
      maxAttempts?: unknown;
      baseDelayMs?: unknown;
      multiplier?: unknown;
      maxDelayMs?: unknown;
    };
    titleMaxLength?: unknown;
  };
  copilot?: {
    copilotBin?: unknown;
    outputSoftLimit?: unknown;
    runTimeoutMs?: unknown;
    statusIntervalMs?: unknown;
    streamUpdateIntervalMs?: unknown;
    inlineBlocks?: unknown;
  };
  session?: {
    listDefaultCount?: unknown;
    listMaxCount?: unknown;
    resumeDefaultMessages?: unknown;
  };
  project?: {
    allowedRoots?: unknown;
    defaultPath?: unknown;
    defaultSearchEnabled?: unknown;
    knownPaths?: unknown;
    listMaxCount?: unknown;
  };
  status?: {
    includeProject?: unknown;
  };
  paths?: {
    storePath?: unknown;
  };
  commands?: {
    map?: unknown;
  };
  [key: string]: unknown;
}

export function loadConfig(): AppConfig {
  const jsonConfig = loadJsonConfig(process.env.BRIDGE_CONFIG_JSON);
  const nodeEnv = optional("NODE_ENV", "development");
  const defaultProject = path.resolve(
    readTextSetting("DEFAULT_PROJECT", process.cwd(), jsonConfig, ["project", "defaultPath"])
  );
  const projectAllowedRoots = readRootsSetting(
    "PROJECT_ALLOWED_ROOTS",
    jsonConfig,
    ["project", "allowedRoots"],
    defaultProject
  );
  if (!isUnderAnyRoot(defaultProject, projectAllowedRoots)) {
    throw new Error(
      `project.defaultPath must stay under project.allowedRoots: ${defaultProject}`
    );
  }

  return {
    configPath: jsonConfig?.__path,
    nodeEnv,
    feishu: {
      appId: required("FEISHU_APP_ID"),
      appSecret: required("FEISHU_APP_SECRET"),
      botOpenId: required("FEISHU_BOT_OPEN_ID"),
      startupNotifyChatId: optional("FEISHU_STARTUP_NOTIFY_CHAT_ID", "").trim() || undefined,
      connectionMode: "websocket",
      wsAutoReconnect: readBooleanSetting(
        "FEISHU_WS_AUTO_RECONNECT",
        true,
        jsonConfig,
        ["feishu", "wsAutoReconnect"]
      ),
      wsLoggerLevel: normalizeFeishuLoggerLevel(
        readTextSetting("FEISHU_WS_LOGGER_LEVEL", "debug", jsonConfig, ["feishu", "wsLoggerLevel"])
      ),
      wsAgentKeepAliveMsecs: readIntegerSetting(
        "FEISHU_WS_AGENT_KEEP_ALIVE_MSECS",
        60000,
        jsonConfig,
        ["feishu", "wsAgent", "keepAliveMsecs"],
        { min: 1 }
      ),
      wsAgentMaxSockets: readIntegerSetting(
        "FEISHU_WS_AGENT_MAX_SOCKETS",
        100,
        jsonConfig,
        ["feishu", "wsAgent", "maxSockets"],
        { min: 1 }
      ),
      wsAgentMaxFreeSockets: readIntegerSetting(
        "FEISHU_WS_AGENT_MAX_FREE_SOCKETS",
        20,
        jsonConfig,
        ["feishu", "wsAgent", "maxFreeSockets"],
        { min: 1 }
      ),
      wsConnectWarnAfterMs: readIntegerSetting(
        "FEISHU_WS_CONNECT_WARN_AFTER_MS",
        60000,
        jsonConfig,
        ["feishu", "wsConnectWarnAfterMs"],
        { min: 0 }
      ),
      wsReconnectWarnThreshold: readIntegerSetting(
        "FEISHU_WS_RECONNECT_WARN_THRESHOLD",
        3,
        jsonConfig,
        ["feishu", "wsReconnectWarnThreshold"],
        { min: 0 }
      ),
      reconnectReadyDebounceMs: readIntegerSetting(
        "FEISHU_RECONNECT_READY_DEBOUNCE_MS",
        60000,
        jsonConfig,
        ["feishu", "reconnectReadyDebounceMs"],
        { min: 0 }
      ),
      sendRetryMaxAttempts: readIntegerSetting(
        "FEISHU_SEND_RETRY_MAX_ATTEMPTS",
        5,
        jsonConfig,
        ["feishu", "sendRetry", "maxAttempts"],
        { min: 0 }
      ),
      sendRetryBaseDelayMs: readIntegerSetting(
        "FEISHU_SEND_RETRY_BASE_DELAY_MS",
        1000,
        jsonConfig,
        ["feishu", "sendRetry", "baseDelayMs"],
        { min: 0 }
      ),
      sendRetryMultiplier: readNumberSetting(
        "FEISHU_SEND_RETRY_MULTIPLIER",
        2,
        jsonConfig,
        ["feishu", "sendRetry", "multiplier"],
        { min: 1 }
      ),
      sendRetryMaxDelayMs: readIntegerSetting(
        "FEISHU_SEND_RETRY_MAX_DELAY_MS",
        10000,
        jsonConfig,
        ["feishu", "sendRetry", "maxDelayMs"],
        { min: 0 }
      ),
      titleMaxLength: readIntegerSetting(
        "FEISHU_TITLE_MAX_LENGTH",
        120,
        jsonConfig,
        ["feishu", "titleMaxLength"],
        { min: 8 }
      )
    },
    copilot: {
      copilotBin: readTextSetting(
        "COPILOT_BIN",
        "/opt/node/lib/node_modules/@github/copilot/npm-loader.js",
        jsonConfig,
        ["copilot", "copilotBin"]
      ),
      outputSoftLimit: readIntegerSetting(
        "COPILOT_OUTPUT_SOFT_LIMIT",
        100000,
        jsonConfig,
        ["copilot", "outputSoftLimit"],
        { min: 1 }
      ),
      runTimeoutMs: readIntegerSetting(
        "COPILOT_RUN_TIMEOUT_MS",
        600000,
        jsonConfig,
        ["copilot", "runTimeoutMs"],
        { min: 0 }
      ),
      statusIntervalMs: readIntegerSetting(
        "COPILOT_STATUS_INTERVAL_MS",
        60000,
        jsonConfig,
        ["copilot", "statusIntervalMs"],
        { min: 0 }
      ),
      streamUpdateIntervalMs: readIntegerSetting(
        "COPILOT_STREAM_UPDATE_INTERVAL_MS",
        120,
        jsonConfig,
        ["copilot", "streamUpdateIntervalMs"],
        { min: 0 }
      ),
      sessionListDefaultCount: readIntegerSetting(
        "COPILOT_SESSION_LIST_DEFAULT_COUNT",
        20,
        jsonConfig,
        ["session", "listDefaultCount"],
        { min: 1 }
      ),
      sessionListMaxCount: readIntegerSetting(
        "SESSION_LIST_MAX_COUNT",
        1000,
        jsonConfig,
        ["session", "listMaxCount"],
        { min: 1 }
      ),
      resumeDefaultMessages: readIntegerSetting(
        "SESSION_RESUME_DEFAULT_MESSAGES",
        5,
        jsonConfig,
        ["session", "resumeDefaultMessages"],
        { min: 0 }
      ),
      statusIncludeProject: readBooleanSetting(
        "STATUS_INCLUDE_PROJECT",
        true,
        jsonConfig,
        ["status", "includeProject"]
      ),
      inlineBlocks: normalizeInlineBlocks(
        readTextSetting("COPILOT_INLINE_BLOCKS", "on", jsonConfig, ["copilot", "inlineBlocks"])
      )
    },
    project: {
      allowedRoots: projectAllowedRoots,
      defaultProject,
      defaultSearchEnabled: readBooleanSetting(
        "DEFAULT_SEARCH_ENABLED",
        true,
        jsonConfig,
        ["project", "defaultSearchEnabled"]
      ),
      knownPaths: readStringArraySetting(jsonConfig, ["project", "knownPaths"])
        .map((p) => path.resolve(p))
        .filter((p) => isUnderAnyRoot(p, projectAllowedRoots)),
      listMaxCount: readNumberSetting("PROJECT_LIST_MAX_COUNT", 100, jsonConfig, ["project", "listMaxCount"], { min: 1 })
    },
    storePath: readTextSetting("STORE_PATH", ".data/bindings.json", jsonConfig, ["paths", "storePath"]),
    commands: {
      map: readStringMapSetting(jsonConfig, ["commands", "map"])
    }
  };
}

function readStringMapSetting(
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[]
): Record<string, string> {
  const jsonValue = readJsonValue(jsonConfig, jsonPath);
  if (!jsonValue || typeof jsonValue !== "object" || Array.isArray(jsonValue)) {
    return {};
  }
  const entries = Object.entries(jsonValue as Record<string, unknown>)
    .map(([rawKey, rawValue]) => {
      const key = rawKey.trim().replace(/^\/+/, "");
      const value = typeof rawValue === "string" ? rawValue.trim() : "";
      return [key, value] as const;
    })
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return Object.fromEntries(entries);
}

function normalizeInlineBlocks(value: string): AppConfig["copilot"]["inlineBlocks"] {
  const v = value.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return "off";
  return "on";
}

function normalizeFeishuLoggerLevel(value: string): AppConfig["feishu"]["wsLoggerLevel"] {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "error":
    case "warn":
    case "debug":
    case "trace":
      return normalized;
    default:
      return "info";
  }
}

function readIntegerSetting(
  name: string,
  fallback: number,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[],
  options: { min: number }
): number {
  const raw = readScalarSetting(name, fallback, jsonConfig, jsonPath);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < options.min) {
    throw new Error(`${name} must be an integer >= ${options.min}: ${JSON.stringify(raw)}`);
  }
  return value;
}

function readNumberSetting(
  name: string,
  fallback: number,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[],
  options: { min: number }
): number {
  const raw = readScalarSetting(name, fallback, jsonConfig, jsonPath);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < options.min) {
    throw new Error(`${name} must be a number >= ${options.min}: ${JSON.stringify(raw)}`);
  }
  return value;
}

function loadJsonConfig(configPath?: string): JsonConfigShape | undefined {
  if (!configPath) return undefined;
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Missing bridge config json: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw) as JsonConfigShape;
  parsed.__path = resolved;
  return parsed;
}

function readBooleanSetting(
  name: string,
  fallback: boolean,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[]
): boolean {
  const envValue = process.env[name];
  if (envValue !== undefined) return parseBooleanSetting(name, envValue);
  const jsonValue = readJsonValue(jsonConfig, jsonPath, [name]);
  if (typeof jsonValue === "boolean") return jsonValue;
  if (typeof jsonValue === "string") {
    return parseBooleanSetting(name, jsonValue);
  }
  return fallback;
}

function readTextSetting(
  name: string,
  fallback: string,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[]
): string {
  const envValue = process.env[name];
  if (envValue) return envValue;
  const jsonValue = readJsonValue(jsonConfig, jsonPath, [name]);
  if (typeof jsonValue === "string" && jsonValue.length > 0) {
    return expandEnvPlaceholders(jsonValue);
  }
  return fallback;
}

function readScalarSetting(
  name: string,
  fallback: string | number | boolean,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[]
): string | number | boolean {
  const envValue = process.env[name];
  if (envValue) return envValue;
  const jsonValue = readJsonValue(jsonConfig, jsonPath, [name]);
  if (
    typeof jsonValue === "string" ||
    typeof jsonValue === "number" ||
    typeof jsonValue === "boolean"
  ) {
    return typeof jsonValue === "string" ? expandEnvPlaceholders(jsonValue) : jsonValue;
  }
  return fallback;
}

function readStringArraySetting(
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[]
): string[] {
  const value = readJsonValue(jsonConfig, jsonPath);
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => expandEnvPlaceholders(item.trim()));
}

function readRootsSetting(
  name: string,
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[],
  primaryRoot: string
): string[] {
  const envValue = process.env[name];
  if (envValue) {
    return parseRootsSetting(envValue, primaryRoot);
  }
  const jsonValue = readJsonValue(jsonConfig, jsonPath, [name]);
  if (Array.isArray(jsonValue)) {
    return normalizeRoots(
      jsonValue
        .filter((item): item is string => typeof item === "string")
        .map((item) => expandEnvPlaceholders(item)),
      primaryRoot
    );
  }
  if (typeof jsonValue === "string" && jsonValue.trim()) {
    return parseRootsSetting(expandEnvPlaceholders(jsonValue), primaryRoot);
  }
  return normalizeRoots([], primaryRoot);
}

function readJsonValue(
  jsonConfig: JsonConfigShape | undefined,
  jsonPath: string[],
  legacyKeys: string[] = []
): unknown {
  const nested = getNestedValue(jsonConfig, jsonPath);
  if (nested !== undefined) return nested;
  for (const key of legacyKeys) {
    if (jsonConfig && key in jsonConfig) {
      return jsonConfig[key];
    }
  }
  return undefined;
}

function getNestedValue(value: unknown, jsonPath: string[]): unknown {
  let current: unknown = value;
  for (const segment of jsonPath) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseBooleanSetting(name: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean: ${JSON.stringify(raw)}`);
}

function parseRootsSetting(raw: string, primaryRoot: string): string[] {
  return normalizeRoots(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => path.resolve(part)),
    primaryRoot
  );
}

function normalizeRoots(parts: string[], primaryRoot: string): string[] {
  return Array.from(new Set([path.resolve(primaryRoot), ...parts.map((part) => path.resolve(part))]));
}

function expandEnvPlaceholders(value: string): string {
  return value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_, simpleName: string, bracketName: string) => {
    const variableName = simpleName || bracketName;
    return process.env[variableName] || "";
  });
}

function isUnderAnyRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, target);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}
