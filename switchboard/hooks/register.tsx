import type { EngineInterface, Register } from 'claude-code'

import { cost, pick, tierOf } from './route.ts'
import type { Tier, Usage } from './route.ts'

// One JSON line per mod event in ~/.claude/mods/metrics.jsonl; /mod-stats reads it.
// Local only. Fire-and-forget: a failed write never blocks the hook that tracked it,
// but the first failure per load is surfaced as a toast instead of vanishing.
const APPEND = 'mkdir -p "$HOME/.claude/mods" && printf "%s\\n" "$1" >> "$HOME/.claude/mods/metrics.jsonl"'
let trackFailed = false

function track($: EngineInterface, mod: string, event: string, data: Record<string, unknown> = {}): void {
  void (async () => {
    const t = new Date(await $.clock.now()).toISOString()
    const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? ''
    const line = JSON.stringify({ t, mod, event, project, ...data })
    const { exitCode, stderr } = await $.process.run(['/bin/sh', '-c', APPEND, 'mod-metrics', line], { timeoutMs: 3000 })
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
  })().catch((err: unknown) => {
    if (trackFailed) return
    trackFailed = true
    $.ui.toast(`${mod}: metrics write failed (${err instanceof Error ? err.message : String(err)})`)
  })
}

const MODE_KEY = 'mode'
const KEEP = 20

type Mode = 'observe' | 'route' | 'off'
type Run = { id: string; description: string; asked: Tier; picked: Tier | null; why: string; applied: boolean; usage: Usage | null }

// The session's runs; the mode lives in $.store so it carries across sessions
let runs: Run[] = []

async function modeOf($: EngineInterface): Promise<Mode> {
  const m = await $.store.get(MODE_KEY).catch(() => undefined)

  return m === 'observe' || m === 'off' ? m : 'route'
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Subagent model picks and what they cost; /route on to apply picks, /route observe to only record them, /route off',
    })

    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'observe' || arg === 'off') {
      await $.store.set(MODE_KEY, arg === 'on' ? 'route' : arg)

      return { text: `switchboard: ${arg === 'on' ? 'now applies its picks' : arg === 'off' ? 'off' : 'records picks without applying them'}.` }
    }
    const mode = await modeOf($)
    const lines = runs.map(r => {
      const spent = r.usage ? cost(r.applied && r.picked ? r.picked : r.asked, r.usage) : null
      const alt = r.usage && r.picked && r.picked !== r.asked ? cost(r.applied ? r.asked : r.picked, r.usage) : null
      const money = spent === null ? 'running' : alt === null ? usd(spent) : r.applied ? `${usd(spent)} (on ${r.asked}: ${usd(alt)})` : `${usd(spent)} (on ${r.picked}: ~${usd(alt)})`

      return `${r.applied ? '→' : '·'} ${r.description}: asked ${r.asked}, pick ${r.picked ?? '—'} (${r.why}) · ${money}`
    })

    return {
      text: [
        `${mode === 'route' ? 'applying picks' : mode === 'off' ? 'off' : 'observing (picks recorded, not applied; /route on applies them)'}`,
        ...(lines.length ? lines : ['No subagents yet this session.']),
        'Costs are list-price estimates from token counts.',
      ].join('\n'),
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const mode = await modeOf($)
    if (mode === 'off') return next(e)
    const asked = tierOf(e.model ?? e.parentModel)
    const choice = pick(e)
    const applied = mode === 'route' && !!choice && choice.tier !== asked
    const r = await next(applied && choice ? { ...e, model: choice.tier } : e)
    if (r.deny !== undefined || !r.agentId) return r

    runs = [...runs, { id: r.agentId, description: e.description, asked, picked: choice?.tier ?? null, why: choice?.why ?? 'no rule matched', applied, usage: null }].slice(-KEEP)
    if (applied && choice) $.ui.toast(`switchboard: "${e.description}" on ${choice.tier} instead of ${asked} (${choice.why})`)

    return r
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined || !e.usage) return done
    const u = e.usage
    runs = runs.map(r => (r.id === e.agentId ? { ...r, usage: u } : r))
    const run = runs.find(r => r.id === e.agentId)
    if (run) {
      const used = run.applied && run.picked ? run.picked : run.asked
      const spent = cost(used, u)
      // Positive: what routing saved against the model asked for; negative: what upgrading to opus cost
      const saved = run.applied && run.picked ? cost(run.asked, u) - spent : 0
      track($, 'switchboard', 'agent', { asked: run.asked, picked: run.picked, applied: run.applied, used, usd: spent, savedUsd: saved, tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens })
    }

    return done
  })
}
