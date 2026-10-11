import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "wtm_session";

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/** Hostnames a browser may legitimately use to reach the loopback server. */
const hosts = (port: number): string[] => [
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  `[::1]:${port}`,
];

/** Rejects DNS-rebinding: the Host header must name this loopback server. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host !== undefined && hosts(port).includes(host.toLowerCase());
}

/** Mutating requests must come from the UI's own origin. */
export function isSameOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  return hosts(port).some((host) => origin.toLowerCase() === `http://${host}`);
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`;
}
