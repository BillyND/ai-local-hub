import { fromJSONSchema, z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { PiTool } from "./pi-tools.js";

type JsonSchema = Parameters<typeof fromJSONSchema>[0];
type JsonObject = Record<string, unknown>;

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

export function registerPiTools(
  server: McpServer,
  tools: readonly PiTool[],
  shutdownSignal: AbortSignal,
): void {
  const advertised: Tool[] = [];
  for (const tool of tools) {
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
    const canonicalInput = fromJSONSchema(parameters);
    const inputSchema = tool.prepareArguments
      ? z.preprocess((value) => tool.prepareArguments!(value), canonicalInput)
      : canonicalInput;
    const annotations = toolAnnotations(tool.name);
    advertised.push({
      name: tool.name,
      title: tool.label,
      description: tool.description,
      inputSchema: tool.parameters as Tool["inputSchema"],
      ...(wireOutputSchema
        ? { outputSchema: wireOutputSchema as Tool["outputSchema"] }
        : {}),
      annotations,
    });
    server.registerTool(
      tool.name,
      {
        title: tool.label,
        description: tool.description,
        inputSchema,
        ...(wireOutputSchema
          ? { outputSchema: fromJSONSchema(wireOutputSchema) }
          : {}),
        annotations,
      },
      async (args: unknown, extra) => {
        const signal = AbortSignal.any([extra.signal, shutdownSignal]);
        signal.throwIfAborted();
        const preparedArgs = args;
        let progress = 0;
        let updates = Promise.resolve();
        const result = await tool.execute(
          String(extra.requestId),
          preparedArgs,
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
                  outputSchema && !isObjectSchema(outputSchema)
                    ? { result: result.structuredContent }
                    : asStructuredObject(result.structuredContent),
              }
            : {}),
          ...(result.isError !== undefined ? { isError: result.isError } : {}),
          _meta: { "pi-tools-mcp/details": result.details ?? null },
        };
      },
    );
  }
  // Publish the Pi JSON schemas exactly; preprocessing remains an execution-only concern.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: advertised,
  }));
}

export function getPiToolNames(tools: readonly PiTool[]): string[] {
  return tools.map((tool) => tool.name);
}
