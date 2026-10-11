// Pure helpers: no `$`, so tests call them directly.

// The engine's words when an account usage limit stops a turn or an agent.
// Per-minute API rate limits are retried by the engine and don't match.
export const LIMIT_HIT = /hit your (?:session|usage|weekly|5-hour|daily|opus) limit|usage limit reached|limit will reset/i

const FAILED_AGENT = /Agent "([^"]+)" failed/g

// The agents a task notification reports as failed.
export const failedAgents = (text: string): string[] => [...text.matchAll(FAILED_AGENT)].map(m => m[1]!)

// "resets 12am", "resets 3:30pm (UTC)": the next such local time after `now`.
// The zone in brackets is assumed to be this machine's, which it is for a local session.
export function parseReset(text: string, now: number): number | undefined {
  const m = text.match(/resets\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (!m) return undefined
  let hour = Number(m[1]) % 12
  if (m[3]!.toLowerCase() === 'pm') hour += 12
  const at = new Date(now)
  at.setHours(hour, Number(m[2] ?? 0), 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)

  return at.getTime()
}

export type Window = { kind: string; percentUsed: number; resetsAt?: string }

// When the spent window resets, from the engine's own figures.
export function resetFromWindows(windows: readonly Window[], now: number): number | undefined {
  const spent = windows.filter(w => w.percentUsed >= 95 && w.resetsAt)
  const times = spent.map(w => Date.parse(w.resetsAt!)).filter(t => Number.isFinite(t) && t > now)

  return times.length ? Math.max(...times) : undefined
}

export function resumePrompt(agents: readonly string[]): string {
  const which = agents.length
    ? `Background agents that stopped on the limit: ${agents.map(a => `"${a}"`).join(', ')}.`
    : 'The main turn stopped on the limit.'

  return [
    'The usage limit that interrupted the work has reset (limit-guard auto-resume).',
    which,
    'Resume where the work stopped. For each interrupted agent, check its worktree and branch first (git status, git log), keep what it committed, and continue or restart only what did not finish.',
    'If nothing was actually in progress, say so in one line and stop.',
  ].join('\n')
}

export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
