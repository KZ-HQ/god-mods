import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import type { GaugeSnap } from '../types'

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

// Thresholds, in percent of the context window
const WARN_AT = 60
const HOT_AT = 80
const OFFER_COMPACT_AT = 70
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
const usd = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

// Says what happened: a compaction takes a while, and a refusal used to vanish
async function compactNow($: EngineInterface): Promise<void> {
  $.ui.status('context-gauge: compacting…')
  try {
    const r = await $.session.compact()
    track($, 'context-gauge', 'compact', r.skip !== undefined ? { outcome: 'skipped', reason: r.skip } : { outcome: 'done', before: r.tokensBefore, after: r.tokensAfter })
    if (r.skip !== undefined) $.ui.toast(`context-gauge: compaction skipped: ${r.skip}`)
    else $.ui.toast(`context-gauge: compacted${r.tokensBefore && r.tokensAfter ? ` ${k(r.tokensBefore)} → ${k(r.tokensAfter)}` : ''}`)
  } catch (err) {
    track($, 'context-gauge', 'compact', { outcome: 'error', reason: err instanceof Error ? err.message : String(err) })
    $.ui.toast(`context-gauge: could not compact (${err instanceof Error ? err.message : String(err)}); try /compact`)
  } finally {
    $.ui.status(undefined)
  }
}

export const register: Register = on => {
  // Baseline for the running main-loop turn
  let turnStartUsd = 0
  let turnStartedAt = 0
  // One toast per crossing; re-armed when context drops back (e.g. after a compact)
  let hasNagged = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'gauge', description: 'Show or hide the context gauge above the prompt' })
    const usage = await $.session.usage()
    await update($, snap, () => toSnap(usage))
    // /gauge's choice carries over to new sessions
    if ((await $.store.get(HIDDEN_KEY)) === true) await update($, isHidden, () => true)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const s = toSnap(e)
    await update($, snap, () => s)
    const big = (s.tokens ?? 0) >= NAG_TOKENS
    if (big && !hasNagged) track($, 'context-gauge', 'nag', { tokens: s.tokens })
    if (big && !hasNagged) $.ui.toast(`context-gauge: context is ${k(s.tokens ?? 0)}; every call now re-reads it. Compact or start a new session to save usage.`)
    hasNagged = big

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnStartUsd = (await $.session.usage()).cost?.usd ?? 0
    turnStartedAt = await $.clock.now()

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    const nowUsd = (await $.session.usage()).cost?.usd ?? turnStartUsd
    const seconds = Math.round(((await $.clock.now()) - turnStartedAt) / 1000)
    await update($, lastTurn, () => ({ usd: Math.max(0, nowUsd - turnStartUsd), seconds }))

    return done
  })

  on('command.run', { command: 'gauge' }, async $ => {
    const hidden = await update($, isHidden, h => !h)
    await $.store.set(HIDDEN_KEY, hidden).catch(() => undefined)

    return { text: hidden ? 'Context gauge hidden. /gauge shows it again.' : 'Context gauge shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (e.props.hasSurvey || s === null || (await read($, isHidden))) return next(e)

    const turn = await read($, lastTurn)
    const { Box, Text, Button } = $.ui.resolve(e)

    const pct = s.percent
    const filled = pct === null ? 0 : Math.min(BAR_CELLS, Math.round((pct / 100) * BAR_CELLS))
    const bar = '▰'.repeat(filled) + '▱'.repeat(BAR_CELLS - filled)
    const isBig = (s.tokens ?? 0) >= NAG_TOKENS
    const color = pct === null ? undefined : pct >= HOT_AT || isBig ? 'red' : pct >= WARN_AT ? 'yellow' : 'green'

    const parts: string[] = []
    parts.push(pct === null ? 'ctx —' : `${pct}% · ${k(s.tokens ?? 0)}/${k(s.window)}`)
    if (isBig) parts.push('over 400k: compact to save usage')
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
        {/* Compacting under a running turn rewrites the conversation it is using */}
        {(isBig || (pct !== null && pct >= OFFER_COMPACT_AT)) && !e.props.isWorking && (
          <Button key="compact" label="Compact" onPress={() => compactNow($)} />
        )}
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
