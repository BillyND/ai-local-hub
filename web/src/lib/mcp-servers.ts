import type { McpServers } from '@/lib/types'

/** Pretty JSON for the editor; empty when the instance has no external servers. */
export function formatMcpServers(servers: McpServers | undefined): string {
  return servers && Object.keys(servers).length ? JSON.stringify(servers, null, 2) : ''
}

/**
 * Accepts the map itself or a pasted client config (`{ "mcpServers": { ... } }`).
 * Field validation happens on the server so both stay in one place.
 */
export function parseMcpServers(text: string): McpServers {
  if (!text.trim()) return {}
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    throw new Error(`MCP servers: invalid JSON (${err instanceof Error ? err.message : 'parse error'})`)
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (isObject(value) && isObject(value.mcpServers)) value = value.mcpServers
  if (!isObject(value)) throw new Error('MCP servers: expected a JSON object keyed by server name')
  for (const [name, server] of Object.entries(value)) {
    if (!isObject(server)) throw new Error(`MCP server "${name}": expected an object with a "command"`)
  }
  return value as McpServers
}
