import { create } from "zustand";
import { api } from "@/lib/api";
import { toLogEntry, type LogEntry } from "@/lib/log-entry";
import { useUiStore } from "@/stores/ui-store";

const MAX_LINES = 1000;

interface LogStore {
  entries: LogEntry[];
  load: (id: string | null) => void;
  push: (id: string, line: string) => void;
  clear: () => void;
}

let currentId: string | null = null;
let loaded = false;
let queue: LogEntry[] = [];
let frame = 0;

const toEntries = (lines: string[]) =>
  lines.flatMap((line) => toLogEntry(line) ?? []);

/** Live lines are batched into one store update per animation frame, so a burst costs one render. */
function flush() {
  frame = 0;
  if (queue.length === 0) return;
  const added = queue;
  queue = [];
  useLogStore.setState((s) => ({
    entries: [...s.entries, ...added].slice(-MAX_LINES),
  }));
}

export const useLogStore = create<LogStore>((set) => ({
  entries: [],
  load: (id) => {
    currentId = id;
    loaded = false;
    queue = [];
    cancelAnimationFrame(frame);
    frame = 0;
    set({ entries: [] });
    if (!id) return;
    const finish = (initial: string[]) => {
      if (currentId !== id) return;
      loaded = true;
      const pending = queue;
      queue = [];
      set({ entries: [...toEntries(initial), ...pending].slice(-MAX_LINES) });
    };
    api.getLogs(id).then(
      ({ lines }) => finish(lines),
      () => finish([]),
    );
  },
  push: (id, line) => {
    if (id !== currentId) return;
    const entry = toLogEntry(line);
    if (!entry) return;
    queue.push(entry);
    // A hidden tab pauses animation frames; never let the queue outgrow the buffer.
    if (queue.length > MAX_LINES) queue = queue.slice(-MAX_LINES);
    if (loaded && !frame) frame = requestAnimationFrame(flush);
  },
  clear: () => {
    queue = [];
    set({ entries: [] });
  },
}));

useUiStore.subscribe((state, prev) => {
  if (state.selectedId !== prev.selectedId)
    useLogStore.getState().load(state.selectedId);
});
