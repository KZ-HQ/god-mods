import type { EngineInterface, Register } from 'claude-code'

import { assess, isProtected } from './analyze.ts'
import type { Risk } from './analyze.ts'

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

const RUN = 'Run it'
const CANCEL = 'Cancel'
const MAX_QUESTION = 1800
const PREVIEW_TIMEOUT_MS = 5000

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
      const r = await $.process.run(argv, { cwd, timeoutMs: PREVIEW_TIMEOUT_MS })

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

    track($, 'danger-guard', 'asked', { answer: answer === RUN ? 'run' : 'cancel', what: question.split('\n')[0]?.slice(0, 120) })

    return answer === RUN
  } catch {
    return false
  }
}

// A guard that fails must hold the call, not wave it through
const heldOnError = (tool: string, error: unknown) => ({
  deny:
    `danger-guard could not check this ${tool} call (${error instanceof Error ? error.message : String(error)}), so it was held. ` +
    'Ask the user to run it themselves or to turn the guard off with /guard off.',
})

const denial = (reasons: string[]) =>
  `danger-guard held this (${reasons.join('; ')}) and the user did not approve it. ` +
  `Do not retry it in another form; tell the user what you wanted to do and ask how to proceed.`

export const register: Register = on => {
  // Resets to on with every reload, so a forgotten /guard off doesn't stick
  let isOn = true

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'guard', description: 'danger-guard: /guard off or /guard on for this session' })

    return next(e)
  })

  on('command.run', { command: 'guard' }, async (_$, e) => {
    const arg = e.args.trim()
    if (arg === 'off' || arg === 'on') isOn = arg === 'on'

    return { text: `danger-guard is ${isOn ? 'on' : 'OFF for this session'}.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
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
    if (!isOn || (e.tool !== 'Write' && e.tool !== 'Edit' && e.tool !== 'NotebookEdit')) return next(e)
    const path = 'file_path' in e ? String(e.file_path) : 'notebook_path' in e ? String(e.notebook_path) : ''
    if (!isProtected(path)) return next(e)

    const exists = await $.fs.exists(path).catch(() => false)
    const what = exists ? 'changes an existing protected file' : 'creates a file in a protected location'
    const question = `Risky: ${e.tool} ${what}\n\n${path}\n\nAllow it?`

    return (await confirm($, question)) ? next(e) : { deny: denial([`${e.tool} on protected path ${path}`]) }
  }).catch(($, e, next) => (next.called ? next(e) : heldOnError(e.tool, next.error)))
}
