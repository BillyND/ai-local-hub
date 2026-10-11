import type { InstanceState } from "@/lib/types";

export type BadgeTone = "success" | "warning" | "destructive" | "muted";

export function describeStatus(
  state: InstanceState,
  tunnelReady: boolean,
  localOnly: boolean,
): { label: string; tone: BadgeTone; busy: boolean } {
  switch (state) {
    case "running":
      return {
        label: localOnly && !tunnelReady ? "Local only" : "Running",
        tone: "success",
        busy: false,
      };
    case "starting":
      return { label: "Starting", tone: "warning", busy: true };
    case "stopping":
      return { label: "Stopping", tone: "warning", busy: true };
    case "error":
      return { label: "Error", tone: "destructive", busy: false };
    default:
      return { label: "Stopped", tone: "muted", busy: false };
  }
}
