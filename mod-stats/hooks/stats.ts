// Pure: turns metrics.jsonl lines into the /mod-stats report.

export type Row = { t: string; mod: string; event: string; project?: string; [k: string]: unknown }

export function parse(text: string): Row[] {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as Row
      if (typeof r.mod === 'string' && typeof r.event === 'string' && typeof r.t === 'string') rows.push(r)
    } catch {
      // A torn line from a crash: skip it
    }
  }

  return rows
}

// <money: generated from shared/money.ts by shared/sync.sh>
// US dollars: three decimals under $1, where cents hide the cost of a cheap call; two from $1
function usd(n: number): string {
  return `$${Math.abs(n) < 1 ? n.toFixed(3) : n.toFixed(2)}`
}
// </money>

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
const pct = (a: number, b: number) => (b ? `${Math.round((a * 100) / b)}%` : '—')

function line(mod: string, rows: Row[]): string {
  const of = (event: string) => rows.filter(r => r.event === event)
  const where = (event: string, key: string, value: unknown) => of(event).filter(r => r[key] === value).length
  const sum = (event: string, key: string) => of(event).reduce((a, r) => a + num(r[key]), 0)

  switch (mod) {
    case 'next-steps': {
      const shown = where('shown', 'ok', true)

      return `${shown} suggestion sets, ${of('clicked').length} clicked (${pct(of('clicked').length, shown)}) · Haiku ${usd(sum('shown', 'usd'))}`
    }
    case 'prompt-shaper':
      return `${of('inject').length} prompts got notes (~${k(sum('inject', 'chars') / 4)} tokens added) · toolchain in ${of('toolchain').length} sessions (~${k(sum('toolchain', 'chars') / 4)} tokens each time)`
    case 'test-on-edit':
      return `${of('run').length} runs, ${of('run').filter(r => num(r.failed) > 0).length} with failures · ${of('delivered').length} failure notes to Claude (~${k(sum('delivered', 'chars') / 4)} tokens)`
    case 'context-gauge': {
      const done = of('compact').filter(r => r.outcome === 'done')
      const freed = done.reduce((a, r) => a + Math.max(0, num(r.before) - num(r.after)), 0)

      return `${of('nag').length} over-400k warnings · compact: ${done.length} done (${k(freed)} tokens freed), ${where('compact', 'outcome', 'skipped')} skipped, ${where('compact', 'outcome', 'error')} failed`
    }
    case 'merge-gate':
      return `${of('verdict').length} merges checked: ${['pass', 'fail', 'pending', 'none'].map(v => `${where('verdict', 'kind', v)} ${v}`).join(', ')} · asked ${of('asked').length}, held ${where('asked', 'answer', 'hold')}`
    case 'secret-scrubber':
      return `${of('masked').length} outputs masked, ${of('blocked').length} writes blocked`
    case 'long-turn-notify':
      return `${of('notified').length} notifications (${where('notified', 'isError', true)} for errors)`
    case 'mod-faults':
    case 'mod-stats':
      return `${of('fault').length} hook faults recorded across mods`
    default: {
      const counts = new Map<string, number>()
      for (const r of rows) counts.set(r.event, (counts.get(r.event) ?? 0) + 1)

      return [...counts].map(([e, n]) => `${n} ${e}`).join(', ')
    }
  }
}

// v2 rows the shared metrics block writes for every mod; everything else is an outcome row
const TELEMETRY = new Set(['loaded', 'turn', 'blind', 'latency'])
// mod-stats took over mod-faults' watching; older rows carry the old name
const WATCHER = new Set(['mod-stats', 'mod-faults'])
// Outcome rows whose chars went into Claude's context, as notes or a system-prompt section
const CONTEXT: Record<string, string[]> = { 'prompt-shaper': ['inject', 'toolchain'], 'test-on-edit': ['delivered'] }
// Used within this many days: active; used earlier in the window: stale; loaded but never used: dormant
const ACTIVE_DAYS = 3
// A single hook call this slow (own time) makes the mod's line say so
const SLOW_MS = 2000
const DAY_MS = 86_400_000

// When a mod last did something visible: an outcome row, a command run, or a drawing
function lastUse(rows: Row[]): number | undefined {
  const used = rows.filter(r =>
    r.event === 'turn'
      ? Object.keys((r.hooks ?? {}) as object).some(h => h.startsWith('command.run{') || h === 'ui.render')
      : !TELEMETRY.has(r.event) && r.event !== 'fault',
  )

  return used.length ? Math.max(...used.map(r => Date.parse(r.t))) : undefined
}

function label(rows: Row[], nowMs: number): string {
  const last = lastUse(rows)
  if (last === undefined) return rows.some(r => r.event === 'loaded') ? 'dormant' : ''
  if (nowMs - last <= ACTIVE_DAYS * DAY_MS) return 'active'

  return `stale, last used ${new Date(last).toISOString().slice(0, 10)}`
}

