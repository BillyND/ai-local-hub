import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  url: string;
  token: string;
}

export type LockResult =
  | { acquired: true; release(): Promise<void> }
  | { acquired: false; existing: LockInfo };

function parse(contents: string): LockInfo | undefined {
  try {
    const value = JSON.parse(contents) as Partial<LockInfo>;
    if (
      typeof value.pid === "number" &&
      typeof value.url === "string" &&
      typeof value.token === "string"
    )
      return { pid: value.pid, url: value.url, token: value.token };
  } catch {
    /* corrupt lock */
  }
  return undefined;
}

async function isAlive(info: LockInfo): Promise<boolean> {
  try {
    process.kill(info.pid, 0);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  try {
    // Any HTTP answer (the UI replies 401 without a cookie) proves the manager is serving.
    await fetch(info.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(1_500),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Single-manager guard: the first manager records its URL and token (0600) so a second
 * `npm start` can reopen it instead of running a competing manager on the same config.
 */
export async function acquireManagerLock(
  path: string,
  info: LockInfo,
): Promise<LockResult> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, JSON.stringify(info), { mode: 0o600, flag: "wx" });
      await chmod(path, 0o600);
      return {
        acquired: true,
        release: async () => {
          const current = parse(await readFile(path, "utf8").catch(() => ""));
          if (current?.pid === info.pid) await rm(path, { force: true });
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = parse(await readFile(path, "utf8").catch(() => ""));
    if (existing && (await isAlive(existing)))
      return { acquired: false, existing };
    await rm(path, { force: true });
  }
  throw new Error(`Could not acquire the manager lock: ${path}`);
}
