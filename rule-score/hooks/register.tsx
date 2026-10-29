import type { EngineInterface, On, Register } from 'claude-code'

// A rule mined from an instruction file, checkable from tool calls alone.
//   prefer: use `a` (a command, or a built-in tool name) instead of `b` (a command)
//   never:  never run `b`
//   tests:  run the tests after editing
type Rule = { kind: 'prefer' | 'never' | 'tests'; a?: string; b?: string }
type Tally = Record<string, [followed: number, violated: number]>
type Sessions = Record<string, { t: number; tally: Tally }>

const TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write']
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TEST_CMD = /(?:^|[\s/])(?:pytest|jest|vitest|mocha|rspec|phpunit|ctest)\b|\b(?:npm|pnpm|yarn|bun|deno|cargo|go|dotnet|mix|swift|gradle|mvn|make|just)\s+(?:run\s+)?test\b|\bplugin test\b|\btests?\.sh\b|\bci\.sh\b/
const KEEP_SESSIONS = 300
const ALERT_EVERY_MS = 7 * 24 * 3600 * 1000
const CANDIDATE = { violated: 3, rate: 0.5, sessions: 2 }

const NEG = String.raw`(?:never|don'?t|do not|avoid)`
const ALT = String.raw`(?:instead of|rather than|over)`
const CODE = '`([^`]+)`'

// A backticked pattern is usable only if it reads as a command: starts with a word, no placeholders.
function cmdPattern(raw: string): string | undefined {
  const s = raw.split(/\s<|\s\.\.\.|\s\[/)[0].trim()

  return /^[a-z][\w.+-]*(?: [\w./:=+-]+)*$/i.test(s) && !s.includes('/') ? s : undefined
}

function extract(text: string): Rule[] {
  const out: Rule[] = []
  for (const line of text.split('\n')) {
    let m: RegExpMatchArray | null
    if ((m = line.match(new RegExp(String.raw`\b${NEG}\s+(?:use|run|call)?\s*${CODE}[^\x60.]*?[;,]\s*(?:use|run)\s+${CODE}`, 'i')))) {
      const a = cmdPattern(m[2]), b = cmdPattern(m[1])
      if (a && b) out.push({ kind: 'prefer', a, b })
    } else if ((m = line.match(new RegExp(String.raw`\b(?:use|prefer|run)\s+${CODE}[^\x60.]*?\b${ALT}\s+${CODE}`, 'i')))) {
      const a = cmdPattern(m[1]), b = cmdPattern(m[2])
      if (a && b) out.push({ kind: 'prefer', a, b })
    } else if ((m = line.match(new RegExp(String.raw`\b(?:[Uu]se|[Pp]refer)\s+(?:the\s+)?\**(${TOOLS.join('|')})\b\**(?:\s+tool)?[^.]*?\b${ALT}\s+(?:\x60([^\x60]+)\x60|([a-z][\w-]*))`)))) {
      const b = cmdPattern(m[2] ?? m[3])
      if (b) out.push({ kind: 'prefer', a: m[1], b })
    } else if ((m = line.match(new RegExp(String.raw`\b${NEG}\s+(?:use|run|call)\s+${CODE}`, 'i')))) {
      const b = cmdPattern(m[1])
      if (b) out.push({ kind: 'never', b })
    }
    if (/\brun (?:the )?(?:unit )?tests?\b[^.]*\bafter\b[^.]*\b(?:edit|chang|modif)/i.test(line) || /\bafter (?:every |each |any )?(?:edit|code change|change)s?\b[^.]*\brun (?:the )?tests?\b/i.test(line)) {
      out.push({ kind: 'tests' })
    }
  }

  return out
}

const ruleId = (r: Rule) => [r.kind, r.a ?? '', r.b ?? ''].join('|')

// Each simple command of a shell line, as words, with leading VAR=x assignments dropped
function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n(){}]/)
    .map(s => s.trim().split(/\s+/).filter(Boolean))
    .map(w => {
      while (w.length && /^\w+=/.test(w[0])) w.shift()

      return w
    })
    .filter(w => w.length)
}

