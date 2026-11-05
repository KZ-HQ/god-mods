export type StreamStatus = 'connecting' | 'streaming' | 'offline' | 'paused'

// What the pane shows about this session's stream
export type StreamStats = {
  run: string
  relay: string
  status: StreamStatus
  sent: number
  queued: number
  toolCalls: number
  errors: number
  agents: number
  usd: number
  // Why the last send failed, short; '' when it worked
  lastError: string
}

declare module 'claude-code' {
  interface PluginState {
    agentviz: { stats: Shaped<StreamStats>; isPaused: boolean }
  }
}
