# workspace-tools-mcp

A local MCP server exposing Pi's built-in coding tools directly to ChatGPT Web and other MCP clients. ChatGPT remains the agent; this project does not run a second model or reimplement Pi's tool behavior.

## Requirements

- Node.js >= 22.19.0
- OpenAI Secure MCP Tunnel ID and runtime key with Tunnels Read + Use permission
- ChatGPT account/workspace permission to add a custom MCP app

## Install and run

```bash
npm install     # also installs the web UI dependencies
npm run build   # compiles the server and builds the web UI into dist/web
npm start
```

`npm start` starts the manager and opens its **web UI** in your browser (the link is also printed in the terminal). Each **instance** has its own name, workspace folder, OpenAI Tunnel ID and API key, and runs as a separate worker process with its own loopback MCP endpoint and tunnel. Use one instance per ChatGPT account/workspace; several can run side by side.

In the UI you can add, edit and delete instances, start or stop each one (or all), pick the workspace folder with a folder browser, copy the MCP URL, and watch live logs. `Quit` (or Ctrl+C in the terminal) stops every instance and exits. Running `npm start` again while a manager is already running just reopens it.

Instances are stored in `~/.config/workspace-tools-mcp/config.json` with a private `0600` file mode, including API keys. API keys are write-only in the UI: they are never sent back to the browser, and logs are redacted. Files from earlier single-instance releases are migrated automatically to one instance named `default`. Editing a running instance saves the new settings but they apply the next time it starts.

```bash
npm start -- --port 4800       # fixed UI port (default 4747; a busy default falls back to a free port)
npm start -- --no-open         # do not open the browser
npm start -- --headless        # no UI: start all saved instances, logs on stderr (for services and CI)
npm start -- --headless --instance work
npm start -- --local-only      # loopback MCP only, no OpenAI tunnels
npm start -- --reset           # delete saved settings and exit
```

