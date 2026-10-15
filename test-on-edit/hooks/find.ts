// Pure helpers: no `$`, so tests call them directly.

const SOURCE = /\.(m?[jt]sx?|cjs|py)$/
export const isTestFile = (path: string) => /(\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.py$)/.test(path)

const split = (path: string) => {
  const slash = path.lastIndexOf('/')
  const dir = path.slice(0, slash)
  const file = path.slice(slash + 1)
  const dot = file.indexOf('.')

  return { dir, stem: dot < 0 ? file : file.slice(0, dot), ext: file.slice(file.lastIndexOf('.') + 1) }
}

// Where this file's tests usually live, most likely first. `root` is the repo root.
export function candidates(path: string, root: string): string[] {
  if (!SOURCE.test(path) || /(^|\/)(node_modules|dist|build|\.next|\.venv)\//.test(path)) return []
  if (isTestFile(path)) return [path]
  const { dir, stem, ext } = split(path)
  if (ext === 'py') return [`${root}/tests/test_${stem}.py`, `${dir}/test_${stem}.py`, `${dir}/tests/test_${stem}.py`, `${dir}/${stem}_test.py`]
  const exts = [...new Set([ext, 'mjs', 'js', 'ts', 'tsx'])]

  return exts.flatMap(x => [
    `${dir}/${stem}.test.${x}`,
    `${dir}/${stem}.spec.${x}`,
    `${dir}/__tests__/${stem}.test.${x}`,
    `${root}/test/${stem}.test.${x}`,
    `${root}/tests/${stem}.test.${x}`,
  ])
}

// modRoot: the nearest folder above the test with .claude-plugin/plugin.json (a mod), relative to the repo root
export type Project = { hasUvLock: boolean; deps: readonly string[]; modRoot?: string }

// Folders from the test's own up to (not including) the repo root, nearest first
export function parents(test: string): string[] {
  const parts = test.split('/').slice(0, -1)

  return parts.map((_, i) => parts.slice(0, parts.length - i).join('/'))
}

// The command that runs one test file in this project
export function runner(test: string, p: Project): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const q = quote(test)
  if (p.modRoot !== undefined) return `claude plugin test ${quote(p.modRoot || '.')}`
  if (test.endsWith('.py')) return p.hasUvLock ? `uv run pytest -q ${q}` : `python3 -m pytest -q ${q}`
  if (p.deps.includes('vitest')) return `npx vitest run ${q}`
  if (p.deps.includes('jest')) return `npx jest ${q}`

  return `node --test ${q}`
}

export function summary(output: string, max = 25): string {
  return output.trimEnd().split('\n').slice(-max).join('\n')
}
