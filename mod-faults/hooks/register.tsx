import type { EngineInterface, EventName, Next, On, Register } from 'claude-code'

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

async function loadModList($: EngineInterface) {
  const list = await godModList($)
  if (!list) return
  GOD_MODS = new Set(list.names.filter(n => n !== 'mod-faults'))
  listSource = list.file
}

const isGodMod = (plugin: string) => GOD_MODS.has(plugin.split('@')[0]!) || plugin.endsWith('@god-mods')
const FAULTS = new Set(['skipped', 'kept', 'expired', 'caught', 'rejected'])
// The third fault from one mod in a session toasts, once
const ALERT_AT = 3

const seen = new Set<string>()
const counts = new Map<string, number>()

// One short lowercase leading word of the reason at most (e.g. "timeout"): reasons can quote tool input or
// error text, which metrics rows never carry
const reasonKind = (reason: string | undefined) => (reason ? (reason.match(/^[a-z][a-z-]{0,23}(?=[:\s(]|$)/)?.[0] ?? 'other') : 'none')

function record($: EngineInterface, plugin: string, hookEvent: string, outcome: string, reason: string | undefined) {
  const n = (counts.get(plugin) ?? 0) + 1
  counts.set(plugin, n)
  track($, 'mod-faults', 'fault', { plugin, hookEvent, outcome, reasonKind: reasonKind(reason) })
  if (n === ALERT_AT) $.ui.toast(`mod-faults: ${plugin} has faulted ${n} times this session (/mod-faults)`)
}

async function watch<N extends EventName>($: EngineInterface, e: Parameters<Next<N>>[0], next: Next<N>) {
  try {
    return await next(e)
  } finally {
    try {
      for (const t of next.trace) {
        if (!isGodMod(t.plugin)) continue
        seen.add(t.plugin)
        if (FAULTS.has(t.outcome) && !t.reason?.startsWith('bypassed')) record($, t.plugin, t.event, t.outcome, t.reason)
      }
    } catch {
      // Never let fault bookkeeping break the event
    }
  }
}

// Every god-mod hooks session.start, so once it settles, a listed mod missing from the trace is
// above this one in the chain (or not enabled): its faults are invisible here.
const blind = () => [...GOD_MODS].filter(m => !seen.has(m)).sort()
const FIX = 'Move "mod-faults@god-mods" to the top of enabledPlugins in ~/.claude/settings.json: plugins nest in that order, first outermost.'

async function start($: EngineInterface, e: Parameters<Next<'session.start'>>[0], next: Next<'session.start'>) {
  count($, 'session.start')
  await loadModList($)
  await $.command.register({ name: 'mod-faults', description: 'Show god-mods faults this session and which mods are watched' })
  const started = await watch($, e, next)
  const unseen = blind()
  if (unseen.length) {
    track($, 'mod-faults', 'blind', { mods: unseen, of: GOD_MODS.size })
    $.ui.toast(`mod-faults: can't see faults in ${unseen.length} of ${GOD_MODS.size} god-mods above it in the chain (/mod-faults)`)
  }

  return started
}

async function turnEnd($: EngineInterface, e: Parameters<Next<'turn.complete'>>[0], next: Next<'turn.complete'>) {
  count($, 'turn.complete')

  return watch($, e, next)
}

async function report() {
  const faults = [...counts].map(([p, n]) => `  ${p}: ${n}`).join('\n') || '  none'
  const watched = [...seen].sort().join(', ') || 'none yet'
  const unseen = blind()
  const blindText = unseen.length ? `\nNot visible (above this mod, or not enabled): ${unseen.join(', ')}\n${FIX}` : ''

  return {
    text: `god-mods faults this session:\n${faults}\nWatched beneath this mod: ${watched}${blindText}\nMod list (${GOD_MODS.size}): ${listSource}\nRecorded in ~/.claude/mods/metrics.jsonl; /mod-stats shows faults across sessions`,
  }
}

export const register: Register = (on: On) => {
  on('session.start', start)
  on('turn.complete', turnEnd)
  on('command.run', { command: 'mod-faults' }, report)
  // coverage: observer — one watch() hook on every event; tests/faults.test.ts drives it through tool.call
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
