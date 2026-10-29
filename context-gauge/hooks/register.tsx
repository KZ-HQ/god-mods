import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register, SessionUsage } from 'claude-code'

import type { AgentCost, GaugeSnap } from '../types'

// Thresholds, in percent of the context window
const WARN_AT = 60
const HOT_AT = 80
const BAR_CELLS = 10
// Absolute size where every call re-reads enough cache to drain the 5h limit fast
const NAG_TOKENS = 400_000
const HIDDEN_KEY = 'hidden'
// Prompt-cache lifetime of the main thread; the band counts down its last WARN_LEFT_MS
const CACHE_TTL_MS = 60 * 60_000
const WARN_LEFT_MS = 10 * 60_000
// List price per million tokens, as in hooks/agents.py: input, cache read. A 1h cache write is 2x input
const PRICE: Record<string, [number, number]> = { haiku: [0.1, 0.01], sonnet: [2, 0.2], opus: [4, 0.2] }

const snap = atom({ plugin: 'context-gauge', key: 'snap' } as const, null)
const lastTurn = atom({ plugin: 'context-gauge', key: 'lastTurn' } as const, null)
const isHidden = atom({ plugin: 'context-gauge', key: 'isHidden' } as const, false)
const agentCost = atom({ plugin: 'context-gauge', key: 'agentCost' } as const, null)
const idle = atom({ plugin: 'context-gauge', key: 'idle' } as const, null)
// Band-visible biggest file; the full tally lives in module variables so tool calls don't touch the store
const hogTop = atom({ plugin: 'context-gauge', key: 'hogTop' } as const, null)
const tally = new Map<string, number>()
const warned = new Set<string>()
let ctxNow = 0
const reset = async ($: EngineInterface) => {
  tally.clear()
  warned.clear()
  await update($, hogTop, () => null)
}

// Tokens a tool result adds to context, estimated as chars / 4 (no per-result count is exposed)
const MAX_HOGS = 300
// A single file this big, or this share of context, earns a one-time toast
const HOG_TOKENS = 30_000
const HOG_SHARE = 0.2
const estimate = (text: string) => Math.ceil(text.length / 4)

// The file a tool result is charged to; shell output and other tools share a bucket
const hogKey = (e: { tool: string; [key: string]: unknown }): string => {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  if (e.tool === 'Read') return str(e.file_path) ?? 'other'
  if (e.tool === 'Grep' || e.tool === 'Glob') return str(e.path) ?? '.'
  if (e.tool === 'Bash') return 'bash'

  return 'other'
}

const tier = (model: string) => Object.keys(PRICE).find(t => model.includes(t))

// What re-writing a lapsed cache costs over reading it warm
const coldUsd = (tokens: number, model: string) => {
  const p = PRICE[tier(model) ?? 'opus']

  return (tokens * (2 * p[0] - p[1])) / 1e6
}

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

