// Pure helpers: spot edits that make tests pass by removing or disabling them. No `$`.

export const isTestPath = (path: string) =>
  /(\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(py|go)$|(^|\/)(tests?|__tests__)\/[^/]+\.(m?[jt]sx?|cjs|py|go)$)/.test(path)

// Ways a test is switched off while still sitting in the file
const DISABLERS: Record<string, RegExp> = {
  skip: /(\b(it|test|describe|suite|context)\.skip\(|\b(xit|xtest|xdescribe)\(|@pytest\.mark\.skip(?!if)\b|\bpytest\.skip\(|@unittest\.skip(?!If|Unless)\b|\bt\.Skip(Now)?\(|\bb\.Skip(Now)?\()/g,
  xfail: /(@pytest\.mark\.xfail\b|\bpytest\.xfail\(|\btest\.fixme\(|\b(it|test)\.failing\()/g,
  only: /(\b(it|test|describe|suite)\.only\(|\b(fit|fdescribe)\()/g,
  todo: /\b(it|test)\.todo\(/g,
}

// Test-case declarations, one per match
const CASE = /(\b(it|test)(\.(only|skip|each|concurrent))?\(\s*['"`]|\bdef test_\w+|\bfunc Test\w+\(|\bt\.Run\()/g

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length

export const caseCount = (text: string) => count(text, CASE)

// Disabling kinds that `after` has more of than `before`
export function newDisablers(before: string, after: string): string[] {
  return Object.entries(DISABLERS)
    .filter(([, re]) => count(after, re) > count(before, re))
    .map(([kind]) => kind)
}

// Test files named as arguments of a delete command (rm, git rm, unlink, find -delete is out of scope)
export function deletedTests(command: string): string[] {
  const out: string[] = []
  for (const part of command.split(/&&|\|\||;|\n|\|/)) {
    const words = part.trim().split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, ''))
    const at = words.findIndex(w => w === 'rm' || w === 'unlink' || w === 'trash')
    if (at < 0) continue
    out.push(...words.slice(at + 1).filter(w => !w.startsWith('-') && isTestPath(w)))
  }

  return out
}
