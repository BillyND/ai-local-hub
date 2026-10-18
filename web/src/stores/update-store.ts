import { create } from "zustand";
import { toast } from "sonner";
import {
  desktopUpdates,
  inDesktopApp,
  type UpdateView,
} from "@/lib/desktop-updates";

interface UpdateStore {
  /** Null outside the desktop app and until the shell answers. */
  view: UpdateView | null;
  setAutoInstall: (enabled: boolean) => Promise<void>;
  install: () => Promise<void>;
  /** Loads the state, follows shell events and returns a disposer. */
  connect: () => () => void;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const useUpdateStore = create<UpdateStore>((set) => ({
  view: null,
  setAutoInstall: async (enabled) => {
    try {
      set({ view: await desktopUpdates.setAutoInstall(enabled) });
    } catch (error) {
      toast.error(message(error));
    }
  },
  install: async () => {
    try {
      await desktopUpdates.install();
    } catch (error) {
      toast.error(message(error));
    }
  },
  connect: () => {
    if (!inDesktopApp()) return () => {};
    let disposed = false;
    const unavailable = (error: unknown) =>
      console.warn("Desktop update state unavailable", error);
    const unlisten = desktopUpdates
      .subscribe((view) => set({ view }))
      .catch((error) => {
        unavailable(error);
        return null;
      });
    desktopUpdates
      .state()
      .then((view) => {
        if (!disposed) set({ view });
      })
      .catch(unavailable);
    return () => {
      disposed = true;
      void unlisten.then((stop) => stop?.());
    };
  },
}));
