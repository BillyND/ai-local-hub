import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

export type PiTool = AgentTool<TSchema, unknown>;

export function createPiTools(workspaceRoot: string): PiTool[] {
  const tools: PiTool[] = [
    createReadTool(workspaceRoot),
    createBashTool(workspaceRoot),
    createEditTool(workspaceRoot),
    createWriteTool(workspaceRoot),
    createGrepTool(workspaceRoot),
    createFindTool(workspaceRoot),
    createLsTool(workspaceRoot),
  ];
  if (process.platform === "win32")
    tools.push(createPowerShellTool(workspaceRoot));
  return tools;
}
