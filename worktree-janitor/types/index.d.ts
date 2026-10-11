export type Worktree = {
  path: string
  name: string
  branch: string | null
  head: string
  verdict: 'running' | 'dirty' | 'unpushed' | 'merged' | 'closed' | 'open' | 'no-pr'
  pr: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'worktree-janitor': { rows: Worktree[]; isBusy: boolean; note: string }
  }
}
