import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig, type InstanceConfig } from "../config.js";
import type { InstanceManager } from "../instance-manager.js";
import {
  addInstance,
  removeInstance,
  updateInstance,
  type InstanceInput,
} from "../instances.js";
import type { EventHub } from "./events.js";
import { listDirectories } from "./fs-browser.js";
import { HttpError, readJsonBody, sendJson } from "./http-utils.js";
import { toView } from "./views.js";

export interface ApiContext {
  manager: InstanceManager;
  configPath: string;
  hub: EventHub;
  localOnly: boolean;
  version: string;
  homeDir: string;
  requestShutdown(): void;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function parseInput(body: Record<string, unknown>, apiKeyRequired: boolean): InstanceInput {
  const { name, workspaceRoot, tunnelId, apiKey } = body;
  if (
    typeof name !== "string" ||
    typeof workspaceRoot !== "string" ||
    typeof tunnelId !== "string" ||
    (apiKey !== undefined && typeof apiKey !== "string") ||
    (apiKeyRequired && typeof apiKey !== "string")
  )
    throw new HttpError(400, "Invalid request body.");
  return { name, workspaceRoot, tunnelId, apiKey: text(apiKey) };
}

/** Add/update failures carry user-readable validation messages; surface them as 400. */
async function validated<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error: unknown) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid request.");
  }
}

export async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ApiContext,
): Promise<void> {
  const { manager, configPath, hub } = context;
  const method = request.method ?? "GET";
  const [, , resource, id, action] = url.pathname.split("/");
  const instances = async (): Promise<InstanceConfig[]> => (await loadConfig(configPath)).instances;
  const views = async () => (await instances()).map((o) => toView(o, manager));
  const find = async (): Promise<InstanceConfig> => {
    const found = (await instances()).find((o) => o.id === id);
    if (!found) throw new HttpError(404, "Instance not found.");
    return found;
  };
  const announce = async (): Promise<void> => hub.broadcast({ type: "instances", instances: await views() });

  if (method === "GET" && resource === "state" && !id) {
    return sendJson(response, 200, {
      instances: await views(),
      localOnly: context.localOnly,
      homeDir: context.homeDir,
      version: context.version,
    });
  }
  if (method === "GET" && resource === "events") return hub.add(response);
  if (method === "GET" && resource === "fs") {
    return sendJson(response, 200, await listDirectories(url.searchParams.get("path") || context.homeDir));
  }
  if (resource === "instances" && !id && method === "POST") {
    const input = parseInput(await readJsonBody(request), true);
    const created = await validated(() => addInstance(configPath, input));
    await announce();
    return sendJson(response, 201, toView(created, manager));
  }
  if (resource === "instances" && id && !action) {
    if (method === "PUT") {
      const current = await find();
      const input = parseInput(await readJsonBody(request), false);
      const updated = await validated(() => updateInstance(configPath, current.id, input));
      await announce();
      return sendJson(response, 200, toView(updated, manager));
    }
    if (method === "DELETE") {
      const current = await find();
      await manager.stop(current.id);
      await removeInstance(configPath, current.id);
      await announce();
      return sendJson(response, 204);
    }
  }
  if (resource === "instances" && id && action === "logs" && method === "GET") {
    const current = await find();
    return sendJson(response, 200, { lines: [...manager.logs(current.id)] });
  }
  if (resource === "instances" && id && method === "POST" && (action === "start" || action === "stop")) {
    const current = await find();
    // Start/stop can take seconds; progress reaches the UI through status events.
    const work = action === "start" ? manager.start(current) : manager.stop(current.id);
    void work.catch(() => undefined);
    return sendJson(response, 200, toView(current, manager));
  }
  if (method === "POST" && (resource === "start-all" || resource === "stop-all") && !id) {
    const all = await instances();
    for (const instance of all) {
      if (resource === "stop-all") void manager.stop(instance.id).catch(() => undefined);
      else if (!manager.isActive(instance.id)) void manager.start(instance).catch(() => undefined);
    }
    return sendJson(response, 204);
  }
  if (method === "POST" && resource === "shutdown" && !id) {
    sendJson(response, 202, { ok: true });
    context.requestShutdown();
    return;
  }
  throw new HttpError(404, "Not found.");
}
