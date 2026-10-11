import { spawn } from "node:child_process";

/** Opens a URL in the default browser; failures are ignored (the URL is also printed). */
export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* no browser available */
  }
}
