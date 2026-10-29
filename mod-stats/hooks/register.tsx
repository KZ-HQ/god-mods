import type { EngineInterface, EventName, Next, On, Register } from 'claude-code'

import { alerts, parse, report } from './stats.ts'

const DAY_MS = 86_400_000
// The newest lines are enough for any window /mod-stats shows
const READ = 'tail -n 50000 "$HOME/.claude/mods/metrics.jsonl" 2>/dev/null || true'
// The log only grows, and nothing reads past those lines: past 10 MB, keep just them. An append landing
// between tail and mv is lost, which a metrics row can afford.
export const TRIM =
  'f="$HOME/.claude/mods/metrics.jsonl"; [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 10000000 ] && tail -n 50000 "$f" > "$f.trim" && mv "$f.trim" "$f"; true'

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

// <modlist: generated from shared/modlist.ts by shared/sync.sh>
async function godModList($: EngineInterface): Promise<{ names: string[]; file: string } | undefined> {
  try {
    const home = await $.env.get('HOME')
    const known = JSON.parse(await $.fs.read(`${home}/.claude/plugins/known_marketplaces.json`))
    const root = known['god-mods']?.installLocation ?? known['god-mods']?.source?.path
    if (!root) return undefined
    const file = `${root}/.claude-plugin/marketplace.json`
    const names = (JSON.parse(await $.fs.read(file)).plugins as { name: string }[]).map(p => p.name)

    return names.length ? { names, file } : undefined
  } catch {
    return undefined
  }
}
// </modlist>

// Without the marketplace manifest, only plugins installed as <name>@god-mods count
let GOD_MODS = new Set<string>()
let listSource = 'unavailable (matching @god-mods installs only)'
// This mod, and the mod-faults it replaced, watch the others
const SELF = new Set(['mod-stats', 'mod-faults'])

async function loadModList($: EngineInterface) {
  const list = await godModList($)
  if (!list) return
  GOD_MODS = new Set(list.names.filter(n => !SELF.has(n)))
  listSource = list.file
}

const nameOf = (plugin: string) => plugin.split('@')[0]!
const isGodMod = (plugin: string) => !SELF.has(nameOf(plugin)) && (GOD_MODS.has(nameOf(plugin)) || plugin.endsWith('@god-mods'))

const FAULTS = new Set(['skipped', 'kept', 'expired', 'caught', 'rejected'])
// The third fault from one mod in a session toasts, once
const ALERT_AT = 3
const seen = new Set<string>()
const faults = new Map<string, number>()
// This turn's own hook time per mod, from next.trace's ms (time in next() taken out): flushed as one latency row
const lat = new Map<string, { calls: number; ms: number; max: number; maxEvent: string }>()

