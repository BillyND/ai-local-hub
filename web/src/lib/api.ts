import type {
  FsListing,
  InstanceInput,
  InstanceView,
  ManagerState,
} from "@/lib/types";

let unauthorizedHandler: (() => void) | null = null;

/** Registers a callback invoked whenever the API answers 401. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error("Session expired");
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (typeof data.error === "string" && data.error) message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  if (res.status === 204 || res.status === 202) {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  getState: () => request<ManagerState>("GET", "/state"),
  createInstance: (input: InstanceInput) =>
    request<InstanceView>("POST", "/instances", input),
  updateInstance: (id: string, input: InstanceInput) =>
    request<InstanceView>("PUT", `/instances/${enc(id)}`, input),
  deleteInstance: (id: string) =>
    request<void>("DELETE", `/instances/${enc(id)}`),
  startInstance: (id: string) =>
    request<InstanceView>("POST", `/instances/${enc(id)}/start`, {}),
  stopInstance: (id: string) =>
    request<InstanceView>("POST", `/instances/${enc(id)}/stop`, {}),
  startAll: () => request<void>("POST", "/start-all", {}),
  stopAll: () => request<void>("POST", "/stop-all", {}),
  getLogs: (id: string) =>
    request<{ lines: string[] }>("GET", `/instances/${enc(id)}/logs`),
  listDir: (path?: string) =>
    request<FsListing>("GET", path ? `/fs?path=${enc(path)}` : "/fs"),
  shutdown: () => request<void>("POST", "/shutdown", {}),
};
