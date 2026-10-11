import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, platform, arch, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

if (process.argv[2] === "--server") {
  const { startMcpServer } = await import("../dist/mcp-server.js");
  const delay = monitorEventLoopDelay({ resolution: 10 });
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  const cpuStart = process.cpuUsage();
  const server = await startMcpServer(process.argv[3]);
  delay.enable();
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);
  const sample = () => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    return {
      rssMiB: memory.rss / 1048576,
      peakRssMiB: peakRss / 1048576,
      heapMiB: memory.heapUsed / 1048576,
      externalMiB: memory.external / 1048576,
      baselineRssMiB: baseline.rss / 1048576,
      eventLoopP99Ms: delay.percentile(99) / 1e6,
      cpuMicroseconds: process.cpuUsage(cpuStart),
    };
  };
  process.on("message", async ({ id, action }) => {
    if (action === "sample") process.send?.({ id, metrics: sample() });
    else if (action === "stop") {
      clearInterval(sampler);
      delay.disable();
      await server.close();
      process.send?.({ id, metrics: sample() });
      process.disconnect();
    }
  });
  process.on("disconnect", () => {
    clearInterval(sampler);
    void server.close();
  });
  process.send?.({ ready: true, url: server.url });
} else {
  const { values } = parseArgs({
    options: {
      sessions: { type: "string", default: "1000" },
      ramp: { type: "string", default: "32" },
      seconds: { type: "string", default: "30" },
      active: { type: "string", default: "100" },
      shell: { type: "string", default: "0" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: npm run benchmark -- --sessions 1000 --ramp 32 --seconds 30 --active 100 [--shell 8]\nHolds all sessions open, repeatedly calls read with the selected active concurrency, optionally runs harmless shell calls in parallel. No retries. Server and load generator run in separate processes; JSON reports server-only resource use. --ramp 1000 is an unpaced burst test, not steady-state CCU.",
    );
    process.exit(0);
  }
  const number = (key, minimum) => {
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error(`${key} must be an integer >= ${minimum}`);
    return value;
  };
  const sessions = number("sessions", 1);
  const ramp = number("ramp", 1);
  const seconds = number("seconds", 1);
  const active = number("active", 1);
  const shell = number("shell", 0);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const root = await mkdtemp(join(tmpdir(), "workspace-tools-benchmark-"));
  const clients = [];
  const initialization = [];
  const latency = [];
  const shellLatency = [];
  const errors = {};
  let ready;
  let worker;
  let exit;
  const pending = new Map();
  let sequence = 0;
  const recordError = (stage, error) => {
    const cause =
      error?.cause?.code ?? error?.code ?? error?.message ?? String(error);
    const key = `${stage}: ${cause}`;
    errors[key] = (errors[key] ?? 0) + 1;
  };
  const rpc = (action) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Worker ${action} timed out`));
      }, 30_000);
      pending.set(id, { resolve, reject, timer });
      worker.send({ id, action });
    });
  const distribution = (samples) => {
    samples.sort((a, b) => a - b);
    const p = (n) =>
      samples[Math.min(samples.length - 1, Math.floor(samples.length * n))] ??
      null;
    return {
      count: samples.length,
      p50Ms: p(0.5),
      p95Ms: p(0.95),
      p99Ms: p(0.99),
      maxMs: samples.at(-1) ?? null,
    };
  };
  try {
    await writeFile(
      join(root, "fixture.txt"),
      "workspace-tools-benchmark-fixture\n",
    );
    worker = fork(fileURLToPath(import.meta.url), ["--server", root], {
      execArgv: [],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const waiting = Promise.withResolvers();
    const timer = setTimeout(
      () => waiting.reject(new Error("Benchmark server startup timed out")),
      30_000,
    );
    exit = new Promise((resolve) =>
      worker.once("exit", (code, signal) => {
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error(`Worker exited: ${code ?? signal}`));
        }
        pending.clear();
        waiting.reject(
          new Error(`Worker exited before ready: ${code ?? signal}`),
        );
        resolve({ code, signal });
      }),
    );
    worker.once("error", waiting.reject);
    worker.on("message", (message) => {
      if (message.ready) waiting.resolve(message);
      else {
        const entry = pending.get(message.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(message.id);
          entry.resolve(message.metrics);
        }
      }
    });
    try {
      ready = await waiting.promise;
    } finally {
      clearTimeout(timer);
    }
    const began = performance.now();
    for (let offset = 0; offset < sessions; offset += ramp) {
      await Promise.all(
        Array.from(
          { length: Math.min(ramp, sessions - offset) },
          async (_, n) => {
            const client = new Client({
              name: `benchmark-${offset + n}`,
              version: "1.0.0",
            });
            const transport = new StreamableHTTPClientTransport(
              new URL(ready.url),
            );
            const start = performance.now();
            try {
              await client.connect(transport);
              // A ping confirms the initialized route before the session is counted as live.
              await client.ping();
              clients.push({ client, transport });
              initialization.push(performance.now() - start);
            } catch (error) {
              recordError("initialize", error);
              await transport.terminateSession().catch(() => undefined);
              await client.close().catch(() => undefined);
            }
          },
        ),
      );
    }
    const initializeMs = performance.now() - began;
    const held = await rpc("sample");
    const start = performance.now();
    const end = start + seconds * 1000;
    let next = 0;
    const readers = Array.from(
      { length: Math.min(active, clients.length) },
      async () => {
        while (performance.now() < end) {
          const { client } = clients[next++ % clients.length];
          const begin = performance.now();
          try {
            const result = await client.callTool({
              name: "read",
              arguments: { path: "fixture.txt" },
            });
            if (
              result.isError ||
              !result.content.some(
                (item) =>
                  item.type === "text" &&
                  item.text.includes("workspace-tools-benchmark-fixture"),
              )
            )
              throw new Error("Invalid read result");
            latency.push(performance.now() - begin);
          } catch (error) {
            recordError("read", error);
          }
        }
      },
    );
    const processLoad = Array.from(
      { length: Math.min(shell, clients.length) },
      async (_, n) => {
        const { client } = clients[n];
        while (performance.now() < end) {
          const begin = performance.now();
          try {
            const result = await client.callTool({
              name: "bash",
              arguments: { command: "printf benchmark-shell-ok", timeout: 5 },
            });
            if (
              result.isError ||
              !result.content.some(
                (item) =>
                  item.type === "text" &&
                  item.text.includes("benchmark-shell-ok"),
              )
            )
              throw new Error("Invalid shell result");
            shellLatency.push(performance.now() - begin);
          } catch (error) {
            recordError("shell", error);
          }
        }
      },
    );
    await Promise.all([...readers, ...processLoad]);
    const durationMs = performance.now() - start;
    const loaded = await rpc("sample");
    const healthResponse = await fetch(ready.url.replace("/mcp", "/healthz"));
    await healthResponse.text();
    for (let offset = 0; offset < clients.length; offset += ramp) {
      await Promise.all(
        clients
          .slice(offset, offset + ramp)
          .map(async ({ client, transport }) => {
            try {
              await transport.terminateSession();
            } catch (error) {
              recordError("delete", error);
            }
            await client.close();
          }),
      );
    }
    clients.length = 0;
    const afterDelete = await rpc("sample");
    console.log(
      JSON.stringify(
        {
          environment: {
            node: process.version,
            os: platform(),
            arch: arch(),
            cpus: cpus().length,
          },
          workload: {
            requestedSessions: sessions,
            connectedSessions: initialization.length,
            ramp,
            activeReads: active,
            activeShellCalls: shell,
            seconds,
            retries: 0,
          },
          initializeMs,
          initialization: distribution(initialization),
          durationMs,
          readsPerSecond: latency.length / (durationMs / 1000),
          reads: distribution(latency),
          shell: distribution(shellLatency),
          errors,
          healthStatus: healthResponse.status,
          serverOnly: { held, loaded, afterDelete },
        },
        null,
        2,
      ),
    );
    if (
      initialization.length !== sessions ||
      Object.keys(errors).length ||
      healthResponse.status !== 200
    )
      process.exitCode = 1;
  } finally {
    await Promise.all(
      clients.map(async ({ client, transport }) => {
        await transport.terminateSession().catch(() => undefined);
        await client.close().catch(() => undefined);
      }),
    );
    if (worker?.connected) await rpc("stop");
    if (worker) {
      const timer = setTimeout(() => worker.kill("SIGKILL"), 5_000);
      try {
        await exit;
      } finally {
        clearTimeout(timer);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}
