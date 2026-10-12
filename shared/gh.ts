// Finds gh. Source of truth: ~/.claude/mods/shared/gh.ts.
// shared/sync.sh inlines it between the gh markers in each mod file that uses it. Edit here, run sync.sh, never edit an inlined copy.
import type { EngineInterface } from 'claude-code'

let ghPath: string | undefined

// gh's absolute path, found through a login shell: the desktop app's PATH lacks Homebrew. Falls back to plain gh.
async function findGh($: EngineInterface): Promise<string> {
  if (ghPath) return ghPath
  try {
    const r = await $.process.run(['/bin/zsh', '-lc', 'command -v gh'], { timeoutMs: 5000 })
    const found = r.stdout.trim().split('\n').pop()
    if (r.exitCode === 0 && found?.startsWith('/')) return (ghPath = found)
  } catch {
    // No zsh: fall back to PATH
  }

  return 'gh'
}