**The web UI controls instances that give the connected ChatGPT account full shell and filesystem access, so it is locked down:** it binds to `127.0.0.1` only, requires a random per-launch token (the first visit exchanges the link's token for an `HttpOnly`, `SameSite=Strict` cookie), rejects foreign `Host` headers (DNS rebinding) and cross-origin or non-JSON changes, and sends a strict Content-Security-Policy. Anyone who can read the link printed in your terminal can control the manager, so do not share it. Headless mode (`--headless`) has no UI and no listener.

Each idle worker uses roughly 150 MB of RSS on Node (measured on macOS arm64); plan memory per running instance.

### Developing the UI

The UI lives in `web/` (Vite, React, TypeScript, Tailwind, shadcn/ui). Run the manager with a fixed port and no browser, open the printed link once (it sets the session cookie), then use the Vite dev server, which proxies `/api` to the manager:

```bash
npm run dev -- --port 4747 --no-open    # terminal 1: manager (tsx), prints the link
npm run dev:web                          # terminal 2: Vite on http://127.0.0.1:5173
```

## Environment

| Variable | Purpose |
| --- | --- |
| `WORKSPACE_TOOLS_CONFIG_FILE` | Optional saved-config path; defaults to `~/.config/workspace-tools-mcp/config.json` |
| `WORKSPACE_TOOLS_CACHE_DIR` | Optional cache root; defaults to the saved `cacheDir`, then `~/.cache/workspace-tools-mcp` |

The manager passes each worker its workspace, tunnel ID and key through that worker's environment only (never argv) and the worker removes the key from its own environment before any tool runs. The tunnel client is downloaded once by the manager and shared by all workers. Never commit credentials.

## Tools and permission model

| Tool | Behavior |
| --- | --- |
| `read` | Text/images, offset/limit, Pi truncation |
| `bash` | Arbitrary shell commands, timeout, merged output, exit code and wall time |
| `edit` | Exact unique replacement using `edits: [{oldText, newText}]` |
| `write` | Create/overwrite files |
| `grep` | Content search using Pi's ripgrep integration |
| `find` | Glob search using Pi's fd integration |
| `ls` | Directory listing |
| `powershell` | Additionally exposed on Windows |

All tools use the pinned `@earendil-works/pi-coding-agent@1.1.0` factories directly. The MCP adapter preserves content/images and errors; Pi primitive structured results are wrapped in `{result: ...}` because MCP requires an object. Object outputs such as `bash` remain objects. Pi details are available in `_meta["workspace-tools-mcp/details"]`. Progress-capable MCP clients receive shell updates when they provide a progress token.

Read-only annotations apply to `read`, `grep`, `find`, and `ls`; write/destructive annotations apply to the other tools. ChatGPT controls its own approvals and rendering.

**Full permissions are intentional.** There is no tool allowlist, denylist, path jail, or command sandbox. `WORKSPACE_ROOT` is a working directory, not a security boundary; absolute paths and `..` keep Pi behavior. A caller with `bash` can inspect same-user processes, credentials, and files, including the tunnel process environment. Only connect trusted clients and use a dedicated low-scope runtime key. Revoke the key after testing.

No separate app authentication is added. Tunnel organization/workspace association is the remote access boundary. Loopback clients on this machine can call the server too.

## High-concurrency behavior

The runtime is tuned for **1,000 concurrently initialized trusted sessions** on one machine under a staged connection ramp. This is a steady-state target for shared-session usage, not a guarantee for 1,000 simultaneous TCP handshakes, long-running builds, or untrusted users.

- Default initialized-session cap: **1,024**. New initialize requests above the cap receive HTTP `429` with `Retry-After: 1` before a new MCP server is allocated.
- Idle initialized sessions are reclaimed after **10 minutes** when they have no active response or tool call. Clients should close sessions explicitly when finished.
- File-oriented tools are bounded at **128** active operations; process-heavy tools (`bash`, `powershell`, `grep`, `find`) at **16** active operations, with bounded queues. Saturated tool calls return a retryable MCP error instead of spawning unbounded child processes.
- Request body buffering is bounded globally; HTTP keep-alive and request timeout settings are explicit. OS listen backlog remains a kernel limit and is measured separately.
- Every session still shares the same workspace, operating-system account, and full Pi permissions.

Reproduce the local staged benchmark after building:

```bash
npm run benchmark -- --sessions 1000 --ramp 32 --seconds 30 --active 100 --shell 8
```

The benchmark runs the server and load generator in separate processes. It reports initialized sessions, failures by cause, initialization time, throughput, p50/p95/p99 latency, server-only event-loop delay and memory, and health. No requests are retried automatically. Treat its output as machine-specific evidence, not a universal capacity claim.

## OpenAI Secure MCP Tunnel

1. Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels); create/select a tunnel and associate it with the target ChatGPT workspace.
2. Create a runtime API key with Tunnels Read + Use permission. Do not use an admin key.
3. Run `npm start`, add an instance in the web UI with its workspace, tunnel ID and key, and click Start.
4. The app verifies local MCP readiness, downloads/caches the official tunnel client, creates a separate runtime profile containing only an environment reference for the key, and starts the tunnel process.
5. Wait for the printed **OpenAI tunnel ready** state. In [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add → Add custom MCP server → Tunnel**. Enter the same tunnel ID, choose **No authentication** if available for this intentionally tunnel-only server, review its full permissions, and create the plugin.
6. Start a new chat and select the plugin. Ask it to list files or edit a disposable fixture. Keep the manager (or headless process) running for discovery and calls.

Account plan, workspace policy, tunnel associations, and permission restrictions are controlled by OpenAI. Do not bypass them. Tool changes may require **Refresh** in ChatGPT.

Reference: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [custom MCP connection](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Download and cache

Each launch queries the official stable latest [OpenAI tunnel-client release](https://github.com/openai/tunnel-client/releases/latest). The archive is verified against its official `SHA256SUMS.txt` before extracting the executable. Cache hits verify the extracted binary against the saved checksum.

```text
~/.cache/workspace-tools-mcp/tunnel-client/<version>/<platform>-<arch>/
```

`WORKSPACE_TOOLS_CACHE_DIR` overrides the root. Runtime profiles are isolated under `<cache>/runtime/` and removed during normal shutdown. Keys are never placed in argv or profiles; tunnel logs are redacted. The tunnel receives its runtime key explicitly through an environment reference.

Supported download targets: macOS arm64/amd64, Linux arm64/amd64, Windows amd64. Native Windows execution additionally needs the shells required by the Pi SDK. Native execution is verified on macOS arm64; other platform runtimes require their own smoke verification.

## Verification

```bash
npm run build
npm test
npm start -- --local-only
```

The suite exercises actual Pi tools over loopback Streamable HTTP, file writes/edits/searches, protocol errors, process cleanup, streamed redaction, verified download/cache reuse, checksum rejection, saved-config behavior, session admission, and bounded tool capacity.

A real ChatGPT end-to-end test requires a valid runtime key and tunnel ID. Local smoke does not prove remote connectivity.

## Troubleshooting

- **No instances in headless mode:** run `npm start`, add instances in the web UI, then use `--headless`; it only starts saved ones.
- **Invalid workspace:** choose an existing directory, not a file.
- **Want to change credentials:** click Edit on the instance (leave the key empty to keep it), or `npm start -- --reset` to start over.
- **Instance shows error:** select it to see its logs; a worker that exits unexpectedly or a failed tunnel start is reported there. Click Start to try again.
- **MCP capacity reached:** wait for active sessions/tools to finish, close unused client sessions, or tune deployment options in the embedding API. A `429`/retryable tool response is intentional backpressure.
- **Checksum failure:** the download is refused; retry via the official release channel. Do not bypass checksum verification.
- **Tunnel readiness timeout:** check the redacted diagnostics, key's Tunnels Read + Use permissions, and workspace associations. Startup is not treated as ready based only on process creation.
- **ChatGPT cannot scan:** keep the app running and choose Tunnel, not the localhost URL. Check OpenAI workspace permissions.
- **Tool metadata changed:** refresh the plugin and start a new chat.
- **Find/grep unavailable:** Pi may need to acquire fd/ripgrep on first use; check outbound networking and Pi's tool cache.
- **Quit:** the Quit button or Ctrl+C stops every worker, which stops its tunnel and aborts active tools before closing MCP and removing runtime files.