// Summed from the watcher's per-turn latency rows: own hook time, next() taken out
function latency(rows: Row[]): Map<string, { calls: number; ms: number; max: number; maxEvent: string }> {
  const by = new Map<string, { calls: number; ms: number; max: number; maxEvent: string }>()
  for (const r of rows) {
    if (!WATCHER.has(r.mod) || r.event !== 'latency' || typeof r.mods !== 'object' || !r.mods) continue
    for (const [mod, v] of Object.entries(r.mods as Record<string, Record<string, unknown>>)) {
      const l = by.get(mod) ?? { calls: 0, ms: 0, max: 0, maxEvent: '' }
      l.calls += num(v.calls)
      l.ms += num(v.ms)
      if (num(v.max) > l.max) Object.assign(l, { max: num(v.max), maxEvent: String(v.maxEvent ?? '') })
      by.set(mod, l)
    }
  }

  return by
}

function telemetry(rows: Row[]): string {
  const loads = rows.filter(r => r.event === 'loaded')
  const calls = rows.filter(r => r.event === 'turn').reduce((a, r) => a + Object.values((r.hooks ?? {}) as Record<string, unknown>).reduce((b: number, n) => b + num(n), 0), 0)
  const vers = [...new Set(loads.map(r => String(r.ver ?? '?')))].sort()
  if (!loads.length && !calls) return ''

  return ` · loaded ${loads.length}× (v${vers.join(', v') || '?'}), ${calls} hook calls`
}

// mods: every mod in the marketplace, so ones with no rows show under No events
export function report(all: Row[], sinceMs: number, days: number, project?: string, mods: string[] = []): string {
  const rows = all.filter(r => Date.parse(r.t) >= sinceMs && (!project || r.project === project))
  const outcomes = rows.filter(r => !TELEMETRY.has(r.event))
  const names = [...new Set([...mods, ...rows.map(r => r.mod)])].sort()
  const out = [`Mod activity, last ${days} day${days === 1 ? '' : 's'}${project ? ` in ${project}` : ''} (${outcomes.length} events):`]
  // The watcher records each hook fault as its own row, naming the mod that faulted
  const faults = new Map<string, number>()
  for (const r of rows) {
    if (!WATCHER.has(r.mod) || r.event !== 'fault' || typeof r.plugin !== 'string') continue
    const of = r.plugin.split('@')[0]!
    faults.set(of, (faults.get(of) ?? 0) + 1)
  }
  // The watcher can't see mods above it in the chain; only its latest session's view counts
  const latest = rows.filter(r => WATCHER.has(r.mod) && r.event === 'loaded').at(-1)
  const blindRow = latest && rows.filter(r => r.mod === latest.mod && r.event === 'blind' && r.session === latest.session).at(-1)
  const nowMs = sinceMs + days * DAY_MS
  const lat = latency(rows)
  const dormant: string[] = []
  const context: string[] = []
  const blindTo = Array.isArray(blindRow?.mods) ? (blindRow.mods as string[]) : []
  const quiet: string[] = []
  for (const mod of [...new Set([...names, ...faults.keys()])].sort()) {
    const mine = rows.filter(r => r.mod === mod)
    const acts = mine.filter(r => !TELEMETRY.has(r.event))
    const faulted = faults.get(mod) ? ` · ${faults.get(mod)} fault${faults.get(mod) === 1 ? '' : 's'}` : ''
    const blindNote = mod === latest?.mod && blindTo.length ? ` · can't see ${blindTo.length}: ${blindTo.join(', ')}` : ''
    const l = lat.get(mod)
    const time = l?.calls ? ` · hooks avg ${Math.round(l.ms / l.calls)}ms, max ${l.max}ms (${l.maxEvent})${l.max >= SLOW_MS ? ' SLOW' : ''}` : ''
    const tag = label(mine, nowMs)
    if (tag === 'dormant') dormant.push(mod)
    const chars = (CONTEXT[mod] ?? []).reduce((a, ev) => a + acts.filter(r => r.event === ev).reduce((b, r) => b + num(r.chars), 0), 0)
    if (chars) context.push(`${mod} ~${k(chars / 4)}`)
    if (mine.length === 0 && !faulted) quiet.push(mod)
    else out.push(`  ${mod}${tag ? ` (${tag})` : ''}: ${acts.length ? line(mod, acts) : 'no outcomes'}${mine.length ? telemetry(mine) : ''}${faulted}${time}${blindNote}`)
  }
  if (dormant.length) out.push(`  Dormant (loaded, never used in ${days} day${days === 1 ? '' : 's'}): ${dormant.join(', ')}: candidates to remove`)
  if (context.length) out.push(`  Tokens added to Claude's context: ${context.join(', ')}`)
  if (quiet.length) out.push(`  No events: ${quiet.join(', ')}`)
  out.push('Token figures for notes are estimates (4 characters per token); $ are list prices.')

  return out.join('\n')
}
