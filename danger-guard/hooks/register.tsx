import type { EngineInterface, On, Register } from 'claude-code'

import { assess, isProtected } from './analyze.ts'
import type { Risk } from './analyze.ts'

const RUN = 'Run it'
const CANCEL = 'Cancel'
const MAX_QUESTION = 1800
const PREVIEW_TIMEOUT_MS = 5000
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin'

const isPattern = (t: string) => /[*?[\]$`{}~]/.test(t)

const resolveCwd = (session: string, at: string | undefined) =>
  at === undefined ? session : at.startsWith('/') ? at : `${session}/${at}`

const head = (text: string, n: number) => {
  const lines = text.split('\n').filter(Boolean)

  return lines.length > n ? [...lines.slice(0, n), `… ${lines.length - n} more`].join('\n') : lines.join('\n')
}

async function preview($: EngineInterface, risk: Risk, sessionCwd: string): Promise<string> {
  const cwd = resolveCwd(sessionCwd, risk.cwd)
  const run = async (argv: string[]) => {
    try {
      // The hook runtime spawns without a usable PATH, so resolve binaries through /bin/sh.
      const r = await $.process.run(['/bin/sh', '-c', `PATH="${SAFE_PATH}:$PATH" exec "$@"`, 'danger-guard', ...argv], {
        cwd,
        timeoutMs: PREVIEW_TIMEOUT_MS,
      })

      return r.exitCode === 0 ? r.stdout.trim() : `(${r.stderr.trim() || `exit ${r.exitCode}`})`
    } catch (err) {
      return `(preview failed: ${err instanceof Error ? err.message : String(err)})`
    }
  }
  const p = risk.preview

  switch (p.kind) {
    case 'rm': {
      const exact = p.targets.filter(t => !isPattern(t))
      const patterns = p.targets.filter(isPattern)
      const out: string[] = []
      if (exact.length) {
        const files = await run(['find', ...exact, '-type', 'f'])
        const count = files.startsWith('(') ? files : `${files.split('\n').filter(Boolean).length} files`
        out.push(`Would delete: ${count}`, head(await run(['du', '-sh', ...exact]), 8))
      }
      if (patterns.length) out.push(`Not expanded in preview: ${patterns.join(' ')}`)

      return out.join('\n')
    }
    case 'push': {
      const lost = await run(['git', 'log', '--oneline', '-10', 'HEAD..@{u}'])

      return `Remote commits not in HEAD, lost by a force push (as of last fetch):\n${lost || 'none'}`
    }
    case 'discard': {
      const status = await run(['git', 'status', '--short'])
      const stat = await run(['git', 'diff', '--shortstat'])

      return status ? `Uncommitted changes that would be lost:\n${head(status, 10)}\n${stat}` : 'Working tree is clean.'
    }
    case 'clean': {
      const would = await run(['git', 'clean', '-nd', ...(p.withIgnored ? ['-x'] : [])])

      return would ? `git clean would remove:\n${head(would, 12)}` : 'git clean would remove nothing.'
    }
    case 'branch': {
      const unpushed = await run(['git', 'log', '--oneline', '-10', p.branch, '--not', '--remotes'])

      return `Commits on ${p.branch} not on any remote:\n${unpushed || 'none'}`
    }
    case 'none':
      return ''
  }
}

// True only when the person picked "Run it"; dismissal, "Other" text or no one to ask is a no.
async function confirm($: EngineInterface, question: string): Promise<boolean> {
  try {
    const answer = await $.ui.ask(question.slice(0, MAX_QUESTION), { header: 'Risky', options: [RUN, CANCEL] })

    track($, 'danger-guard', 'asked', { answer: answer === RUN ? 'run' : 'cancel', chars: question.length })

    return answer === RUN
  } catch {
    return false
  }
}

// A guard that fails must hold the call, not wave it through
const heldOnError = (tool: string, error: unknown) => ({
  deny:
    `danger-guard could not check this ${tool} call (${message(error)}), so it was held. ` +
    'Ask the user to run it themselves or to turn the guard off with /guard off.',
})

const denial = (reasons: string[]) =>
  `danger-guard held this (${reasons.join('; ')}) and the user did not approve it. ` +
  `Do not retry it in another form; tell the user what you wanted to do and ask how to proceed.`

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
  logTurns(on)

  // Resets to on with every reload, so a forgotten /guard off doesn't stick
  let isOn = true

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'guard', description: 'danger-guard: /guard off or /guard on for this session' })

    return next(e)
  })

  on('command.run', { command: 'guard' }, async ($, e) => {
    count($, 'command.run{guard}')
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') isOn = arg === 'on'

    return { text: `danger-guard is ${isOn ? 'on' : 'OFF for this session'}.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    count($, 'tool.call{Bash}')
    if (!isOn) return next(e)
    const risks = assess(e.command)
    if (risks.length === 0) return next(e)

    const sessionCwd = await $.session.cwd().catch(() => '.')
    const previews = (await Promise.all(risks.map(r => preview($, r, sessionCwd)))).filter(Boolean)
    const atNote = risks.some(r => r.cwd !== undefined) ? '' : `\n(previews run in ${sessionCwd})`
    const question = [
      `Risky: ${risks.map(r => r.reason).join('; ')}`,
      `$ ${e.command.length > 400 ? e.command.slice(0, 400) + '…' : e.command}`,
      ...previews,
    ].join('\n\n') + atNote + '\n\nRun it?'

    return (await confirm($, question)) ? next(e) : { deny: denial(risks.map(r => r.reason)) }
  }).catch(($, e, next) => (next.called ? next(e) : heldOnError(e.tool, next.error)))

  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    if (!isOn || (e.tool !== 'Write' && e.tool !== 'Edit' && e.tool !== 'NotebookEdit')) return next(e)
    const path = 'file_path' in e ? String(e.file_path) : 'notebook_path' in e ? String(e.notebook_path) : ''
    if (!isProtected(path)) return next(e)

    const exists = await $.fs.exists(path).catch(() => false)
    const what = exists ? 'changes an existing protected file' : 'creates a file in a protected location'
    const question = `Risky: ${e.tool} ${what}\n\n${path}\n\nAllow it?`

    return (await confirm($, question)) ? next(e) : { deny: denial([`${e.tool} on protected path ${path}`]) }
  }).catch(($, e, next) => (next.called ? next(e) : heldOnError(e.tool, next.error)))
}
