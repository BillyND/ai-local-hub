import type { InstanceConfig } from "../config.js";
import type { InstanceManager, InstanceStatus } from "../instance-manager.js";

export interface InstanceView {
  id: string;
  name: string;
  workspaceRoot: string;
  tunnelId: string;
  /** API keys are write-only: the UI only learns that one is stored. */
  hasApiKey: true;
  status: InstanceStatus;
}

export function toView(instance: InstanceConfig, manager: InstanceManager): InstanceView {
  return {
    id: instance.id,
    name: instance.name,
    workspaceRoot: instance.workspaceRoot,
    tunnelId: instance.tunnelId,
    hasApiKey: true,
    status: manager.status(instance.id),
  };
}
