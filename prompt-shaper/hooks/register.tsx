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

export const register: Register = on => {
  let toolchain = ''
  let lastGit: string | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'shorthand',
      description: 'List shorthand, or: /shorthand add <term> = <meaning>, /shorthand rm <term>',
    })
    toolchain = await detectToolchain($)
    if (toolchain) track($, 'prompt-shaper', 'toolchain', { chars: toolchain.length })

    return next(e)
  })

  on('command.run', { command: 'shorthand' }, async ($, e) => {
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

  on('prompt.compose', async (_$, e, next) => {
    const composed = await next(e)
    if (!toolchain) return composed

    return { sections: [...composed.sections, { id: SECTION_ID, text: toolchain, scope: 'session' as const }] }
  })
}
