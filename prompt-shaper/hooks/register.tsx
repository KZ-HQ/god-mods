import type { EngineInterface, On, Register } from 'claude-code'

const STORE_KEY = 'shorthand'
const SECTION_ID = 'prompt-shaper:toolchain'
const MAX_GIT_FILES = 8

type Shorthand = Record<string, string>

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function loadShorthand($: EngineInterface): Promise<Shorthand> {
  const v = await $.store.get(STORE_KEY)

  return v && typeof v === 'object' ? (v as Shorthand) : {}
}

// Which of the person's shorthand terms the prompt uses, as whole words.
function expansionsIn(text: string, map: Shorthand): string[] {
  return Object.entries(map)
    .filter(([term]) => new RegExp(`(^|[^\\w-])${escape(term)}([^\\w-]|$)`, 'i').test(text))
    .map(([term, meaning]) => `"${term}" = ${meaning}`)
}

async function gitSummary($: EngineInterface): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', 'status', '--porcelain=v1', '--branch'], { timeoutMs: 3000 })
    if (r.exitCode !== 0) return undefined
    const [branchLine = '', ...files] = r.stdout.split('\n').filter(Boolean)
    const branch = branchLine.replace(/^## /, '')
    const shown = files.slice(0, MAX_GIT_FILES).map(f => f.trim()).join(', ')
    const more = files.length > MAX_GIT_FILES ? `, +${files.length - MAX_GIT_FILES} more` : ''

    return files.length === 0
      ? `Git now: ${branch}; working tree clean.`
      : `Git now: ${branch}; ${files.length} changed: ${shown}${more}.`
  } catch {
    return undefined
  }
}

// Facts about how to run things here, read once so the system prompt stays cache-stable.
async function detectToolchain($: EngineInterface): Promise<string> {
  const has = (p: string) => $.fs.exists(p).catch(() => false)
  const facts: string[] = []

  if (await has('uv.lock')) facts.push('Python via uv: run tools with `uv run <tool>` (e.g. `uv run pytest`), add deps with `uv add`.')
  else if (await has('.venv/bin/python')) facts.push('Python venv at .venv: use `.venv/bin/python` and `.venv/bin/<tool>`.')

  if (await has('Makefile')) {
    const make = await $.fs.read('Makefile').catch(() => '')
    const targets = [...make.matchAll(/^([A-Za-z0-9][\w.-]*):(?!=)/gm)].map(m => m[1]).slice(0, 12)
    if (targets.length) facts.push(`Makefile targets: ${targets.join(', ')}.`)
  }

  if (await has('package.json')) {
    const pm = (await has('pnpm-lock.yaml')) ? 'pnpm' : (await has('yarn.lock')) ? 'yarn' : (await has('bun.lockb')) || (await has('bun.lock')) ? 'bun' : 'npm'
    try {
      const pkg = JSON.parse(await $.fs.read('package.json')) as { scripts?: Record<string, string> }
      const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 12)
      facts.push(`Node via ${pm}${scripts.length ? `; scripts: ${scripts.join(', ')}` : ''}.`)
    } catch {
      facts.push(`Node via ${pm}.`)
    }
  }

  for (const f of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
    if (await has(f)) {
      facts.push('Cloudflare Workers project: wrangler commands act locally unless given `--remote`, which hits production.')
      break
    }
  }
  if (await has('alembic.ini')) facts.push('Schema migrations via alembic.')

  return facts.length ? `Project toolchain (auto-detected at session start):\n- ${facts.join('\n- ')}` : ''
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
  logTurns(on)

  let toolchain = ''
  let lastGit: string | undefined

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({
      name: 'shorthand',
      description: 'List shorthand, or: /shorthand add <term> = <meaning>, /shorthand rm <term>',
    })
    toolchain = await detectToolchain($)
    if (toolchain) track($, 'prompt-shaper', 'toolchain', { chars: toolchain.length })

    return next(e)
  })

  on('command.run', { command: 'shorthand' }, async ($, e) => {
    count($, 'command.run{shorthand}')
    const map = await loadShorthand($)
    const add = e.args.match(/^\s*add\s+(.+?)\s*=\s*(.+)$/)
    const rm = e.args.match(/^\s*(rm|remove)\s+(.+?)\s*$/)

    if (add) {
      map[add[1]!] = add[2]!.trim()
      await $.store.set(STORE_KEY, map)

      return { text: `Shorthand saved: ${add[1]} = ${add[2]}` }
    }
    if (rm) {
      delete map[rm[2]!]
      await $.store.set(STORE_KEY, map)

      return { text: `Shorthand removed: ${rm[2]}` }
    }
    const lines = Object.entries(map).map(([k, v]) => `  ${k} = ${v}`)

    return { text: lines.length ? `Shorthand:\n${lines.join('\n')}` : 'No shorthand yet. Add one: /shorthand add app = the my-app project' }
  })

  on('prompt.submit', async ($, e, next) => {
    count($, 'prompt.submit')
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)

    const notes: string[] = []
    const used = expansionsIn(e.text, await loadShorthand($))
    if (used.length) notes.push(`The user's shorthand in this prompt: ${used.join('; ')}.`)

    // Only when it changed, so repeated prompts don't repeat it
    const git = await gitSummary($)
    if (git !== undefined && git !== lastGit) {
      notes.push(git)
      lastGit = git
    }

    if (notes.length) track($, 'prompt-shaper', 'inject', { chars: notes.join('\n').length, shorthand: used.length, git: notes.some(n => n.startsWith('Git now')) })

    return notes.length ? next({ ...e, context: [...(e.context ?? []), notes.join('\n')] }) : next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    count($, 'prompt.compose')
    const composed = await next(e)
    if (!toolchain) return composed

    return { sections: [...composed.sections, { id: SECTION_ID, text: toolchain, scope: 'session' as const }] }
  })
}
