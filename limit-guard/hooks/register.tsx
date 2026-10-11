import type { EngineInterface, On, Register } from 'claude-code'

import { LIMIT_HIT, clock, failedAgents, parseReset, resetFromWindows } from './reset.ts'

// Ask before a new agent once either window is this full, in percent
const FIVE_HOUR_ASK_AT = 80
const WEEKLY_ASK_AT = 90
// A recorded limit hit older than this is dropped
const STALE_MS = 12 * 60 * 60 * 1000

const STORE_KEY = 'hit'
const RUNNING = new Set(['pending', 'running', 'waiting'])
const START = 'Start it'
const HOLD = 'Hold off'

// What the last limit hit stopped, and when it resets
type Hit = { at?: number; agents: string[]; recordedAt: number }

async function readHit($: EngineInterface): Promise<Hit | undefined> {
  const v = await $.store.get(STORE_KEY)

  return v && typeof v === 'object' && Array.isArray((v as Hit).agents) ? (v as Hit) : undefined
}

async function clearHit($: EngineInterface) {
  await $.store.delete(STORE_KEY)
  $.ui.status(undefined)
}

const resetText = (hit: Hit) => (hit.at ? `resets ${clock(hit.at)}` : 'reset time unknown')

async function record($: EngineInterface, text: string, agents: string[]) {
  const now = await $.clock.now()
  const { rateLimits } = await $.session.usage()
  const prior = await readHit($)
  const hit: Hit = {
    at: resetFromWindows(rateLimits, now) ?? parseReset(text, now) ?? prior?.at,
    agents: [...new Set([...(prior?.agents ?? []), ...agents])],
    recordedAt: now,
  }
  await $.store.set(STORE_KEY, hit)
  $.ui.status(`limit-guard: usage limit hit, ${resetText(hit)}. /limit-guard:resume continues the work`)
  if (!prior) track($, 'limit-guard', 'hit', { agents: hit.agents.length })
  if (!prior) $.ui.toast(`limit-guard: usage limit hit (${resetText(hit)}). Run /limit-guard:resume after it resets.`, { timeoutMs: 10000 })
}

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
      name: 'limit',
      description: 'Usage windows and what the last limit hit stopped; /limit clear forgets it. /limit-guard:resume continues the work',
    })
    const hit = await readHit($)
    if (hit) {
      const now = await $.clock.now()
      if (now - hit.recordedAt > STALE_MS) await clearHit($)
      else $.ui.status(`limit-guard: work stopped on the usage limit (${resetText(hit)}). /limit-guard:resume continues it`)
    }

    return next(e)
  })

  on('command.run', { command: 'limit' }, async ($, e) => {
    count($, 'command.run')
    const arg = e.args.trim()
    const hit = await readHit($)

    if (arg === 'clear') {
      await clearHit($)
    track($, 'limit-guard', 'resume', { hadHit: !!hit })

      return { text: 'Forgot the recorded limit hit.' }
    }
    if (arg === 'resume') {
      // A command with no turn can't start one reliably (the Code tab ends the run with it), so resuming is a prompt command
      return { text: 'Type /limit-guard:resume to continue the interrupted work.' }
    }
    const { rateLimits } = await $.session.usage()
    const windows = rateLimits.map(w => `${w.kind}: ${w.percentUsed}%${w.resetsAt ? `, resets ${clock(Date.parse(w.resetsAt))}` : ''}`)

    return {
      text: [
        ...(windows.length ? windows : ['No usage windows reported yet (they appear after the first response).']),
        hit
          ? `Last limit hit (${resetText(hit)}) stopped ${hit.agents.length ? hit.agents.join(', ') : 'the main turn'}. /limit-guard:resume continues it.`
          : 'No limit hit recorded.',
      ].join('\n'),
    }
  })

  on('command.run', { command: 'limit-guard:resume' }, async ($, e, next) => {
    count($, 'command.run')
    const hit = await readHit($)
    await clearHit($)
    const recorded = hit?.agents.length ? `background agents ${hit.agents.map(a => `"${a}"`).join(', ')}` : 'the main turn'
    const extra = e.args.trim()

    return next({ ...e, args: extra ? `${recorded}. Also: ${extra}` : recorded })
  })

  // Ask before starting an agent the remaining window may not cover
  on('agent.spawn', async ($, e, next) => {
    count($, 'agent.spawn')
    const { rateLimits } = await $.session.usage()
    const five = rateLimits.find(w => w.kind === 'five_hour')
    const week = rateLimits.find(w => w.kind === 'seven_day')
    const hot = [
      five && five.percentUsed >= FIVE_HOUR_ASK_AT
        ? `5-hour window at ${five.percentUsed}%${five.resetsAt ? ` (resets ${clock(Date.parse(five.resetsAt))})` : ''}`
        : '',
      week && week.percentUsed >= WEEKLY_ASK_AT ? `weekly window at ${week.percentUsed}%` : '',
    ].filter(Boolean)
    if (hot.length === 0) return next(e)

    let answer = ''
    try {
      answer = await $.ui.ask(`${hot.join('; ')}. Start agent "${e.description}" anyway? It may stop partway on the limit.`, {
        header: 'Usage',
        options: [START, HOLD],
      })
    } catch {
      answer = ''
    }

    track($, 'limit-guard', 'asked', { answer: answer === START ? 'start' : 'hold' })

    return answer === START
      ? next(e)
      : { deny: `limit-guard: the user held off starting "${e.description}" because the usage window is nearly spent (${hot.join('; ')}). Ask before retrying.` }
  })

  // Claude Code warns the main loop before the limit cuts it off; agents running then get cut off too
  on('session.append', async ($, e, next) => {
    count($, 'session.append')
    if (e.agentId === undefined && e.message.role === 'user') {
      const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
      if (LIMIT_HIT.test(text)) {
        const running = (await $.agent.list().catch(() => [])).filter(a => RUNNING.has(a.status)).map(a => a.description)
        await record($, text, running).catch(() => undefined)
      }
    }

    return next(e)
  })

  // A background agent stopped on the limit: its notification says so
  on('prompt.submit', async ($, e, next) => {
    count($, 'prompt.submit')
    if (e.origin.kind === 'task-notification' && LIMIT_HIT.test(e.text)) await record($, e.text, failedAgents(e.text))

    return next(e)
  })

  // The main turn stopped on the limit
  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'error' && LIMIT_HIT.test(e.answer)) await record($, e.answer, [])

    return done
  })
}
