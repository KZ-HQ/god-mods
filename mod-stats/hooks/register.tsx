import type { Register } from 'claude-code'

import { parse, report } from './stats.ts'

const DAY_MS = 86_400_000
// The newest lines are enough for any window /mod-stats shows
const READ = 'tail -n 50000 "$HOME/.claude/mods/metrics.jsonl" 2>/dev/null || true'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mod-stats', description: 'What each mod did, cost and saved: /mod-stats [days] [here]' })

    return next(e)
  })

  on('command.run', { command: 'mod-stats' }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const days = Math.max(1, Number(args.find(a => /^\d+$/.test(a)) ?? 7))
    const project = args.includes('here') ? (await $.session.cwd()).split('/').filter(Boolean).pop() : undefined
    const r = await $.process.run(['/bin/sh', '-c', READ], { timeoutMs: 10_000 })
    const rows = parse(r.stdout)
    if (rows.length === 0) return { text: 'No mod events recorded yet. They collect in ~/.claude/mods/metrics.jsonl as the mods act.' }

    return { text: report(rows, (await $.clock.now()) - days * DAY_MS, days, project) }
  })
}
