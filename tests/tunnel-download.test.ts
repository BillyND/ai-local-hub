import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { zipSync } from "fflate";
import { ensureTunnelClient } from "../src/tunnel-download.js";

const originalFetch = globalThis.fetch;
const VERSION = "v9.8.7";
const SUMS_NAME = "SHA256SUMS.txt";

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("refuses an archive when vendor SHA256SUMS does not match", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "tunnel-download-test-"));
  try {
    const fixture = buildFixture("sha mismatch");
    installMockFetch(fixture, {
      sumsText: `${"0".repeat(64)}  ${fixture.archiveName}\n`,
    });

    await assert.rejects(ensureTunnelClient(cacheDir), /SHA256 mismatch/);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("reuses a valid cached binary without fetching the archive again", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "tunnel-download-test-"));
  try {
    const fixture = buildFixture("cache reuse");
    const calls = installMockFetch(fixture);

    const installed = await ensureTunnelClient(cacheDir);
    const reused = await ensureTunnelClient(cacheDir);

    assert.equal(installed.cached, false);
    assert.equal(reused.cached, true);
    assert.equal(reused.path, installed.path);
    assert.equal(calls.get(fixture.archiveUrl), 1);
    assert.equal(calls.get(fixture.sumsUrl), 1);
    assert.equal(
      calls.get(
        "https://api.github.com/repos/openai/tunnel-client/releases/latest",
      ),
      2,
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("repairs a corrupt cached binary with a verified download", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "tunnel-download-test-"));
  try {
    const fixture = buildFixture("healthy binary");
    const calls = installMockFetch(fixture);
    const installed = await ensureTunnelClient(cacheDir);

    await writeFile(installed.path, "corrupted binary");
    const repaired = await ensureTunnelClient(cacheDir);

    assert.equal(repaired.cached, false);
    assert.equal(await readFile(repaired.path, "utf8"), "healthy binary");
    assert.equal(calls.get(fixture.archiveUrl), 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("rejects malformed release metadata before downloading assets", async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), "tunnel-download-test-"));
  try {
    let assetFetches = 0;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("/download/")) assetFetches += 1;
      return jsonResponse({ tag_name: VERSION });
    };

    await assert.rejects(
      ensureTunnelClient(cacheDir),
      /missing tag_name or assets/,
    );
    assert.equal(assetFetches, 0);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

interface Fixture {
  archiveName: string;
  archiveUrl: string;
  sumsUrl: string;
  archiveBytes: Uint8Array;
  archiveSha256: string;
}

function buildFixture(binaryText: string): Fixture {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const executableName =
    platform === "windows" ? "tunnel-client.exe" : "tunnel-client";
  const archiveName = `tunnel-client-${VERSION}-${platform}-${arch}.zip`;
  const archiveBytes = zipSync({
    [`tunnel-client-${VERSION}/${executableName}`]: new TextEncoder().encode(
      binaryText,
    ),
  });
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  return {
    archiveName,
    archiveUrl: `https://github.com/openai/tunnel-client/releases/download/${VERSION}/${archiveName}`,
    sumsUrl: `https://github.com/openai/tunnel-client/releases/download/${VERSION}/SHA256SUMS.txt`,
    archiveBytes,
    archiveSha256,
  };
}

function installMockFetch(
  fixture: Fixture,
  options: { sumsText?: string } = {},
): Map<string, number> {
  const calls = new Map<string, number>();
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = input.toString();
    calls.set(url, (calls.get(url) ?? 0) + 1);
    if (
      url ===
      "https://api.github.com/repos/openai/tunnel-client/releases/latest"
    ) {
      return jsonResponse({
        tag_name: VERSION,
        assets: [
          { name: SUMS_NAME, browser_download_url: fixture.sumsUrl },
          {
            name: fixture.archiveName,
            browser_download_url: fixture.archiveUrl,
          },
        ],
      });
    }
    if (url === fixture.sumsUrl) {
      return textResponse(
        options.sumsText ??
          `${fixture.archiveSha256}  ${fixture.archiveName}\n`,
      );
    }
    if (url === fixture.archiveUrl) {
      return bytesResponse(fixture.archiveBytes);
    }
    return new Response("not found", { status: 404, statusText: "Not Found" });
  };
  return calls;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

function bytesResponse(body: Uint8Array): Response {
  return new Response(Buffer.from(body), {
    status: 200,
    headers: { "Content-Type": "application/zip" },
  });
}
