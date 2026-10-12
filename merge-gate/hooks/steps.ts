// Pure helpers: no `$`, so tests call them directly.

export type Step = { name: string; run: string; cwd: string }

// Dependency installs: CI needs them on a fresh runner, a local checkout already has them.
const INSTALL = /^(npm (ci|install)|pnpm (i|install)|yarn( install)?|bun install|pip install|uv sync|poetry install|bundle install|npm run install:ci)\b/

const indentOf = (line: string) => line.length - line.trimStart().length

// The `run:` steps of a GitHub Actions workflow, in order, with their working
// directory. Line-based: enough for ordinary workflows, not a YAML parser.
export function stepsFromWorkflow(yaml: string): Step[] {
  const lines = yaml.split('\n')
  const steps: Step[] = []
  let defaultCwd = '.'
  let current: { name?: string; run?: string; cwd?: string; indent: number } | undefined
  let inSteps = false
  let stepsIndent = -1

  const flush = () => {
    if (current?.run && !INSTALL.test(current.run.trim())) {
      steps.push({ name: current.name ?? current.run.split('\n')[0]!, run: current.run, cwd: current.cwd ?? defaultCwd })
    }
    current = undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const text = line.trim()
    if (text === '' || text.startsWith('#')) continue
    const indent = indentOf(line)

    if (inSteps && indent <= stepsIndent && !text.startsWith('-')) {
      flush()
      inSteps = false
    }
    if (/^steps:\s*$/.test(text)) {
      flush()
      inSteps = true
      stepsIndent = indent
      continue
    }
    const wd = text.match(/^working-directory:\s*(.+)$/)
    if (!inSteps) {
      if (wd) defaultCwd = wd[1]!.replace(/^['"]|['"]$/g, '')
      continue
    }

    const body = text.startsWith('- ') ? text.slice(2).trim() : text
    if (text.startsWith('- ')) {
      flush()
      current = { indent }
    }
    if (!current) continue

    const kv = body.match(/^([\w-]+):\s*(.*)$/)
    if (!kv) continue
    const [, key, value = ''] = kv
    if (key === 'name') current.name = value.replace(/^['"]|['"]$/g, '')
    if (key === 'working-directory') current.cwd = value.replace(/^['"]|['"]$/g, '')
    if (key === 'run') {
      if (value === '|' || value === '>' || value === '|-' || value === '>-') {
        const block: string[] = []
        const keyIndent = indentOf(line) + (text.startsWith('- ') ? 2 : 0)
        while (i + 1 < lines.length && (lines[i + 1]!.trim() === '' || indentOf(lines[i + 1]!) > keyIndent)) {
          block.push(lines[++i]!.trim())
        }
        current.run = block.filter(Boolean).join(value.startsWith('>') ? ' ' : '\n')
      } else {
        current.run = value.replace(/^['"]|['"]$/g, '')
      }
    }
  }
  flush()

  // Same command in two jobs runs once
  const seen = new Set<string>()

  return steps.filter(s => !seen.has(`${s.cwd}\0${s.run}`) && seen.add(`${s.cwd}\0${s.run}`))
}

// Fallback when there is no workflow: the usual check targets.
export function stepsFromMakefile(makefile: string): Step[] {
  const targets = new Set([...makefile.matchAll(/^([A-Za-z][\w-]*):/gm)].map(m => m[1]!))

  return ['lint', 'typecheck', 'check', 'test'].filter(t => targets.has(t)).map(t => ({ name: `make ${t}`, run: `make ${t}`, cwd: '.' }))
}

export function stepsFromPackage(pkg: { scripts?: Record<string, string> }, cwd: string): Step[] {
  const scripts = pkg.scripts ?? {}

  return ['lint', 'typecheck', 'test', 'build'].filter(s => s in scripts).map(s => ({ name: `npm run ${s}`, run: `npm run ${s}`, cwd }))
}

export type Check = { name: string; bucket: string; state?: string }

export type Verdict =
  | { kind: 'pass'; count: number }
  | { kind: 'none' }
  | { kind: 'pending'; names: string[] }
  | { kind: 'fail'; names: string[] }

export function judge(checks: readonly Check[]): Verdict {
  if (checks.length === 0) return { kind: 'none' }
  const failed = checks.filter(c => c.bucket === 'fail' || c.bucket === 'cancel').map(c => c.name)
  if (failed.length) return { kind: 'fail', names: failed }
  const pending = checks.filter(c => c.bucket === 'pending').map(c => c.name)
  if (pending.length) return { kind: 'pending', names: pending }

  return { kind: 'pass', count: checks.length }
}

// Quoted text (commit messages, echo arguments) is data, never a command.
// Heredoc bodies are text, not commands: drop each from its << line to its terminator line
const withoutHeredocs = (command: string) =>
  command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?^\s*\2\s*$/gm, '')
// Blanks quoted text but keeps its length, so offsets in the result index the original
const unquoted = (command: string) => command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, q => `"${' '.repeat(q.length - 2)}"`)

export type Merge = { selector?: string; repo?: string; cwd?: string }

// The PR a `gh pr merge` names (number, URL or branch), its repo flag, and a leading `cd`.
// Undefined when there is no merge to gate: no such command, `--help`, or `--auto`
// (which queues the merge for GitHub to perform once its own requirements pass).
export function parseMerge(full: string): Merge | undefined {
  const command = withoutHeredocs(full)
  // Only as a command of its own: at the start, or after ; && || |
  const m = unquoted(command).match(/(?:^|[;&|]\s*)\s*gh\s+pr\s+merge(?=\s|$|[;&|])([^;&|]*)/)
  if (!m) return undefined
  // Read the arguments from the original text, so quoted values stay whole
  const at = unquoted(command).indexOf(m[0]) + m[0].length - m[1]!.length
  const raw = command.slice(at).match(/^((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^;&|"'])*)/)?.[1] ?? ''
  const words = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map(w => w[1] ?? w[2] ?? w[3]!)
  if (words.some(w => w === '--help' || w === '-h' || w === '--auto' || w === '--disable-auto')) return undefined

  let selector: string | undefined
  let repo: string | undefined
  const VALUED = new Set(['-R', '--repo', '-t', '--subject', '-b', '--body', '-F', '--body-file', '-A', '--author-email', '--match-head-commit'])
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === '-R' || w === '--repo') repo = words[++i]
    else if (w.startsWith('--repo=')) repo = w.slice(7)
    else if (VALUED.has(w)) i++
    else if (!w.startsWith('-') && selector === undefined) selector = w
  }
  const cd = command.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/)

  return { selector, repo, cwd: cd?.[1]?.replace(/^['"]|['"]$/g, '') }
}

// A merge tool from an MCP server (the GitHub connector's merge_pull_request).
export const MCP_MERGE = /(^|__)(merge_pull_request|merge_pr|pull_request_merge)$/i

export function mergeFromMcp(input: Record<string, unknown>): Merge | undefined {
  const number = input.pull_number ?? input.pullNumber ?? input.number ?? input.pr_number
  const owner = input.owner
  const repo = input.repo ?? input.repository
  if (number === undefined) return undefined

  return {
    selector: String(number),
    repo: typeof owner === 'string' && typeof repo === 'string' ? `${owner}/${repo}` : typeof repo === 'string' && repo.includes('/') ? repo : undefined,
  }
}