// Session cost leaves out subagents, which bill in their own transcripts; hooks/agents.py prices those
async function scanAgents($: EngineInterface): Promise<void> {
  const session = await $.session.id().catch(() => '')
  if (!session) return
  const r = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/agents.py`, session], { timeoutMs: 10_000 }).catch(() => null)
  if (r?.exitCode !== 0) return
  try {
    const a = JSON.parse(r.stdout) as AgentCost
    if (typeof a.usd === 'number' && typeof a.agents === 'number') await update($, agentCost, () => a)
  } catch {}
}

export const register: Register = on => {
  // Baseline for the running main-loop turn
  let turnStartUsd = 0
  let turnStartedAt = 0
  // One toast per crossing; re-armed when context drops back (e.g. after a compact)
  let hasNagged = false
  // Redraws the band each minute while idle, so the cache countdown moves
  let tick: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'gauge', description: 'Show or hide the context gauge above the prompt' })
    await $.command.register({ name: 'hogs', description: 'Top files by context their tool results loaded' })
    const usage = await $.session.usage()
    await update($, snap, () => toSnap(usage))
    // /gauge's choice carries over to new sessions
    if ((await $.store.get(HIDDEN_KEY)) === true) await update($, isHidden, () => true)
    void scanAgents($)
    await reset($)

    return next(e)
  })

  // /clear ends the session without a new session.start
  on('session.end', async ($, e, next) => {
    count($, 'session.end')
    await reset($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    count($, 'session.measure')
    const s = toSnap(e)
    ctxNow = s.tokens ?? 0
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
    tick?.cancel()
    tick = null
    await update($, idle, () => null)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const nowUsd = (await $.session.usage()).cost?.usd ?? turnStartUsd
    const seconds = Math.round(((await $.clock.now()) - turnStartedAt) / 1000)
    await update($, lastTurn, () => ({ usd: Math.max(0, nowUsd - turnStartUsd), seconds }))
    const model = await $.session.model().catch(() => '')
    await update($, idle, () => ({ since: turnStartedAt + seconds * 1000, model }))
    tick?.cancel()
    tick = $.clock.every(60_000, () => $.ui.invalidate('ui.render'))
    void scanAgents($)

    return done
  })

  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    const done = await next(e)
    // A subagent's results stay in its own context
    if (e.agentId !== undefined || typeof done.text !== 'string') return done
    const tokens = estimate(done.text)
    const key = hogKey(e as never)
    const total = (tally.get(key) ?? 0) + tokens
    tally.set(key, total)
    if (tally.size > MAX_HOGS) for (const [drop] of [...tally].sort((x, y) => x[1] - y[1]).slice(0, tally.size - MAX_HOGS)) tally.delete(drop)
    // Only a real file (Read) toasts; Grep/Glob directories and shell output do not
    const isHog = e.tool === 'Read' && (total >= HOG_TOKENS || (ctxNow > 0 && total / ctxNow >= HOG_SHARE))
    if (isHog && !warned.has(key)) {
      warned.add(key)
      track($, 'context-gauge', 'hog', { tokens: total })
      $.ui.toast(`context-gauge: ${key.split('/').pop()} holds ~${k(total)} tokens of context. /compact to drop it, or /hogs for the rest.`)
    }
    const [top, topTokens] = [...tally].filter(([f]) => f !== 'other').sort((x, y) => y[1] - x[1])[0] ?? ['', 0]
    const shown = topTokens >= 5000 ? { name: top.split('/').pop() ?? top, tokens: Math.round(topTokens / 1000) * 1000 } : null
    const old = await read($, hogTop)
    if (old?.name !== shown?.name || old?.tokens !== shown?.tokens) await update($, hogTop, () => shown)

    return done
  })

  // A real compaction replaces the loaded results, so the tally starts over
  on('session.compact', async ($, e, next) => {
    count($, 'session.compact')
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.skip === undefined) { warned.clear(); await reset($) }

    return done
  })

  on('command.run', { command: 'hogs' }, async $ => {
    count($, 'command.run{hogs}')
    const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 10)
    const ctxTokens = ctxNow
    track($, 'context-gauge', 'hogs', { files: tally.size, shown: top.length, tokens: top.reduce((n, [, t]) => n + t, 0) })
    if (!top.length) return { text: 'No tool results recorded yet this session.' }
    const rows = top.map(([f, t]) => `${f}  ~${k(t)} tokens${ctxTokens ? `  ${Math.round((t / ctxTokens) * 100)}%` : ''}`)

    return { text: ['Context hogs (tool results, ~chars/4):', ...rows].join('\n') }
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
    const agents = await read($, agentCost)
    const quiet = await read($, idle)
    const top = await read($, hogTop)
    const left = quiet ? CACHE_TTL_MS - ((await $.clock.now()) - quiet.since) : Infinity
    const { Box, Text } = $.ui.resolve(e)

    const pct = s.percent
    const filled = pct === null ? 0 : Math.min(BAR_CELLS, Math.round((pct / 100) * BAR_CELLS))
    const bar = '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
    const isBig = (s.tokens ?? 0) >= NAG_TOKENS
    const color = pct === null ? undefined : pct >= HOT_AT || isBig ? 'red' : pct >= WARN_AT ? 'yellow' : 'green'

    const parts: string[] = []
    parts.push(pct === null ? 'ctx —' : `${pct}% · ${k(s.tokens ?? 0)}/${k(s.window)}`)
    if (isBig) parts.push('over 400k: /compact to save usage')
    if (quiet && left <= 0 && s.tokens) parts.push(`cache cold: next message re-writes ${k(s.tokens)} ≈ ${usd(coldUsd(s.tokens, quiet.model))}`)
    else if (left <= WARN_LEFT_MS) parts.push(`cache ${Math.ceil(left / 60_000)}m left`)
    if (turn) parts.push(`last turn ${usd(turn.usd)} · ${turn.seconds}s`)
    if (s.usd !== null) parts.push(`session ${usd(s.usd)}${agents?.agents ? ` + agents ${usd(agents.usd)}` : ''}`)
    if (top) parts.push(`top ${top.name} ~${k(top.tokens)}`)
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
