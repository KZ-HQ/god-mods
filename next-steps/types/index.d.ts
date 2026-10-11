export type Suggestions = string[]

declare module 'claude-code' {
  interface PluginState {
    'next-steps': { suggestions: Suggestions }
  }
}
