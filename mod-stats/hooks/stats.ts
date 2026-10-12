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
    case 'switchboard': {
      const a = of('agent')
      const routed = a.filter(r => r.applied === true).length

      return `${a.length} agents, ${routed} rerouted · spent ${usd(sum('agent', 'usd'))} · saved ${usd(sum('agent', 'savedUsd'))} vs the models asked for`
    }
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
    case 'danger-guard':
      return `${of('asked').length} risky commands asked about, you cancelled ${where('asked', 'answer', 'cancel')}`
    case 'merge-gate':
      return `${of('verdict').length} merges checked: ${['pass', 'fail', 'pending', 'none'].map(v => `${where('verdict', 'kind', v)} ${v}`).join(', ')} · asked ${of('asked').length}, held ${where('asked', 'answer', 'hold')}`
    case 'secret-scrubber':
      return `${of('masked').length} outputs masked, ${of('blocked').length} writes blocked`
    case 'limit-guard':
      return `${of('hit').length} limit hits · ${of('asked').length} agent starts asked about, held ${where('asked', 'answer', 'hold')} · ${of('resume').length} resumes`
    case 'search-router':
      return `${of('rerouted').length} calls rerouted · ${of('level').length} credit changes`
    case 'topic-drift':
      return `${of('shown').length} new-topic warnings · ${of('copied').length} copied to a new session, ${of('dismissed').length} dismissed`
    case 'long-turn-notify':
      return `${of('notified').length} notifications (${where('notified', 'isError', true)} for errors)`
    case 'agent-fleet':
      return `${of('stopped').length} agents stopped from the pane`
    case 'worktree-janitor':
      return `${of('found').length} scans found merged worktrees · ${sum('cleaned', 'removed')} removed`
    case 'mod-faults':
      return `${of('fault').length} hook faults recorded across mods`
    case 'where-am-i':
      return `${of('park').length} parks · ${of('parked-shown').length} parked notes shown on return`
    default: {
      const counts = new Map<string, number>()
      for (const r of rows) counts.set(r.event, (counts.get(r.event) ?? 0) + 1)

      return [...counts].map(([e, n]) => `${n} ${e}`).join(', ')
    }
  }
}

// v2 rows the shared metrics block writes for every mod; everything else is an outcome row
const TELEMETRY = new Set(['loaded', 'turn'])

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
  // mod-faults records each hook fault as its own row, naming the mod that faulted
  const faults = new Map<string, number>()
  for (const r of rows) {
    if (r.mod !== 'mod-faults' || r.event !== 'fault' || typeof r.plugin !== 'string') continue
    const of = r.plugin.split('@')[0]!
    faults.set(of, (faults.get(of) ?? 0) + 1)
  }
  const quiet: string[] = []
  for (const mod of [...new Set([...names, ...faults.keys()])].sort()) {
    const mine = rows.filter(r => r.mod === mod)
    const acts = mine.filter(r => !TELEMETRY.has(r.event))
    const faulted = faults.get(mod) ? ` · ${faults.get(mod)} fault${faults.get(mod) === 1 ? '' : 's'}` : ''
    if (mine.length === 0 && !faulted) quiet.push(mod)
    else out.push(`  ${mod}: ${acts.length ? line(mod, acts) : 'no outcomes'}${mine.length ? telemetry(mine) : ''}${faulted}`)
  }
  if (quiet.length) out.push(`  No events: ${quiet.join(', ')}`)
  out.push('Token figures for notes are estimates (4 characters per token); $ are list prices.')

  return out.join('\n')
}
