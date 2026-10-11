export type InstanceState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface Status {
  state: InstanceState
  phase?: string
  url?: string
  tunnelReady: boolean
  error?: string
}

export interface InstanceView {
  id: string
  name: string
  workspaceRoot: string
  tunnelId: string
  hasApiKey: true
  toolGroups: string[]
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
