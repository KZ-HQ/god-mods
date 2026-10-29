// Pure helpers for the PR provenance note: no `$`, so tests call them directly.

export const NOTE_MARK = '<!-- merge-gate:note -->'

// A `gh pr create` that is a command of its own (not text inside quotes or a heredoc), and not --help/--web
export function isPrCreate(command: string): boolean {
  const bare = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?^\s*\2\s*$/gm, '')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
  const m = bare.match(/(?:^|[;&|]\s*)\s*gh\s+pr\s+create(?=\s|$|[;&|])([^;&|]*)/)
  if (!m) return false

  return !/\s(--help|-h|--web|-w)(\s|$)/.test(m[1]!)
}

// The new pull request's URL in `gh pr create`'s output
export function prUrl(output: string): string | undefined {
  return output.match(/https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/)?.[0]
}

const TEST = /(?:^|[;&|])\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:npx|bunx|uv run|poetry run|pnpm exec|pnpm dlx)\s+)?(?:npm (?:run )?test|pnpm (?:run )?test|yarn test|bun test|pytest|python3? -m pytest|cargo test|go test|make test|vitest|jest|node --test|claude plugin test|sh scripts\/ci\.sh)(?=\s|$|[;&|])/

export const isTestCommand = (command: string) => TEST.test(command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""'))

const lines = (s: string) => (s === '' ? 0 : s.split('\n').length)

// Lines an Edit or Write input adds and removes; undefined for any other tool
export function lineDelta(tool: string, input: Record<string, unknown>): { added: number; removed: number } | undefined {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (tool === 'Write') return { added: lines(str('content')), removed: 0 }
  if (tool === 'Edit') return { added: lines(str('new_string')), removed: lines(str('old_string')) }

  return undefined
}

export type Provenance = {
  usd?: string
  tests: { runs: number; pass: number; fail: number }
  added: number
  removed: number
}

// ~3 lines under a separator; the mark lets a second edit see the note is already there
export function buildNote(p: Provenance): string {
  const out = ['---', `${NOTE_MARK}Claude session: ${p.usd ? `${p.usd} so far` : 'cost unavailable'}`]
  out.push(
    p.tests.runs ? `Tests run: ${p.tests.runs} (${p.tests.pass} passed, ${p.tests.fail} failed)` : 'Tests run: none this session'
  )
  if (p.added || p.removed) out.push(`Claude's edits: +${p.added} / -${p.removed} lines`)

  return out.join('\n')
}

export const withNote = (body: string, note: string) => (body.includes(NOTE_MARK) ? body : `${body.trimEnd()}\n\n${note}\n`)
