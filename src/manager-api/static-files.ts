import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Serves the built UI; unknown extension-less paths fall back to index.html (SPA routing). */
export async function serveStatic(
  root: string,
  pathname: string,
  response: ServerResponse,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400, SECURITY_HEADERS).end("Bad request");
    return;
  }
  const relative = normalize(decoded).replace(/^[/\\]+/, "");
  let file = join(root, relative || "index.html");
  const inside = file === root || file.startsWith(root + sep);
  if (decoded.includes("\0") || !inside) {
    response.writeHead(404, SECURITY_HEADERS).end("Not found");
    return;
  }
  if (!(await isFile(file))) {
    if (extname(relative)) {
      response.writeHead(404, SECURITY_HEADERS).end("Not found");
      return;
    }
    file = join(root, "index.html");
    if (!(await isFile(file))) {
      response
        .writeHead(503, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" })
        .end("The web UI is not built. Run npm run build.");
      return;
    }
  }
  const extension = extname(file).toLowerCase();
  const immutable = file.includes(`${sep}assets${sep}`);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": TYPES[extension] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
  });
  response.end(await readFile(file));
}
