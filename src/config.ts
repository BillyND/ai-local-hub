import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface InstanceConfig {
  id: string;
  name: string;
  workspaceRoot: string;
  tunnelId: string;
  apiKey: string;
}

export interface StoredConfig {
  version: 2;
  cacheDir: string;
  instances: InstanceConfig[];
}

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "workspace-tools-mcp",
  "config.json",
);
const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "workspace-tools-mcp");

export function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : value.startsWith("~/") || value.startsWith("~\\")
      ? join(homedir(), value.slice(2))
      : value;
}

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return resolve(
    cwd,
    expandHome(env.WORKSPACE_TOOLS_CONFIG_FILE?.trim() || DEFAULT_CONFIG_PATH),
  );
}

/** Environment wins over the saved cache directory so CI and tests can isolate downloads. */
export function resolveCacheDir(
  saved: StoredConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  return resolve(
    cwd,
    expandHome(env.WORKSPACE_TOOLS_CACHE_DIR?.trim() || saved.cacheDir),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalid(path: string): Error {
  return new Error(`Invalid saved configuration: ${path}. Run with --reset.`);
}

function parseInstance(value: unknown, path: string): InstanceConfig {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.workspaceRoot !== "string" ||
    typeof value.tunnelId !== "string" ||
    typeof value.apiKey !== "string"
  )
    throw invalid(path);
  const { id, name, workspaceRoot, tunnelId, apiKey } = value;
  return { id, name, workspaceRoot, tunnelId, apiKey };
}

function parseStored(parsed: unknown, path: string): StoredConfig {
  if (!isRecord(parsed) || typeof parsed.cacheDir !== "string")
    throw invalid(path);
  if (parsed.version === 1) {
    // Single-instance files from earlier releases become one instance named "default".
    const { workspaceRoot, openaiTunnelId, openaiApiKey } = parsed;
    if (
      typeof workspaceRoot !== "string" ||
      typeof openaiTunnelId !== "string" ||
      typeof openaiApiKey !== "string"
    )
      throw invalid(path);
    const migrated =
      openaiTunnelId && openaiApiKey
        ? [
            {
              id: "default",
              name: "default",
              workspaceRoot,
              tunnelId: openaiTunnelId,
              apiKey: openaiApiKey,
            },
          ]
        : [];
    return { version: 2, cacheDir: parsed.cacheDir, instances: migrated };
  }
  if (parsed.version !== 2 || !Array.isArray(parsed.instances))
    throw invalid(path);
  return {
    version: 2,
    cacheDir: parsed.cacheDir,
    instances: parsed.instances.map((entry) => parseInstance(entry, path)),
  };
}

export async function loadConfig(path: string): Promise<StoredConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 2, cacheDir: DEFAULT_CACHE_DIR, instances: [] };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw invalid(path);
  }
  const config = parseStored(parsed, path);
  await chmod(path, 0o600);
  return config;
}

export async function saveConfig(
  path: string,
  config: StoredConfig,
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

export async function removeSavedConfig(path: string): Promise<void> {
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
