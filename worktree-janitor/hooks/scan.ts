// Pure helpers: no `$`, so tests call them directly.

export type RawWorktree = { path: string; sha: string; head: string; branch?: string; isBare: boolean }

// `git worktree list --porcelain`: blocks separated by blank lines.
export function parseWorktrees(porcelain: string): RawWorktree[] {
  return porcelain
    .split(/\n\s*\n/)
    .map(block => {
      const get = (k: string) => block.split('\n').find(l => l.startsWith(`${k} `))?.slice(k.length + 1)
      const branch = get('branch')

      return {
        path: get('worktree') ?? '',
        sha: get('HEAD') ?? '',
        head: (get('HEAD') ?? '').slice(0, 7),
        branch: branch?.replace(/^refs\/heads\//, ''),
        isBare: block.split('\n').includes('bare'),
      }
    })
    .filter(w => w.path)
}

// Worktrees the Agent tool makes end in agent-<id>, the agent's own id.
export const agentIdOf = (path: string) => path.match(/agent-([0-9a-f]{8,})\/?$/)?.[1]

export type Verdict = 'running' | 'dirty' | 'unpushed' | 'merged' | 'closed' | 'open' | 'no-pr'

export function verdict(w: { isRunning: boolean; isDirty: boolean; unpushed: number; prState?: string }): Verdict {
  if (w.isRunning) return 'running'
  if (w.isDirty) return 'dirty'
  if (w.prState === 'MERGED') return w.unpushed > 0 ? 'unpushed' : 'merged'
  if (w.prState === 'CLOSED') return 'closed'
  if (w.prState === 'OPEN') return 'open'

  return w.unpushed > 0 ? 'unpushed' : 'no-pr'
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  running: 'agent still running',
  dirty: 'uncommitted changes',
  unpushed: 'commits not on the remote',
  merged: 'PR merged, safe to remove',
  closed: 'PR closed unmerged',
  open: 'PR open',
  'no-pr': 'no PR',
}
