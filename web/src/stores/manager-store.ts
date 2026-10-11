import { create } from "zustand";
import { api, setUnauthorizedHandler } from "@/lib/api";
import type { InstanceView, ServerEvent, Status } from "@/lib/types";
import { useLogStore } from "@/stores/log-store";
import { useUiStore } from "@/stores/ui-store";

interface ManagerStore {
  /** Ordered ids plus a by-id map: a status change replaces one map entry and re-renders one card. */
  ids: string[];
  byId: Record<string, InstanceView>;
  localOnly: boolean;
  homeDir: string;
  loaded: boolean;
  loadError: string | null;
  reconnecting: boolean;
  expired: boolean;
  stopped: boolean;
  refresh: () => Promise<void>;
  markStopped: () => void;
  /** Loads state, opens the live event stream and returns a disposer. */
  connect: () => () => void;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Rebuilds ids/byId from a list while keeping the identity of everything that did not change. */
function merge(
  prevIds: string[],
  prev: Record<string, InstanceView>,
  list: InstanceView[],
) {
  const byId: Record<string, InstanceView> = {};
  for (const i of list)
    byId[i.id] = prev[i.id] && same(prev[i.id], i) ? prev[i.id]! : i;
  const ids = list.map((i) => i.id);
  return {
    ids:
      ids.length === prevIds.length && ids.every((id, n) => id === prevIds[n])
        ? prevIds
        : ids,
    byId,
  };
}

export const useManagerStore = create<ManagerStore>((set, get) => {
  const setInstances = (list: InstanceView[]) => {
    const { ids, byId } = merge(get().ids, get().byId, list);
    set({ ids, byId });
    useUiStore.getState().reconcileSelection(ids);
  };
  const setStatus = (id: string, status: Status) => {
    const current = get().byId[id];
    if (!current || same(current.status, status)) return;
    set((s) => ({ byId: { ...s.byId, [id]: { ...current, status } } }));
  };
  const apply = (event: ServerEvent) => {
    if (event.type === "log") useLogStore.getState().push(event.id, event.line);
    else if (event.type === "instances") setInstances(event.instances);
    else if (event.type === "status") setStatus(event.id, event.status);
  };

  return {
    ids: [],
    byId: {},
    localOnly: false,
    homeDir: "",
    loaded: false,
    loadError: null,
    reconnecting: false,
    expired: false,
    stopped: false,
    refresh: async () => {
      try {
        const state = await api.getState();
        set({
          localOnly: state.localOnly,
          homeDir: state.homeDir,
          loaded: true,
          loadError: null,
        });
        setInstances(state.instances);
      } catch (err) {
        set({
          loadError:
            err instanceof Error ? err.message : "Failed to load state",
        });
      }
    },
    markStopped: () => set({ stopped: true }),
    connect: () => {
      let source: EventSource | null = null;
      let timer: number | undefined;
      let attempt = 0;
      let disposed = false;
      let opened = false;
      setUnauthorizedHandler(() => set({ expired: true }));

      const open = () => {
        if (disposed) return;
        source = new EventSource("/api/events");
        source.onopen = () => {
          attempt = 0;
          set({ reconnecting: false });
          if (opened) void get().refresh();
          opened = true;
        };
        source.onmessage = (msg) => {
          try {
            apply(JSON.parse(msg.data) as ServerEvent);
          } catch {
            /* ignore malformed event */
          }
        };
        source.onerror = () => {
          source?.close();
          if (disposed) return;
          set({ reconnecting: true });
          timer = window.setTimeout(
            open,
            Math.min(1000 * 2 ** attempt++, 15000),
          );
        };
      };

      void get().refresh().then(open);
      return () => {
        disposed = true;
        window.clearTimeout(timer);
        source?.close();
        setUnauthorizedHandler(null);
      };
    },
  };
});
