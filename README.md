# workspace-tools-mcp

A local MCP server exposing Pi's built-in coding tools directly to ChatGPT Web and other MCP clients. ChatGPT remains the agent; this project does not run a second model or reimplement Pi's tool behavior.

## Requirements

- Node.js >= 22.19.0
- OpenAI Secure MCP Tunnel ID and runtime key with Tunnels Read + Use permission
- ChatGPT account/workspace permission to add a custom MCP app

## Install and run

```bash
npm install
npm run build
npm start
```

On the first run, the CLI asks for:

1. **Workspace folder** — an existing directory used as Pi's working directory.
2. **OpenAI Tunnel ID** — the tunnel to expose the local MCP endpoint.
3. **OpenAI API key** — the runtime key used by the official tunnel client.

The values are stored locally in `~/.config/workspace-tools-mcp/config.json`, with a private `0600` file mode. Subsequent launches reuse them without prompting. Use `--reset` to delete the saved settings and run setup again:

```bash
npm start -- --reset
```

The API key prompt is hidden. The local endpoint is printed as `http://127.0.0.1:<port>/mcp`; it binds only to loopback. Press Ctrl+C for graceful shutdown.

For local diagnostics without OpenAI:

```bash
npm start -- --local-only
```

## Environment overrides

Environment values take precedence over saved settings. This is useful for CI or one-off runs.

| Variable | Purpose |
| --- | --- |
| `WORKSPACE_ROOT` | Existing directory used as Pi's working directory |
| `OPENAI_TUNNEL_ID` | OpenAI tunnel ID; required unless local-only |
| `OPENAI_API_KEY` | OpenAI Secure MCP Tunnel runtime key; required unless local-only |
| `WORKSPACE_TOOLS_CONFIG_FILE` | Optional saved-config path; defaults to `~/.config/workspace-tools-mcp/config.json` |
| `WORKSPACE_TOOLS_CACHE_DIR` | Optional cache root; defaults to `~/.cache/workspace-tools-mcp` |

Export the variables or run `node --env-file=.env dist/index.js`. `.env.example` contains variable names only. Never commit `.env` or credentials.

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
3. Run `npm start` and enter the workspace, tunnel ID, and key, or export the environment variables.
4. The app verifies local MCP readiness, downloads/caches the official tunnel client, creates a separate runtime profile containing only an environment reference for the key, and starts the tunnel process.
5. Wait for the printed **OpenAI tunnel ready** state. In [ChatGPT Plugins](https://chatgpt.com/plugins), choose **Add → Add custom MCP server → Tunnel**. Enter the same tunnel ID, choose **No authentication** if available for this intentionally tunnel-only server, review its full permissions, and create the plugin.
6. Start a new chat and select the plugin. Ask it to list files or edit a disposable fixture. Keep `npm start` running for discovery and calls.

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

- **Missing configuration in noninteractive mode:** set all required environment variables; prompts need a TTY.
- **Invalid workspace:** choose an existing directory, not a file.
- **Want to change credentials:** run `npm start -- --reset` or override with environment variables.
- **MCP capacity reached:** wait for active sessions/tools to finish, close unused client sessions, or tune deployment options in the embedding API. A `429`/retryable tool response is intentional backpressure.
- **Checksum failure:** the download is refused; retry via the official release channel. Do not bypass checksum verification.
- **Tunnel readiness timeout:** check the redacted diagnostics, key's Tunnels Read + Use permissions, and workspace associations. Startup is not treated as ready based only on process creation.
- **ChatGPT cannot scan:** keep the app running and choose Tunnel, not the localhost URL. Check OpenAI workspace permissions.
- **Tool metadata changed:** refresh the plugin and start a new chat.
- **Find/grep unavailable:** Pi may need to acquire fd/ripgrep on first use; check outbound networking and Pi's tool cache.
- **Ctrl+C:** the app stops the tunnel and aborts active tools before closing MCP and removing runtime files.
