// Git repository helpers. Source of truth: ~/.claude/mods/shared/git.ts.
// shared/sync.sh inlines it between the git markers in each mod file that uses it. Edit here, run sync.sh, never edit an inlined copy.
import type { EngineInterface } from 'claude-code'

// The git top level of cwd (the session's folder when omitted); undefined outside a repository or when git fails
async function repoRoot($: EngineInterface, cwd?: string): Promise<string | undefined> {
  const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { ...(cwd ? { cwd } : {}), timeoutMs: 5000 }).catch(() => undefined)

  return r && r.exitCode === 0 ? r.stdout.trim() || undefined : undefined
}
