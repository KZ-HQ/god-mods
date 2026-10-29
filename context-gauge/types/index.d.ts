export type GaugeSnap = {
  percent: number | null
  tokens: number | null
  window: number
  usd: number | null
  fiveHour: number | null
  weekly: number | null
}

export type TurnCost = { usd: number; seconds: number }

// What this session's subagents cost: list-price estimate from their transcripts
export type AgentCost = { usd: number; agents: number }

declare module 'claude-code' {
  interface PluginState {
    'context-gauge': { snap: GaugeSnap | null; lastTurn: TurnCost | null; isHidden: boolean; agentCost: AgentCost | null }
  }
}
