import { input, password } from '@inquirer/prompts';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface Config {
  workspaceRoot: string;
  tunnelId: string;
  apiKey: string;
  cacheDir: string;
  localOnly: boolean;
}

export interface ConfigOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  localOnly?: boolean;
  signal?: AbortSignal;
  prompt?: (name: string, secret: boolean, defaultValue?: string) => Promise<string>;
}

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') || value.startsWith('~\\')
    ? join(homedir(), value.slice(2)) : value;
}

export async function resolveConfig(options: ConfigOptions = {}): Promise<Config> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const localOnly = options.localOnly ?? false;
  const prompt = options.prompt ?? (async (name: string, secret: boolean, defaultValue?: string) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(`${name} is missing. Set it in the environment or run in an interactive terminal.`);
    }
    const context = options.signal ? { signal: options.signal } : {};
    return secret
      ? password({ message: `${name}:`, mask: '*' }, context)
      : input({ message: `${name}:`, ...(defaultValue ? { default: defaultValue } : {}) }, context);
  });
  const value = async (name: string, secret = false, defaultValue?: string): Promise<string> => {
    options.signal?.throwIfAborted();
    const result = (env[name] ?? await prompt(name, secret, defaultValue)).trim();
    if (!result) throw new Error(`${name} must not be empty.`);
    return result;
  };
  const workspaceValue = expandHome(await value('WORKSPACE_ROOT', false, cwd));
  const workspacePath = isAbsolute(workspaceValue) ? workspaceValue : resolve(cwd, workspaceValue);
  let workspaceRoot: string;
  try {
    if (!(await stat(workspacePath)).isDirectory()) throw new Error('not a directory');
    workspaceRoot = await realpath(workspacePath);
  } catch {
    throw new Error(`WORKSPACE_ROOT must be an existing directory: ${workspacePath}`);
  }
  const tunnelId = localOnly ? '' : await value('CONTROL_PLANE_TUNNEL_ID');
  const apiKey = localOnly ? '' : await value('CONTROL_PLANE_API_KEY', true);
  const cacheValue = env.PI_TOOLS_MCP_CACHE_DIR?.trim() || join(homedir(), '.cache', 'pi-tools-mcp');
  const cacheDir = resolve(cwd, expandHome(cacheValue));
  return { workspaceRoot, tunnelId, apiKey, cacheDir, localOnly };
}
