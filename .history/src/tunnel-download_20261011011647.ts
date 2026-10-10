import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { unzipSync } from "fflate";

export interface TunnelBinary {
  path: string;
  version: string;
  cached: boolean;
}
const LATEST_RELEASE_URL = "https://api.github.com/repos/openai/tunnel-client/releases/latest";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_SUMS_BYTES = 1 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;
const MANIFEST_FILE = "manifest.json";
const CACHE_ROOT = "tunnel-client";


interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseMetadata {
  tag_name: string;
  assets: ReleaseAsset[];
}

interface PlatformTarget {
  platform: "darwin" | "linux" | "windows";
  arch: "arm64" | "amd64";
  executableName: "tunnel-client" | "tunnel-client.exe";
}

interface CacheManifest {
  version: string;
  platform: PlatformTarget["platform"];
  arch: PlatformTarget["arch"];
  assetName: string;
  archiveSha256: string;
  binarySha256: string;
  executableName: string;
}

interface SelectedAssets {
  archive: ReleaseAsset;
  sums: ReleaseAsset;
}

interface ExtractedBinary {
  bytes: Buffer;
  executableName: string;
}

export async function ensureTunnelClient(
  cacheDir: string,
  onLog?: (message: string) => void,
  signal?: AbortSignal,
): Promise<TunnelBinary> {
  const target = currentTarget();
  const release = await fetchLatestRelease(signal);
  const version = normalizeVersion(release.tag_name);
  const selected = selectAssets(release, version, target);
  const installDir = path.join(cacheDir, CACHE_ROOT, version, `${target.platform}-${target.arch}`);
  const executablePath = path.join(installDir, target.executableName);

  const cached = await validateCache(installDir, executablePath, version, target, selected.archive.name);
  if (cached) {
    onLog?.(`Using cached tunnel-client ${version} for ${target.platform}-${target.arch}`);
    return { path: executablePath, version, cached: true };
  }

  await rm(installDir, { recursive: true, force: true });
  const stagingParent = await mkdtemp(path.join(tmpdir(), "pi-tools-tunnel-client-"));
  const stagingDir = path.join(stagingParent, randomUUID());

  try {
    await mkdir(stagingDir, { recursive: true });
    assertOfficialDownloadUrl(selected.sums.browser_download_url);
    assertOfficialDownloadUrl(selected.archive.browser_download_url);
    const [sumsResponse, archiveResponse] = await Promise.all([
      fetchWithDeadline(selected.sums.browser_download_url, signal, { Accept: "text/plain" }),
      fetchWithDeadline(selected.archive.browser_download_url, signal, { Accept: "application/octet-stream" }),
    ]);
    const [sumsBytes, archiveBytes] = await Promise.all([
      readResponseBytes(sumsResponse, MAX_SUMS_BYTES, "SHA256SUMS.txt"),
      readResponseBytes(archiveResponse, MAX_ARCHIVE_BYTES, selected.archive.name),
    ]);
    const sumsText = sumsBytes.toString("utf8");
    const expectedArchiveSha = parseSha256Sums(sumsText).get(selected.archive.name);
    if (!expectedArchiveSha) {
      throw new Error(`Vendor SHA256SUMS does not contain ${selected.archive.name}`);
    }

    const archiveSha256 = sha256(archiveBytes);
    if (archiveSha256 !== expectedArchiveSha) {
      throw new Error(`Downloaded ${selected.archive.name} SHA256 mismatch: expected ${expectedArchiveSha}, got ${archiveSha256}`);
    }

    const extracted = extractBinary(selected.archive.name, archiveBytes, target.executableName);
    const binarySha256 = sha256(extracted.bytes);
    await writeFile(path.join(stagingDir, extracted.executableName), extracted.bytes, { mode: 0o755 });
    if (target.platform !== "windows") {
      await chmod(path.join(stagingDir, extracted.executableName), 0o755);
    }

    const manifest: CacheManifest = {
      version,
      platform: target.platform,
      arch: target.arch,
      assetName: selected.archive.name,
      archiveSha256,
      binarySha256,
      executableName: extracted.executableName,
    };
    await writeFile(path.join(stagingDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    await access(path.join(stagingDir, target.executableName), fsConstants.X_OK).catch(async (error: unknown) => {
      if (target.platform === "windows") return;
      throw error;
    });

    await mkdir(path.dirname(installDir), { recursive: true });
    await rm(installDir, { recursive: true, force: true });
    await rename(stagingDir, installDir);
    onLog?.(`Installed tunnel-client ${version} for ${target.platform}-${target.arch}`);
    return { path: executablePath, version, cached: false };
  } catch (error) {
    await rm(installDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(stagingParent, { recursive: true, force: true }).catch(() => undefined);
  }
}

function currentTarget(): PlatformTarget {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  if ((platform !== "darwin" && platform !== "linux" && platform !== "windows") || (arch !== "arm64" && arch !== "amd64")) {
    throw new Error(`Unsupported tunnel-client platform: ${process.platform}-${process.arch}`);
  }
  if (platform === "windows" && arch !== "amd64") {
    throw new Error(`Unsupported tunnel-client platform: ${process.platform}-${process.arch}`);
  }
  return { platform, arch, executableName: platform === "windows" ? "tunnel-client.exe" : "tunnel-client" };
}

async function validateCache(
  installDir: string,
  executablePath: string,
  version: string,
  target: PlatformTarget,
  assetName: string,
): Promise<boolean> {
  try {
    const manifest = parseManifest(await readFile(path.join(installDir, MANIFEST_FILE), "utf8"));
    if (
      manifest.version !== version ||
      manifest.platform !== target.platform ||
      manifest.arch !== target.arch ||
      manifest.assetName !== assetName ||
      manifest.executableName !== target.executableName
    ) {
      return false;
    }
    const executable = await readFile(executablePath);
    if (sha256(executable) !== manifest.binarySha256) {
      return false;
    }
    const fileStat = await stat(executablePath);
    if (!fileStat.isFile() || fileStat.size === 0) {
      return false;
    }
    if (target.platform !== "windows") {
      await access(executablePath, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function parseManifest(raw: string): CacheManifest {
  const parsed = JSON.parse(raw) as Partial<CacheManifest>;
  if (
    typeof parsed.version !== "string" ||
    typeof parsed.platform !== "string" ||
    typeof parsed.arch !== "string" ||
    typeof parsed.assetName !== "string" ||
    typeof parsed.archiveSha256 !== "string" ||
    typeof parsed.binarySha256 !== "string" ||
    typeof parsed.executableName !== "string"
  ) {
    throw new Error("Malformed tunnel-client cache manifest");
  }
  return parsed as CacheManifest;
}

async function fetchLatestRelease(signal?: AbortSignal): Promise<ReleaseMetadata> {
  const response = await fetchWithDeadline(LATEST_RELEASE_URL, signal, { Accept: "application/vnd.github+json" });
  const raw = await response.json() as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Malformed tunnel-client release metadata: expected object");
  }
  const release = raw as { tag_name?: unknown; assets?: unknown };
  if (typeof release.tag_name !== "string" || !Array.isArray(release.assets)) {
    throw new Error("Malformed tunnel-client release metadata: missing tag_name or assets");
  }
  const assets = release.assets.map((asset, index): ReleaseAsset => {
    if (!asset || typeof asset !== "object") {
      throw new Error(`Malformed tunnel-client release metadata: asset ${index} is not an object`);
    }
    const candidate = asset as { name?: unknown; browser_download_url?: unknown };
    if (typeof candidate.name !== "string" || typeof candidate.browser_download_url !== "string") {
      throw new Error(`Malformed tunnel-client release metadata: asset ${index} missing name or browser_download_url`);
    }
    return { name: candidate.name, browser_download_url: candidate.browser_download_url };
  });
  return { tag_name: release.tag_name, assets };
}

function normalizeVersion(tagName: string): string {
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tagName)) {
    throw new Error(`Malformed tunnel-client release tag: ${tagName}`);
  }
  return tagName;
}

function selectAssets(release: ReleaseMetadata, version: string, target: PlatformTarget): SelectedAssets {
  const archiveName = `tunnel-client-${version}-${target.platform}-${target.arch}.zip`;
  const archive = release.assets.find((asset) => asset.name === archiveName);
  const sums = release.assets.find((asset) => asset.name === "SHA256SUMS.txt");
  if (!archive) {
    throw new Error(`Tunnel-client release ${version} does not contain ${archiveName}`);
  }
  if (!sums) {
    throw new Error(`Tunnel-client release ${version} does not contain SHA256SUMS.txt`);
  }
  return { archive, sums };
}


async function fetchWithDeadline(url: string, signal: AbortSignal | undefined, headers: Record<string, string>): Promise<Response> {
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    headers: { "User-Agent": "pi-tools-mcp", ...headers },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  return response;
}

async function readResponseBytes(response: Response, maximum: number, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maximum) throw new Error(`${label} exceeds the download limit.`);
  if (!response.body) throw new Error(`${label} response has no body.`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error(`${label} exceeds the download limit.`);
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function assertOfficialDownloadUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || !url.pathname.startsWith("/openai/tunnel-client/releases/download/")) {
    throw new Error("Tunnel release metadata points outside the official OpenAI release path.");
  }
}

function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const groups = /^(?<sha>[a-fA-F0-9]{64})\s+\*?(?<name>[^\s].*)$/.exec(line.trim())?.groups;
    const sha = groups?.sha;
    const name = groups?.name;
    if (sha && name) sums.set(name, sha.toLowerCase());
  }
  if (sums.size === 0) throw new Error("Vendor SHA256SUMS is malformed or empty");
  return sums;
}

function extractBinary(archiveName: string, archiveBytes: Buffer, executableName: string): ExtractedBinary {
  if (archiveName.endsWith(".zip")) {
    return extractZipBinary(archiveBytes, executableName);
  }
  if (archiveName.endsWith(".tar.gz") || archiveName.endsWith(".tgz")) {
    return extractTarGzBinary(archiveBytes, executableName);
  }
  throw new Error(`Unsupported tunnel-client archive format: ${archiveName}`);
}

function extractZipBinary(archiveBytes: Buffer, executableName: string): ExtractedBinary {
  let entriesSeen = 0;
  const entries = unzipSync(new Uint8Array(archiveBytes), { filter: (entry) => {
    entriesSeen += 1;
    if (entriesSeen > 512) throw new Error("Archive contains too many entries.");
    assertSafeArchivePath(entry.name);
    if (path.posix.basename(entry.name) !== executableName) return false;
    if (entry.originalSize > MAX_BINARY_BYTES) throw new Error("Tunnel binary exceeds the extraction limit.");
    return true;
  } });
  let found: Buffer | undefined;
  for (const bytes of Object.values(entries)) {
    if (found) throw new Error(`Archive contains multiple ${executableName} entries`);
    found = Buffer.from(bytes);
  }
  if (!found || found.length === 0) {
    throw new Error(`Archive does not contain executable ${executableName}`);
  }
  return { bytes: found, executableName };
}

function extractTarGzBinary(archiveBytes: Buffer, executableName: string): ExtractedBinary {
  const tar = gunzipSync(archiveBytes, { maxOutputLength: MAX_ARCHIVE_BYTES });
  let offset = 0;
  let found: Buffer | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const entryName = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeText = readTarString(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    const typeFlag = readTarString(header, 156, 1) || "0";
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Malformed tar entry size for ${entryName}`);
    }
    assertSafeArchivePath(entryName);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error(`Malformed tar entry ${entryName}: data exceeds archive size`);
    }
    if ((typeFlag === "0" || typeFlag === "") && path.posix.basename(entryName) === executableName) {
      if (found) throw new Error(`Archive contains multiple ${executableName} entries`);
      found = Buffer.from(tar.subarray(dataStart, dataEnd));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!found || found.length === 0) {
    throw new Error(`Archive does not contain executable ${executableName}`);
  }
  return { bytes: found, executableName };
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);
  const actualEnd = end === -1 || end > offset + length ? offset + length : end;
  return buffer.toString("utf8", offset, actualEnd);
}

function assertSafeArchivePath(entryName: string): void {
  const normalized = entryName.replace(/\\/g, "/");
  const withoutTrailingSlash = normalized.replace(/\/+$/, "");
  if (!withoutTrailingSlash || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`Unsafe archive path: ${entryName}`);
  }
  for (const part of withoutTrailingSlash.split("/")) {
    if (part === ".." || part === "") {
      throw new Error(`Unsafe archive path: ${entryName}`);
    }
  }
}

function sha256(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
