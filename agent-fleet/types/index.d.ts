export type FleetAgent = {
  id: string
  description: string
  type: string
  model: string
  startedAt: number
  endedAt: number | null
  status: 'running' | 'completed' | 'failed' | 'killed'
  tools: number
  lastTool: string
  /** The context the agent's latest request carried */
  contextTokens: number
  /** Everything the agent has written so far */
  tokensOut: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-fleet': { agents: FleetAgent[]; now: number; wasClosed: boolean }
  }
}
