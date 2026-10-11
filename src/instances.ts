import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  expandHome,
  loadConfig,
  saveConfig,
  type InstanceConfig,
  type StoredConfig,
} from "./config.js";

export interface InstanceInput {
  name: string;
  workspaceRoot: string;
  tunnelId: string;
  apiKey: string;
}

const MAX_NAME_LENGTH = 40;

async function normalize(
  input: InstanceInput,
  others: readonly InstanceConfig[],
  cwd: string,
): Promise<InstanceInput> {
  const name = input.name.trim();
  const tunnelId = input.tunnelId.trim();
  const apiKey = input.apiKey.trim();
  if (!name) throw new Error("Name is required.");
  if (name.length > MAX_NAME_LENGTH)
    throw new Error(`Name must be at most ${MAX_NAME_LENGTH} characters.`);
  if (!tunnelId) throw new Error("OpenAI Tunnel ID is required.");
  if (!apiKey) throw new Error("OpenAI API key is required.");
  if (others.some((o) => o.name.toLowerCase() === name.toLowerCase()))
    throw new Error(`An instance named "${name}" already exists.`);
  if (others.some((o) => o.tunnelId === tunnelId))
    throw new Error(
      `Tunnel ID ${tunnelId} is already used by another instance.`,
    );
  const expanded = expandHome(input.workspaceRoot.trim() || cwd);
  const workspacePath = isAbsolute(expanded)
    ? expanded
    : resolve(cwd, expanded);
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
  return { name, workspaceRoot, tunnelId, apiKey };
}

async function mutate(
  path: string,
  change: (config: StoredConfig) => Promise<InstanceConfig | undefined>,
): Promise<InstanceConfig | undefined> {
  const config = await loadConfig(path);
  const result = await change(config);
  await saveConfig(path, config);
  return result;
}

export async function addInstance(
  path: string,
  input: InstanceInput,
  cwd: string = process.cwd(),
): Promise<InstanceConfig> {
  const added = await mutate(path, async (config) => {
    const instance = {
      id: randomUUID().slice(0, 8),
      ...(await normalize(input, config.instances, cwd)),
    };
    config.instances.push(instance);
    return instance;
  });
  return added as InstanceConfig;
}

/** An empty apiKey keeps the stored key so the secret never needs to be re-displayed. */
export async function updateInstance(
  path: string,
  id: string,
  input: InstanceInput,
  cwd: string = process.cwd(),
): Promise<InstanceConfig> {
  const updated = await mutate(path, async (config) => {
    const index = config.instances.findIndex((o) => o.id === id);
    const current = config.instances[index];
    if (!current) throw new Error("Instance not found.");
    const others = config.instances.filter((o) => o.id !== id);
    const next = {
      id,
      ...(await normalize(
        { ...input, apiKey: input.apiKey.trim() || current.apiKey },
        others,
        cwd,
      )),
    };
    config.instances[index] = next;
    return next;
  });
  return updated as InstanceConfig;
}

export async function removeInstance(path: string, id: string): Promise<void> {
  await mutate(path, async (config) => {
    config.instances = config.instances.filter((o) => o.id !== id);
    return undefined;
  });
}
