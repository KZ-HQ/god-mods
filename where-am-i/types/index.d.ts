export type Parked = { note: string; goal: string; branch: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'where-am-i': { goal: string; now: string; parked: Parked | null; isHidden: boolean }
  }
}
