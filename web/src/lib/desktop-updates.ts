import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type UpdatePhase =
  | "idle"
  | "available"
  | "downloading"
  | "installing"
  | "error";

/** Update state owned by the desktop shell (`desktop/src-tauri/src/updater.rs`). */
export interface UpdateView {
  currentVersion: string;
  autoInstall: boolean;
  phase: UpdatePhase;
  version: string | null;
  notes: string | null;
  /** Downloaded fraction (0 to 1) when the size is known. */
  progress: number | null;
  error: string | null;
}

/** The same UI also runs in a plain browser, where there is nothing to update. */
export const inDesktopApp = isTauri;

export const desktopUpdates = {
  state: () => invoke<UpdateView>("update_state"),
  setAutoInstall: (enabled: boolean) =>
    invoke<UpdateView>("set_auto_install", { enabled }),
  install: () => invoke<void>("install_update"),
  subscribe: (handler: (view: UpdateView) => void): Promise<UnlistenFn> =>
    listen<UpdateView>("update-state", (event) => handler(event.payload)),
};
