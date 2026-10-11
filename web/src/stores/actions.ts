import { toast } from "sonner";
import { api } from "@/lib/api";
import type { InstanceInput } from "@/lib/types";
import { useManagerStore } from "@/stores/manager-store";
import { useUiStore } from "@/stores/ui-store";

const manager = () => useManagerStore.getState();
const ui = () => useUiStore.getState();

/** Runs an API call and reports the outcome as a toast. */
export async function run(fn: () => Promise<unknown>, success?: string) {
  try {
    await fn();
    if (success) toast.success(success);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Request failed");
  }
}

async function bulk(fn: () => Promise<unknown>, success: string) {
  ui().setBulkBusy(true);
  await run(fn, success);
  ui().setBulkBusy(false);
}

export const startAll = () => bulk(api.startAll, "Starting all instances");
export const stopAll = () => bulk(api.stopAll, "Stopping all instances");
export const startInstance = (id: string) => run(() => api.startInstance(id));
export const stopInstance = (id: string) => run(() => api.stopInstance(id));
export const quitManager = () =>
  run(async () => {
    await api.shutdown();
    manager().markStopped();
  });

export async function deleteInstance(id: string) {
  const name = manager().byId[id]?.name;
  await run(() => api.deleteInstance(id), `Deleted "${name}"`);
  await manager().refresh();
}

/** Adds or edits depending on the open form; throws so the dialog can show the error. */
export async function submitInstance(input: InstanceInput) {
  const form = ui().form;
  if (form?.mode === "edit") {
    await api.updateInstance(form.id, input);
    toast.success(`Saved "${input.name}"`);
    void manager().refresh();
  } else {
    const created = await api.createInstance(input);
    toast.success(`Added "${input.name}"`);
    await manager().refresh();
    ui().select(created.id);
  }
}
