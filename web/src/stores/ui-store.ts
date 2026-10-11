import { create } from "zustand";

export type FormTarget = { mode: "add" } | { mode: "edit"; id: string } | null;

interface UiStore {
  selectedId: string | null;
  form: FormTarget;
  bulkBusy: boolean;
  quitOpen: boolean;
  deleteId: string | null;
  select: (id: string | null) => void;
  /** Keeps the selection valid: falls back to the first instance when the selected one is gone. */
  reconcileSelection: (ids: string[]) => void;
  openAdd: () => void;
  openEdit: (id: string) => void;
  closeForm: () => void;
  setBulkBusy: (busy: boolean) => void;
  setQuitOpen: (open: boolean) => void;
  setDeleteId: (id: string | null) => void;
}

export const useUiStore = create<UiStore>((set, get) => ({
  selectedId: null,
  form: null,
  bulkBusy: false,
  quitOpen: false,
  deleteId: null,
  select: (id) => set({ selectedId: id }),
  reconcileSelection: (ids) => {
    const { selectedId } = get();
    if (!selectedId || !ids.includes(selectedId))
      set({ selectedId: ids[0] ?? null });
  },
  openAdd: () => set({ form: { mode: "add" } }),
  openEdit: (id) => set({ form: { mode: "edit", id } }),
  closeForm: () => set({ form: null }),
  setBulkBusy: (bulkBusy) => set({ bulkBusy }),
  setQuitOpen: (quitOpen) => set({ quitOpen }),
  setDeleteId: (deleteId) => set({ deleteId }),
}));