// One short lowercase leading word of the reason at most (e.g. "timeout"): reasons can quote tool input or
// error text, which metrics rows never carry
const reasonKind = (reason: string | undefined) => (reason ? (reason.match(/^[a-z][a-z-]{0,23}(?=[:\s(]|$)/)?.[0] ?? 'other') : 'none')

function record($: EngineInterface, plugin: string, hookEvent: string, outcome: string, reason: string | undefined) {
  const n = (faults.get(plugin) ?? 0) + 1
  faults.set(plugin, n)
  track($, 'mod-stats', 'fault', { plugin, hookEvent, outcome, reasonKind: reasonKind(reason) })
  if (n === ALERT_AT) $.ui.toast(`mod-stats: ${plugin} has faulted ${n} times this session (/mod-stats)`)
}

async function watch<N extends EventName>($: EngineInterface, e: Parameters<Next<N>>[0], next: Next<N>) {
  try {
    return await next(e)
  } finally {
    try {
      for (const t of next.trace) {
        if (!isGodMod(t.plugin)) continue
        const mod = nameOf(t.plugin)
        seen.add(mod)
        if (FAULTS.has(t.outcome) && !t.reason?.startsWith('bypassed')) record($, mod, t.event, t.outcome, t.reason)
        if (t.reason?.startsWith('bypassed')) continue
        const l = lat.get(mod) ?? { calls: 0, ms: 0, max: 0, maxEvent: '' }
        l.calls += 1
        l.ms += t.ms
        if (t.ms > l.max) Object.assign(l, { max: t.ms, maxEvent: t.event })
        lat.set(mod, l)
      }
    } catch {
      // Never let bookkeeping break the event
    }
  }
}

function flushLatency($: EngineInterface) {
  if (!lat.size) return
  const mods = Object.fromEntries([...lat].map(([m, l]) => [m, { calls: l.calls, ms: Math.round(l.ms), max: Math.round(l.max), maxEvent: l.maxEvent }]))
  lat.clear()
  track($, 'mod-stats', 'latency', { mods })
}

// Every god-mod hooks session.start, so once it settles, a listed mod missing from the trace is
// above this one in the chain (or not enabled): its faults and latency are invisible here.
const blind = () => [...GOD_MODS].filter(m => !seen.has(m)).sort()
const FIX = 'Move "mod-stats@god-mods" to the top of enabledPlugins in ~/.claude/settings.json: plugins nest in that order, first outermost.'

function thisSession(): string {
  const counted = [...faults].map(([p, n]) => `${p} ${n}`).join(', ') || 'none'
  const unseen = blind()
  const blindText = unseen.length ? `\nNot visible (above this mod, or not enabled): ${unseen.join(', ')}. ${FIX}` : ''

  return `This session: faults ${counted}; watching ${seen.size} of ${GOD_MODS.size} mods (list: ${listSource})${blindText}`
}

const ALERTED_KEY = 'alerted'

// Toasts mods that turned dormant or slow since the last toast; a mod that recovers and slips again toasts again
async function alertNew($: EngineInterface) {
  const r = await $.process.run(['/bin/sh', '-c', READ], { timeoutMs: 10_000 })
  const now = alerts(parse(r.stdout), await $.clock.now(), [...GOD_MODS])
  const before = new Set(((await $.store.get(ALERTED_KEY)) as string[] | undefined) ?? [])
  const fresh = now.filter(a => !before.has(a.key))
  await $.store.set(ALERTED_KEY, now.map(a => a.key))
  if (!fresh.length) return
  track($, 'mod-stats', 'alert', { kinds: fresh.map(a => a.key.split(':')[0]), n: fresh.length })
  $.ui.toast(`mod-stats: ${fresh.map(a => a.text).join('; ')} (/mod-stats)`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await loadModList($)
    await $.command.register({ name: 'mod-stats', description: 'What each mod did, cost and saved, its faults and hook time: /mod-stats [days] [here]' })
    void $.process.run(['/bin/sh', '-c', TRIM], { timeoutMs: 10_000 }).catch(() => undefined)
    void alertNew($).catch(() => undefined)
    const started = await watch($, e, next)
    const unseen = blind()
    if (unseen.length) {
      track($, 'mod-stats', 'blind', { mods: unseen, of: GOD_MODS.size })
      $.ui.toast(`mod-stats: can't see faults in ${unseen.length} of ${GOD_MODS.size} god-mods above it in the chain (/mod-stats)`)
    }

    return started
  })

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await watch($, e, next)
    flushLatency($)

    return done
  })

  on('command.run', { command: 'mod-stats' }, async ($, e) => {
    count($, 'command.run{mod-stats}')
    const args = e.args.trim().split(/\s+/).filter(Boolean)
    const days = Math.max(1, Number(args.find(a => /^\d+$/.test(a)) ?? 7))
    const project = args.includes('here') ? (await $.session.cwd()).split('/').filter(Boolean).pop() : undefined
    const r = await $.process.run(['/bin/sh', '-c', READ], { timeoutMs: 10_000 })
    const rows = parse(r.stdout)
    if (rows.length === 0) return { text: `No mod events recorded yet. They collect in ~/.claude/mods/metrics.jsonl as the mods act.\n${thisSession()}` }

    const mods = (await godModList($))?.names ?? []

    return { text: `${report(rows, (await $.clock.now()) - days * DAY_MS, days, project, mods)}\n${thisSession()}` }
  })

  // coverage: observer — one watch() hook on every other event; tests drive it through tool.call
  on('session.end', watch)
  on('session.measure', watch)
  on('session.append', watch)
  on('turn.start', watch)
  on('prompt.submit', watch)
  on('prompt.compose', watch)
  on('tool.call', watch)
  on('tool.describe', watch)
  on('agent.spawn', watch)
  on('command.run', watch)
  on('ui.render', watch)
  on('ui.close', watch)
}
