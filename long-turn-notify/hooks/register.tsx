import type { EngineInterface, Register } from 'claude-code'

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

const firstLine = (text: string) =>
  text.split('\n').map(l => l.replace(/[#*`>_]/g, '').trim()).find(Boolean)?.slice(0, 180) ?? 'Done.'

async function notify($: EngineInterface, body: string, title: string, subtitle: string) {
  try {
    await $.process.run(['osascript', ...SCRIPT.flatMap(l => ['-e', l]), body, title, subtitle], { timeoutMs: 5000 })
  } catch {
    // Not macOS, or osascript refused: the toast below still shows
  }
}

export const register: Register = (on, options) => {
  const threshold = Number(options.thresholdSeconds ?? 60)

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.isAborted) return done

    const seconds = e.durationMs / 1000
    const isError = e.reason === 'error' || e.reason === 'refusal'
    if (seconds < (isError ? ERROR_MIN_SECONDS : threshold)) return done

    const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? 'Claude Code'
    const subtitle = `${isError ? 'Stopped with an error' : 'Finished'} after ${duration(e.durationMs)}`
    const body = isError ? 'The turn ended with an error. Check the session.' : firstLine(e.answer)

    // The desktop app already sends its own "task complete" banner
    const surfaces = await $.session.surfaces()
    if (!surfaces.includes('desktop')) await notify($, body, `Claude · ${project}`, subtitle)
    $.ui.toast(subtitle)
    track($, 'long-turn-notify', 'notified', { seconds: Math.round(seconds), isError })

    return done
  })

  // Claude is blocked on you (a permission prompt, a question, idle input): the desktop app has its own banners
  on('classic.Notification', async ($, e, next) => {
    const done = await next(e)
    const surfaces = await $.session.surfaces()
    if (surfaces.includes('desktop')) return done
    const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? 'Claude Code'
    await notify($, e.message, `Claude · ${project}`, e.title ?? 'Needs you')

    return done
  })
}
