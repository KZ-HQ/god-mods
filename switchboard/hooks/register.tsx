import type { EngineInterface, On, Register } from 'claude-code'

import { cost, pick, tierOf } from './route.ts'
import type { Tier, Usage } from './route.ts'

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

// <metrics: generated from shared/metrics.ts by shared/sync.sh>
// Shared mod metrics (schema v2). Source of truth: ~/.claude/mods/shared/metrics.ts.
// shared/sync.sh inlines it between the metrics markers in each mod's register.tsx (the engine only lets $
// into functions declared in the same file). Edit here, run sync.sh, never edit an inlined copy.
//
// Rows appended to ~/.claude/mods/metrics.jsonl, all with { v: 2, t, mod, event, ver, session, project }:
//   loaded   once per load (logLoaded, or count() in the mod's session.start hook), at session.start: proves which version of the mod is running
//   turn     once per turn with activity (logTurns, or count() in the mod's turn.complete hook): { hooks: { <event>: calls } }
//   <other>  outcome rows from track(), e.g. merge-gate 'verdict'
// Privacy: never put prompt, command, tool-input or matched-secret text in a row; lengths, kinds and counts only.

const APPEND = 'mkdir -p "$HOME/.claude/mods" && printf "%s\\n" "$1" >> "$HOME/.claude/mods/metrics.jsonl"'


const ctx = { ver: '', session: '', project: '' }
const stats = new Map<string, number>()
let writeFailed = false

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

function write($: EngineInterface, mod: string, event: string, data: Record<string, unknown>): void {
  void (async () => {
    const t = new Date(await $.clock.now()).toISOString()
    if (!ctx.project) ctx.project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? ''
    const line = JSON.stringify({ v: 2, t, mod, event, ver: ctx.ver, session: ctx.session, project: ctx.project, ...data })
    const { exitCode, stderr } = await $.process.run(['/bin/sh', '-c', APPEND, 'mod-metrics', line], { timeoutMs: 3000 })
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
  })().catch((err: unknown) => {
    if (writeFailed) return
    writeFailed = true
    $.ui.toast(`${mod}: metrics write failed (${message(err)})`)
  })
}

// An outcome row: something the mod decided or did. Fire-and-forget.
function track($: EngineInterface, mod: string, event: string, data: Record<string, unknown> = {}): void {
  write($, mod, event, data)
}

async function loaded($: EngineInterface): Promise<void> {
  const mod = $.plugin.name
  ctx.session = await $.session.id().catch(() => '')
  ctx.project = ''
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    ctx.ver = manifest.version ?? ''
  } catch {
    ctx.ver = '?'
  }
  write($, mod, 'loaded', {})
}

function flush($: EngineInterface): void {
  const mod = $.plugin.name
  if (!stats.size) return
  const hooks = Object.fromEntries(stats)
  stats.clear()
  write($, mod, 'turn', { hooks })
}

// The engine allows one hook per event per plugin, and counts them by spelling. A mod that hooks
// session.start or turn.complete itself calls count() in that hook, which writes the row; otherwise
// it calls the matching helper once in register.
function logLoaded(on: On): void {
  on('session.start', async ($, e, next) => {
    await loaded($)

    return next(e)
  })
}

function logTurns(on: On): void {
  on('turn.complete', async ($, e, next) => {
    flush($)

    return next(e)
  })
}

// First statement of every hook: counts the call into this turn's row. The engine only accepts
// function literals as hooks, so calls are counted from inside rather than by wrapping.
// In a session.start hook it also writes the loaded row; in a turn.complete hook it writes the turn row.
function count($: EngineInterface, event: string): void {
  stats.set(event, (stats.get(event) ?? 0) + 1)
  if (event === 'session.start') void loaded($)
  if (event === 'turn.complete') flush($)
}
// </metrics>

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({
      name: 'route',
      description: 'Subagent model picks and what they cost; /route on to apply picks, /route observe to only record them, /route off',
    })

    return next(e)
  })

  on('command.run', { command: 'route' }, async ($, e) => {
    count($, 'command.run')
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
    count($, 'agent.spawn')
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
    count($, 'turn.complete')
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
