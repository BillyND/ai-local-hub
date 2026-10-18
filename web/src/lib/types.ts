export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface Status {
  state: InstanceState
  phase?: string
  url?: string
  tunnelReady: boolean
  error?: string
}

export interface McpServerConfig {
  command: string
  args?: string[]
  /** Values come back as "<hidden>"; sending "<hidden>" keeps the saved value. */
  env?: Record<string, string>
  cwd?: string
  enabled?: boolean
  tools?: string[]
  trustAnnotations?: boolean
  timeoutSecs?: number
}

export type McpServers = Record<string, McpServerConfig>

export interface InstanceView {
  id: string
  name: string
  workspaceRoot: string
  tunnelId: string
  hasApiKey: true
  toolGroups: string[]
  mcpServers?: McpServers
  status: Status
}

export interface ManagerState {
  instances: InstanceView[]
  localOnly: boolean
  homeDir: string
  version: string
}

export interface InstanceInput {
  name: string
  workspaceRoot: string
  tunnelId: string
  apiKey?: string
  toolGroups?: string[]
  mcpServers?: McpServers
}

export interface FsListing {
  path: string
  parent: string | null
  dirs: string[]
}

export type ServerEvent =
  | { type: 'instances'; instances: InstanceView[] }
  | { type: 'status'; id: string; status: Status }
  | { type: 'log'; id: string; line: string }
