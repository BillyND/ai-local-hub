import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InstanceManager } from "../src/instance-manager.js";

// Exercises the production worker bundle (dist/worker.mjs, built by npm run build) end to end:
// the bundle drops most of the Pi SDK, so every tool must still work.
const worker = new URL("../dist/worker.mjs", import.meta.url).pathname;
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Solid-color RGB PNG; large dimensions force Pi to resize through Photon (wasm) in its worker. */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x7f);
  for (let y = 0; y < height; y += 1) rows[y * (width * 3 + 1)] = 0; // filter type 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Content = { type: string; text?: string; data?: string; mimeType?: string };
const textOf = (result: unknown): string =>
  ((result as { content: Content[] }).content ?? []).map((c) => c.text ?? "").join("");

test("the bundled worker serves every tool", { skip: !existsSync(worker) && "dist/worker.mjs not built" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-bundle-"));
  const manager = new InstanceManager({ cacheDir: root, localOnly: true, entryScript: worker });
  const client = new Client({ name: "bundle-smoke", version: "1.0.0" });
  try {
    const id = "bundle";
    await manager.start({ id, name: id, workspaceRoot: root, tunnelId: "t", apiKey: "k" });
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker did not start: ${manager.status(id).error ?? manager.status(id).state}`)), 30_000);
      const check = (): void => {
        const status = manager.status(id);
        if (status.state === "error") return void reject(new Error(status.error));
        if (status.state === "running" && status.url) {
          clearTimeout(timer);
          manager.removeListener("change", check);
          resolve(status.url);
        }
      };
      manager.on("change", check);
      check();
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(names, ["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    await call("write", { path: "notes/a.txt", content: "alpha\nneedle here\nomega\n" });
    assert.match(textOf(await call("read", { path: "notes/a.txt" })), /needle here/);
    await call("edit", { path: "notes/a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] });
    assert.equal(await readFile(join(root, "notes", "a.txt"), "utf8"), "ALPHA\nneedle here\nomega\n");
    assert.match(textOf(await call("ls", { path: "notes" })), /a\.txt/);
    assert.match(textOf(await call("bash", { command: "echo from-bundle" })), /from-bundle/);
    assert.match(textOf(await call("grep", { pattern: "needle" })), /a\.txt/);
    assert.match(textOf(await call("find", { pattern: "*.txt" })), /a\.txt/);

    await call("bash", { command: `printf '%s' '${PNG_1X1}' | base64 -d > pic.png` });
    const image = (await call("read", { path: "pic.png" })) as { content: Content[] };
    assert.ok(image.content.some((c) => c.type === "image"), "images are returned as image content");

    await writeFile(join(root, "big.png"), solidPng(3000, 2500));
    const big = (await call("read", { path: "big.png" })) as { content: Content[] };
    const bigImage = big.content.find((c) => c.type === "image");
    assert.ok(bigImage?.data, "oversized images are still returned");
    const width = Buffer.from(bigImage.data, "base64").readUInt32BE(16);
    assert.ok(width > 0 && width < 3000, `oversized image was resized by Photon (width ${width})`);
  } finally {
    await client.close().catch(() => undefined);
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
