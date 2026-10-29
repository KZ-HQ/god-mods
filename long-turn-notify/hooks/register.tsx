import type { EngineInterface, On, Register } from 'claude-code'

// Failed turns notify once they ran at least this long, whatever the threshold
const ERROR_MIN_SECONDS = 15

// argv carries the text, so nothing in it is parsed as AppleScript
const SCRIPT = [
  'on run argv',
  'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv) sound name "Glass"',
  'end run',
]

const duration = (ms: number) => {
  const s = Math.round(ms / 1000)

  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

async function notify($: EngineInterface, body: string, title: string, subtitle: string) {
  try {
    await $.process.run(['osascript', ...SCRIPT.flatMap(l => ['-e', l]), body, title, subtitle], { timeoutMs: 5000 })
  } catch {
    // Not macOS, or osascript refused: the toast below still shows
  }
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

// <text: generated from shared/text.ts by shared/sync.sh>
// The first non-blank line, trimmed, cut to max characters with an ellipsis
function firstLine(text: string, max = 90): string {
  const line = text.split('\n').map(l => l.trim()).find(Boolean) ?? ''

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
// </text>

// The reply's first line without markdown marks, for a notification
const summaryLine = (text: string) => firstLine(text.replace(/[#*`>_]/g, ''), 180) || 'Done.'

const KIND_WORDS: Record<string, string> = {
  rate_limit: 'rate limit',
  overloaded: 'API overloaded',
  authentication_failed: 'authentication failed',
  oauth_org_not_allowed: 'organization not allowed',
  account_on_hold: 'account on hold',
  verification_required: 'verification required',
  billing_error: 'billing error',
  invalid_request: 'invalid request',
  model_not_found: 'model not found',
  server_error: 'server error',
  max_output_tokens: 'output limit reached',
  cloud_credential_error: 'cloud credentials error',
}

// Set by whichever of StopFailure / an error turn.complete notifies first, so a dying turn notifies once
let failureNotified = false

export const register: Register = (on, options) => {
  logLoaded(on)

  // A new turn starts clean, so a stale flag never suppresses a later failure
  on('turn.start', async ($, e, next) => {
    count($, 'turn.start')
    failureNotified = false

    return next(e)
  })

  const threshold = Number(options.thresholdSeconds ?? 60)

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted) return done

    const seconds = e.durationMs / 1000
    const isError = e.reason === 'error' || e.reason === 'refusal'
    if (e.reason === 'error' && failureNotified) {
      failureNotified = false

      return done
    }
    if (e.reason === 'error') failureNotified = true
    if (seconds < (isError ? ERROR_MIN_SECONDS : threshold)) return done

    const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? 'Claude Code'
    const subtitle = `${isError ? 'Stopped with an error' : 'Finished'} after ${duration(e.durationMs)}`
    const body = isError ? 'The turn ended with an error. Check the session.' : summaryLine(e.answer)

    // The desktop app already sends its own "task complete" banner
    const surfaces = await $.session.surfaces()
    if (!surfaces.includes('desktop')) await notify($, body, `Claude · ${project}`, subtitle)
    $.ui.toast(subtitle)
    track($, 'long-turn-notify', 'notified', { seconds: Math.round(seconds), isError })

    return done
  })

  // The turn died on an API error: say so at once, whatever its length. Only the error kind is used, never its text
  on('classic.StopFailure', async ($, e, next) => {
    count($, 'classic.StopFailure')
    const done = await next(e)
    track($, 'long-turn-notify', 'api_error', { kind: e.error })
    if (failureNotified) {
      failureNotified = false

      return done
    }
    failureNotified = true
    const why = KIND_WORDS[e.error] ?? 'unknown error'
    const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? 'Claude Code'
    const subtitle = `Failed: ${why}`
    const surfaces = await $.session.surfaces()
    if (!surfaces.includes('desktop')) await notify($, 'The turn ended on an API error. Check the session.', `Claude · ${project}`, subtitle)
    $.ui.toast(subtitle)

    return done
  })

  // A tool call failed or was interrupted: tool name, whether interrupted and how long it ran, never input or error text
  on('classic.PostToolUseFailure', async ($, e, next) => {
    count($, 'classic.PostToolUseFailure')
    track($, 'long-turn-notify', 'tool_failure', { tool: e.tool_name, interrupted: e.is_interrupt === true, ms: e.duration_ms ?? null })

    return next(e)
  })

  // Claude is blocked on you (a permission prompt, a question, idle input): the desktop app has its own banners
  on('classic.Notification', async ($, e, next) => {
    count($, 'classic.Notification')
    const done = await next(e)
    const surfaces = await $.session.surfaces()
    if (surfaces.includes('desktop')) return done
    const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? 'Claude Code'
    await notify($, e.message, `Claude · ${project}`, e.title ?? 'Needs you')

    return done
  })
}
