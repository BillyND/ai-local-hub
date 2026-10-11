import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { HttpError } from "./http-utils.js";

export interface DirectoryListing {
  path: string;
  parent: string | null;
  dirs: string[];
}

const MAX_ENTRIES = 1_000;

/** Lists sub-directories (no files, no dot-directories) for the workspace folder picker. */
export async function listDirectories(requested: string): Promise<DirectoryListing> {
  if (!isAbsolute(requested)) throw new HttpError(400, "Path must be absolute.");
  const path = resolve(requested);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    throw new HttpError(400, `Cannot read directory: ${path}`);
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_ENTRIES);
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, dirs };
}
