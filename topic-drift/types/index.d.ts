export type Drift = { overlap: number; prompt: string }

declare module 'claude-code' {
  interface PluginState {
    'topic-drift': { drift: Drift | null }
  }
}
