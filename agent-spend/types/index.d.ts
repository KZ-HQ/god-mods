export type Agent = { type: string; tier: string; usd: number; tokens: number; project: string; desc: string }
export type Spend = { agents: Agent[]; days: number; project: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-spend': { spend: Spend | null }
  }
}