const startsWith = (words: string[], pattern: string) => {
  const p = pattern.split(/\s+/)

  return p.every((t, i) => words[i] === t || (i === 0 && words[0]?.split('/').pop() === t))
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

type St = { rules: Rule[]; tally: Tally; bashCalls: number; edited: boolean; tested: boolean }
let st: St = { rules: [], tally: {}, bashCalls: 0, edited: false, tested: false }

function bump(r: Rule, i: 0 | 1) {
  const id = ruleId(r)
  const cur = st.tally[id] ?? [0, 0]
  cur[i]++
  st.tally[id] = cur
}

async function save($: EngineInterface) {
  if (!st.rules.length) return
  const sid = await $.session.id().catch(() => '')
  if (!sid) return
  const out: Tally = {}
  for (const r of st.rules) {
    const id = ruleId(r)
    const [f, v] = st.tally[id] ?? [0, 0]
    // A never-rule is followed once per session that ran shell commands and never broke it
    out[id] = r.kind === 'never' ? [v === 0 && st.bashCalls > 0 ? 1 : 0, v] : [f, v]
  }
  const sessions = ((await $.store.get('sessions')) as Sessions | undefined) ?? {}
  sessions[sid] = { t: await $.clock.now(), tally: out }
  const keep = Object.entries(sessions).sort((x, y) => y[1].t - x[1].t).slice(0, KEEP_SESSIONS)
  await $.store.set('sessions', Object.fromEntries(keep))
}

type Row = { id: string; label: string; f: number; v: number; n: number; flag: boolean }

async function scorecard($: EngineInterface): Promise<{ rows: Row[]; sessions: Sessions }> {
  const known = ((await $.store.get('rules')) as Record<string, Rule> | undefined) ?? {}
  const sessions = ((await $.store.get('sessions')) as Sessions | undefined) ?? {}
  const rows = Object.entries(known).map(([id, r]) => {
    let f = 0, v = 0, bad = 0, n = 0
    for (const s of Object.values(sessions)) {
      const t = s.tally[id]
      if (!t) continue
      n++
      f += t[0]
      v += t[1]
      if (t[1]) bad++
    }
    const label = r.kind === 'tests' ? 'run tests after edits' : r.kind === 'never' ? `never \`${r.b}\`` : `\`${r.a}\` not \`${r.b}\``
    const flag = v >= CANDIDATE.violated && v / (f + v) >= CANDIDATE.rate && bad >= CANDIDATE.sessions

    return { id, label, f, v, n, flag }
  })

  return { rows, sessions }
}

// Toasts each chronically ignored rule at session start, at most once a week per rule
async function alert($: EngineInterface): Promise<void> {
  const { rows } = await scorecard($)
  const now = await $.clock.now()
  const alerted = ((await $.store.get('alerted')) as Record<string, number> | undefined) ?? {}
  const due = rows.filter(r => r.flag && now - (alerted[r.id] ?? -Infinity) >= ALERT_EVERY_MS)
  if (!due.length) return
  for (const r of due) alerted[r.id] = now
  await $.store.set('alerted', alerted)
  const worst = due.sort((x, y) => y.v - x.v)[0]
  const more = due.length > 1 ? ` (+${due.length - 1} more)` : ''
  $.ui.toast(`rule-score: Claude keeps breaking ${worst.label} (${worst.v} of ${worst.f + worst.v} checks)${more}; a hook could enforce it. /rules`)
  track($, 'rule-score', 'alert', { rules: due.length })
}

export const register: Register = on => {
  st = { rules: [], tally: {}, bashCalls: 0, edited: false, tested: false }

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'rules', description: 'Scorecard: how often Claude follows the checkable rules in CLAUDE.md' })
    await alert($).catch(() => undefined)

    return next(e)
  })

  // The InstructionsLoaded point: the files behind the claudeMd block, read before the first message
  on('prompt.context', async ($, e, next) => {
    count($, 'prompt.context')
    const result = await next(e)
    const files = result.instructionFiles ?? e.instructionFiles ?? []
    const seen = new Map<string, Rule>()
    for (const f of files) for (const r of extract(f.content)) seen.set(ruleId(r), r)
    st.rules = [...seen.values()]
    if (st.rules.length) {
      const known = ((await $.store.get('rules')) as Record<string, Rule> | undefined) ?? {}
      for (const r of st.rules) known[ruleId(r)] = r
      await $.store.set('rules', known)
    }
    const kinds = { prefer: 0, never: 0, tests: 0 }
    for (const r of st.rules) kinds[r.kind]++
    track($, 'rule-score', 'rules', { files: files.length, ...kinds })

    // Remind Claude of the loaded rules it keeps breaking
    const active = new Set(st.rules.map(ruleId))
    const broken = (await scorecard($).catch(() => ({ rows: [] as Row[] }))).rows.filter(r => r.flag && active.has(r.id))
    if (!broken.length) return result
    const text = `rule-score: in past sessions you often broke these CLAUDE.md rules; follow them:\n- ${broken.map(r => r.label).join('\n- ')}`

    return { ...result, blocks: [...result.blocks, { name: 'ruleScore', text }] }
  })

  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    if (!st.rules.length) return next(e)
    if (EDIT_TOOLS.has(e.tool)) {
      st.edited = true
      st.tested = false
    }
    const command = e.tool === 'Bash' ? String((e as { command?: string }).command ?? '') : ''
    if (command) {
      st.bashCalls++
      if (TEST_CMD.test(command)) st.tested = true
    }
    const segs = segments(command)
    for (const r of st.rules) {
      if (r.kind === 'prefer' && r.a && r.b) {
        const usedA = TOOLS.includes(r.a) ? e.tool === r.a : segs.some(w => startsWith(w, r.a!))
        const usedB = segs.some(w => startsWith(w, r.b!) && !startsWith(w, r.a!))
        if (usedB) bump(r, 1)
        else if (usedA) bump(r, 0)
        if (usedB) track($, 'rule-score', 'violation', { kind: r.kind })
      } else if (r.kind === 'never' && r.b && segs.some(w => startsWith(w, r.b!))) {
        bump(r, 1)
        track($, 'rule-score', 'violation', { kind: r.kind })
      }
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    if (e.agentId === undefined) {
      if (st.edited) for (const r of st.rules) if (r.kind === 'tests') bump(r, st.tested ? 0 : 1)
      st.edited = false
      st.tested = false
      await save($).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'rules' }, async ($) => {
    count($, 'command.run{rules}')
    await save($).catch(() => undefined)
    const { rows, sessions } = await scorecard($)
    if (!rows.length) return { text: 'rule-score: no checkable rules found in the loaded CLAUDE.md files (it reads "use `a` not `b`", "never run `x`", "prefer the Read tool over `cat`", and "run tests after edits").' }
    rows.sort((x, y) => y.v - x.v || x.label.localeCompare(y.label))
    const lines = rows.map(r => {
      const rate = r.f + r.v ? `${Math.round((100 * r.f) / (r.f + r.v))}%` : '-'

      return `${r.flag ? '!' : ' '} ${rate.padStart(4)}  ${String(r.f).padStart(4)} ok ${String(r.v).padStart(4)} broken  ${String(r.n).padStart(3)} sessions  ${r.label}`
    })
    const flagged = rows.filter(r => r.flag)
    const foot = flagged.length
      ? `\n! chronically ignored (${CANDIDATE.violated}+ breaks, ${CANDIDATE.rate * 100}%+ of checks, ${CANDIDATE.sessions}+ sessions): enforce with a hook instead of prose, e.g. a tool.call hook that denies it.`
      : ''

    return { text: `Rule scorecard (${Object.keys(sessions).length} sessions)\n${lines.join('\n')}${foot}` }
  })
}
