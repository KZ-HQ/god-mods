import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register, SessionUsage } from 'claude-code'

import type { GaugeSnap } from '../types'

// Thresholds, in percent of the context window
const WARN_AT = 60
const HOT_AT = 80
const BAR_CELLS = 10
// Absolute size where every call re-reads enough cache to drain the 5h limit fast
const NAG_TOKENS = 400_000
const HIDDEN_KEY = 'hidden'

const snap = atom({ plugin: 'context-gauge', key: 'snap' } as const, null)
const lastTurn = atom({ plugin: 'context-gauge', key: 'lastTurn' } as const, null)
const isHidden = atom({ plugin: 'context-gauge', key: 'isHidden' } as const, false)

const toSnap = (u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): GaugeSnap => ({
  percent: u.context.percent ?? null,
  tokens: u.context.tokens ?? null,
  window: u.context.window,
  usd: u.cost?.usd ?? null,
  fiveHour: u.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed ?? null,
  weekly: u.rateLimits.find(r => r.kind === 'seven_day')?.percentUsed ?? null,
})

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

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

// <money: generated from shared/money.ts by shared/sync.sh>
// US dollars: three decimals under $1, where cents hide the cost of a cheap call; two from $1
function usd(n: number): string {
  return `$${Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2)}`
}
// </money>

export const register: Register = on => {
  // Baseline for the running main-loop turn
  let turnStartUsd = 0
  let turnStartedAt = 0
  // One toast per crossing; re-armed when context drops back (e.g. after a compact)
  let hasNagged = false

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'gauge', description: 'Show or hide the context gauge above the prompt' })
    const usage = await $.session.usage()
    await update($, snap, () => toSnap(usage))
    // /gauge's choice carries over to new sessions
    if ((await $.store.get(HIDDEN_KEY)) === true) await update($, isHidden, () => true)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    count($, 'session.measure')
    const s = toSnap(e)
    await update($, snap, () => s)
    const big = (s.tokens ?? 0) >= NAG_TOKENS
    if (big && !hasNagged) track($, 'context-gauge', 'nag', { tokens: s.tokens })
    if (big && !hasNagged) $.ui.toast(`context-gauge: context is ${k(s.tokens ?? 0)}; every call now re-reads it. Run /compact or start a new session to save usage.`)
    hasNagged = big

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    count($, 'turn.start')
    turnStartUsd = (await $.session.usage()).cost?.usd ?? 0
    turnStartedAt = await $.clock.now()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const nowUsd = (await $.session.usage()).cost?.usd ?? turnStartUsd
    const seconds = Math.round(((await $.clock.now()) - turnStartedAt) / 1000)
    await update($, lastTurn, () => ({ usd: Math.max(0, nowUsd - turnStartUsd), seconds }))

    return done
  })

  on('command.run', { command: 'gauge' }, async $ => {
    count($, 'command.run{gauge}')
    const hidden = await update($, isHidden, h => !h)
    await $.store.set(HIDDEN_KEY, hidden).catch(() => undefined)

    return { text: hidden ? 'Context gauge hidden. /gauge shows it again.' : 'Context gauge shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    count($, 'ui.render')
    const s = await read($, snap)
    if (e.props.hasSurvey || s === null || (await read($, isHidden))) return next(e)

    const turn = await read($, lastTurn)
    const { Box, Text } = $.ui.resolve(e)

    const pct = s.percent
    const filled = pct === null ? 0 : Math.min(BAR_CELLS, Math.round((pct / 100) * BAR_CELLS))
    const bar = '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
    const isBig = (s.tokens ?? 0) >= NAG_TOKENS
    const color = pct === null ? undefined : pct >= HOT_AT || isBig ? 'red' : pct >= WARN_AT ? 'yellow' : 'green'

    const parts: string[] = []
    parts.push(pct === null ? 'ctx —' : `${pct}% · ${k(s.tokens ?? 0)}/${k(s.window)}`)
    if (isBig) parts.push('over 400k: /compact to save usage')
    if (turn) parts.push(`last turn ${usd(turn.usd)} · ${turn.seconds}s`)
    if (s.usd !== null) parts.push(`session ${usd(s.usd)}`)
    if (s.fiveHour !== null) parts.push(`5h ${Math.round(s.fiveHour)}%`)
    if (s.weekly !== null) parts.push(`7d ${Math.round(s.weekly)}%`)

    const mine = (
      <Box flexDirection="row" gap={1} width={Math.max(20, e.props.bodyColumns)}>
        <Text color={color}>{bar}</Text>
        <Text dimColor={!isBig} color={isBig ? 'red' : undefined} wrap="truncate-end">
          {parts.join('  ·  ')}
        </Text>
      </Box>
    )
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}
