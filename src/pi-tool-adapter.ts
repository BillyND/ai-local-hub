import { fromJSONSchema, z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { PiTool } from "./pi-tools.js";
import type { ToolCapacity } from "./tool-capacity.js";

type JsonSchema = Parameters<typeof fromJSONSchema>[0];
type JsonObject = Record<string, unknown>;

type ToolCache = {
  input: ReturnType<typeof fromJSONSchema>;
  output?: ReturnType<typeof fromJSONSchema>;
  advertised: Tool;
};

const toolCache = new WeakMap<object, ToolCache>();

function isObjectSchema(schema: JsonSchema): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    "type" in schema &&
    schema.type === "object"
  );
}

function asStructuredObject(value: unknown): JsonObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value))
    return value as JsonObject;
  return { result: value };
}

function toolAnnotations(toolName: string): ToolAnnotations {
  const readOnly = ["read", "grep", "find", "ls"].includes(toolName);
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly,
    idempotentHint: readOnly || toolName === "write",
    openWorldHint: toolName === "bash" || toolName === "powershell",
  };
}

function cachedTool(tool: PiTool): ToolCache {
  const existing = toolCache.get(tool);
  if (existing) return existing;
  const parameters = tool.parameters as unknown as JsonSchema;
  const outputSchema = tool.outputSchema as unknown as JsonSchema | undefined;
  const wrapOutput =
    outputSchema !== undefined && !isObjectSchema(outputSchema);
  const wireOutputSchema: JsonSchema | undefined = wrapOutput
    ? {
        type: "object",
        properties: { result: outputSchema! },
        required: ["result"],
      }
    : outputSchema;
  const cached: ToolCache = {
    input: fromJSONSchema(parameters),
    ...(wireOutputSchema ? { output: fromJSONSchema(wireOutputSchema) } : {}),
    advertised: {
      name: tool.name,
      title: tool.label,
      description: tool.description,
      inputSchema: tool.parameters as Tool["inputSchema"],
      ...(wireOutputSchema
        ? { outputSchema: wireOutputSchema as Tool["outputSchema"] }
        : {}),
      annotations: toolAnnotations(tool.name),
    },
  };
  toolCache.set(tool, cached);
  return cached;
}

export function registerPiTools(
  server: McpServer,
  tools: readonly PiTool[],
  shutdownSignal: AbortSignal,
  capacity: ToolCapacity,
  activity: { start(): void; finish(): void },
): void {
  const advertised: Tool[] = [];
  for (const tool of tools) {
    const cached = cachedTool(tool);
    const inputSchema = tool.prepareArguments
      ? z.preprocess((value) => tool.prepareArguments!(value), cached.input)
      : cached.input;
    const annotations = cached.advertised.annotations!;
    advertised.push(cached.advertised);
    server.registerTool(
      tool.name,
      {
        title: tool.label,
        description: tool.description,
        inputSchema,
        ...(cached.output ? { outputSchema: cached.output } : {}),
        annotations,
      },
      async (args: unknown, extra) => {
        const signal = AbortSignal.any([extra.signal, shutdownSignal]);
        signal.throwIfAborted();
        activity.start();
        let release: (() => void) | undefined;
        try {
          release = await capacity.acquire(tool.name, signal);
          if (!release) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "MCP tool capacity reached. Retry this call after active operations finish.",
                },
              ],
              isError: true,
              _meta: { "workspace-tools-mcp/retryable": true },
            };
          }
          let progress = 0;
          let updates = Promise.resolve();
          const result = await tool.execute(
            String(extra.requestId),
            args,
            signal,
            (partial) => {
              const progressToken = extra._meta?.progressToken;
              if (progressToken === undefined) return;
              const message = partial.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n");
              const currentProgress = ++progress;
              updates = updates
                .then(async () => {
                  await extra.sendNotification({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: currentProgress,
                      ...(message ? { message } : {}),
                    },
                  });
                })
                .catch(() => undefined);
            },
          );
          await updates;
          return {
            content: result.content,
            ...(result.structuredContent !== undefined
              ? {
                  structuredContent:
                    tool.outputSchema &&
                    !isObjectSchema(tool.outputSchema as unknown as JsonSchema)
                      ? { result: result.structuredContent }
                      : asStructuredObject(result.structuredContent),
                }
              : {}),
            ...(result.isError !== undefined
              ? { isError: result.isError }
              : {}),
            _meta: { "workspace-tools-mcp/details": result.details ?? null },
          };
        } finally {
          release?.();
          activity.finish();
        }
      },
    );
  }
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: advertised,
  }));
}

export function getPiToolNames(tools: readonly PiTool[]): string[] {
  return tools.map((tool) => tool.name);
}
