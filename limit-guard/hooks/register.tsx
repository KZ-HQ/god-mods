import type { EngineInterface, Register } from 'claude-code'

import { LIMIT_HIT, clock, failedAgents, parseReset, resetFromWindows } from './reset.ts'

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
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
    const hit = await readHit($)
    await clearHit($)
    const recorded = hit?.agents.length ? `background agents ${hit.agents.map(a => `"${a}"`).join(', ')}` : 'the main turn'
    const extra = e.args.trim()

    return next({ ...e, args: extra ? `${recorded}. Also: ${extra}` : recorded })
  })

  // Ask before starting an agent the remaining window may not cover
  on('agent.spawn', async ($, e, next) => {
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
    if (e.origin.kind === 'task-notification' && LIMIT_HIT.test(e.text)) await record($, e.text, failedAgents(e.text))

    return next(e)
  })

  // The main turn stopped on the limit
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'error' && LIMIT_HIT.test(e.answer)) await record($, e.answer, [])

    return done
  })
}
