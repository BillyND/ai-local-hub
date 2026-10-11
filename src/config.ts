import { isCancel, password, text } from "@clack/prompts";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "workspace-tools-mcp",
  "config.json",
);

interface PersistedConfig {
  version: 1;
  workspaceRoot: string;
  openaiTunnelId: string;
  openaiApiKey: string;
  cacheDir: string;
}

export interface Config {
  workspaceRoot: string;
  tunnelId: string;
  apiKey: string;
  cacheDir: string;
  localOnly: boolean;
  configPath: string;
  loadedFromDisk: boolean;
}

export interface ConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  localOnly?: boolean;
  reset?: boolean;
  configPath?: string;
  persist?: boolean;
  signal?: AbortSignal;
  prompt?: (
    label: string,
    secret: boolean,
    defaultValue?: string,
  ) => Promise<string>;
}

function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : value.startsWith("~/") || value.startsWith("~\\")
      ? join(homedir(), value.slice(2))
      : value;
}

async function loadConfig(path: string): Promise<PersistedConfig | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid saved configuration: ${path}. Run with --reset.`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("workspaceRoot" in parsed) ||
    typeof parsed.workspaceRoot !== "string" ||
    !("openaiTunnelId" in parsed) ||
    typeof parsed.openaiTunnelId !== "string" ||
    !("openaiApiKey" in parsed) ||
    typeof parsed.openaiApiKey !== "string" ||
    !("cacheDir" in parsed) ||
    typeof parsed.cacheDir !== "string"
  ) {
    throw new Error(`Invalid saved configuration: ${path}. Run with --reset.`);
  }
  await chmod(path, 0o600);
  return parsed as PersistedConfig;
}

async function removeSavedConfigArtifacts(path: string): Promise<void> {
  await rm(path, { force: true });
  try {
    const prefix = `${basename(path)}.`;
    for (const name of await readdir(dirname(path))) {
      if (
        name.startsWith(prefix) &&
        name.endsWith(".tmp") &&
        /^\d+$/.test(name.slice(prefix.length, -4))
      )
        await rm(join(dirname(path), name), { force: true });
    }
  } catch (error: unknown) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
  }
}

async function saveConfig(
  path: string,
  config: PersistedConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function promptValue(
  options: ConfigOptions,
  label: string,
  secret: boolean,
  defaultValue?: string,
): Promise<string> {
  options.signal?.throwIfAborted();
  if (options.prompt)
    return (await options.prompt(label, secret, defaultValue)).trim();
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      `${label} is missing. Set it in the environment or use an interactive terminal.`,
    );
  const common = {
    message: label,
    signal: options.signal,
    validate: (value: string | undefined) =>
      value?.trim() || defaultValue ? undefined : "This value is required.",
  };
  const answer = secret
    ? await password({ ...common, mask: "*" })
    : await text({
        ...common,
        ...(defaultValue ? { defaultValue, placeholder: defaultValue } : {}),
      });
  if (isCancel(answer)) throw new Error("Configuration cancelled.");
  options.signal?.throwIfAborted();
  return answer.trim();
}

export async function resolveConfig(
  options: ConfigOptions = {},
): Promise<Config> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const localOnly = options.localOnly ?? false;
  const configPath = resolve(
    cwd,
    expandHome(
      options.configPath ||
        env.WORKSPACE_TOOLS_CONFIG_FILE ||
        DEFAULT_CONFIG_PATH,
    ),
  );
  const hasRuntimeOverrides = [
    "WORKSPACE_ROOT",
    "OPENAI_TUNNEL_ID",
    "OPENAI_API_KEY",
    "WORKSPACE_TOOLS_CACHE_DIR",
  ].some((name) => Boolean(env[name]?.trim()));
  if (options.reset) await removeSavedConfigArtifacts(configPath);
  const saved = await loadConfig(configPath);
  const shouldPersist = options.persist ?? !hasRuntimeOverrides;
  const required = async (
    envName: string,
    label: string,
    secret: boolean,
    savedValue?: string,
    defaultValue?: string,
  ): Promise<string> => {
    options.signal?.throwIfAborted();
    const value =
      env[envName]?.trim() ||
      savedValue ||
      (await promptValue(options, label, secret, defaultValue));
    if (!value) throw new Error(`${label} is required.`);
    return value;
  };
  const workspaceValue = expandHome(
    await required(
      "WORKSPACE_ROOT",
      "Workspace folder",
      false,
      saved?.workspaceRoot,
      cwd,
    ),
  );
  const workspacePath = isAbsolute(workspaceValue)
    ? workspaceValue
    : resolve(cwd, workspaceValue);
  let workspaceRoot: string;
  try {
    if (!(await stat(workspacePath)).isDirectory())
      throw new Error("not a directory");
    workspaceRoot = await realpath(workspacePath);
  } catch {
    throw new Error(
      `Workspace folder must be an existing directory: ${workspacePath}`,
    );
  }
  const tunnelId = localOnly
    ? ""
    : await required(
        "OPENAI_TUNNEL_ID",
        "OpenAI Tunnel ID",
        false,
        saved?.openaiTunnelId,
      );
  const apiKey = localOnly
    ? ""
    : await required(
        "OPENAI_API_KEY",
        "OpenAI API key",
        true,
        saved?.openaiApiKey,
      );
  const cacheDir = resolve(
    cwd,
    expandHome(
      env.WORKSPACE_TOOLS_CACHE_DIR?.trim() ||
        saved?.cacheDir ||
        join(homedir(), ".cache", "workspace-tools-mcp"),
    ),
  );
  options.signal?.throwIfAborted();
  if (shouldPersist)
    await saveConfig(configPath, {
      version: 1,
      workspaceRoot,
      openaiTunnelId: localOnly ? (saved?.openaiTunnelId ?? "") : tunnelId,
      openaiApiKey: localOnly ? (saved?.openaiApiKey ?? "") : apiKey,
      cacheDir,
    });
  return {
    workspaceRoot,
    tunnelId,
    apiKey,
    cacheDir,
    localOnly,
    configPath,
    loadedFromDisk: Boolean(saved),
  };
}
