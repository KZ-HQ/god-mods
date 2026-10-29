import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { caseCount, deletedTests, isTestPath, newDisablers } from '../hooks/fake-green.ts'

describe('fake-green helpers', () => {
  test('spots disabling in js, python and go', async () => {
    expect(newDisablers("it('a', f)", "it.skip('a', f)")).toEqual(['skip'])
    expect(newDisablers('', 'xit("a", f)')).toEqual(['skip'])
    expect(newDisablers('', '@pytest.mark.skip(reason="x")\ndef test_a(): pass')).toEqual(['skip'])
    expect(newDisablers('', '@pytest.mark.xfail')).toEqual(['xfail'])
    expect(newDisablers('', "it.only('a', f)")).toEqual(['only'])
    expect(newDisablers('', '\tt.Skip("later")')).toEqual(['skip'])
    expect(newDisablers('', '@pytest.mark.skipif(sys.platform == "win32")')).toEqual([])
    expect(newDisablers("it.skip('a')", "it.skip('a')")).toEqual([])
  })

  test('bare markers only, snapshots exempt, Go short-mode skips allowed', async () => {
    expect(newDisablers('', 'model.fit(X, y)\nnet.xit(1)')).toEqual([])
    expect(newDisablers('', "fit('a', f)")).toEqual(['only'])
    expect(isTestPath('/r/__snapshots__/a.test.ts.snap')).toBe(false)
    expect(isTestPath('/r/a.test.ts.snap')).toBe(false)
    expect(newDisablers('', 'if testing.Short() {\n t.Skip("slow")\n}')).toEqual([])
    expect(newDisablers('', 't.Skip("slow")')).toEqual(['skip'])
  })

  test('counts test cases', async () => {
    expect(caseCount("it('a', f)\ntest('b', f)\ntest.each([1])('c', f)")).toBe(2)
    expect(caseCount('def test_a():\n  pass\ndef test_b():\n  pass')).toBe(2)
    expect(caseCount('func TestA(t *testing.T) {}')).toBe(1)
  })

  test('knows test paths and delete commands', async () => {
    expect(isTestPath('/r/a.test.ts')).toBe(true)
    expect(isTestPath('/r/pkg/a_test.go')).toBe(true)
    expect(isTestPath('/r/src/a.ts')).toBe(false)
    expect(deletedTests('rm -f tests/a.test.ts src/b.ts')).toEqual(['tests/a.test.ts'])
    expect(deletedTests('git rm "tests/test_a.py" && ls')).toEqual(['tests/test_a.py'])
    expect(deletedTests('cat tests/a.test.ts')).toEqual([])
  })
})

function engine(on: On, files: Record<string, string> = {}) {
  const rows: Record<string, unknown>[] = []
  let ran = 0
  on('session.cwd', () => ({ value: '/r' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('process.run', (_$, e) => {
    if (e.argv[3] === 'mod-metrics') rows.push(JSON.parse(e.argv[4] as string))

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => {
    ran += 1

    return { result: {} } as never
  })
  let context: readonly string[] | undefined
  on('prompt.submit', (_$, e) => {
    context = e.context

    return { text: e.text }
  })

  return { rows, ran: () => ran, context: () => context }
}

const T = '/r/src/a.test.ts'
const settle = async ($: { tool: { call: (x: never) => Promise<unknown> } }, done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await $.tool.call({ tool: 'Read', file_path: '/r/x' } as never)
}

describe('hook', () => {
  test('blocks disabling a test and records kinds only', async ($, on) => {
    const t = engine(on)
    const r = await $.tool.call({ tool: 'Edit', file_path: T, old_string: "it('works', f)", new_string: "it.skip('works', f)" } as never)
    expect(r.deny).toMatch(/refusing to disable tests in \/r\/src\/a\.test\.ts \(skip\)/)
    await settle($ as never, () => t.rows.some(x => x.event === 'fake-green'))
    const row = t.rows.find(x => x.event === 'fake-green')
    expect(row).toMatchObject({ action: 'blocked', kind: ['skip'], tool: 'Edit' })
    expect(JSON.stringify(row)).not.toContain('works')
  })

  test('blocks deleting a test file and a Write that adds a skip', async ($, on) => {
    const t = engine(on, { [T]: "it('a', f)" })
    const before = t.ran()
    expect((await $.tool.call({ tool: 'Bash', command: 'rm src/a.test.ts' } as never)).deny).toMatch(/refusing to delete test file/)
    expect((await $.tool.call({ tool: 'Write', file_path: T, content: "xit('a', f)" } as never)).deny).toMatch(/skip/)
    expect(t.ran()).toBe(before)
  })

  test('allows ordinary edits, and non-test files that mention skip', async ($, on) => {
    const t = engine(on)
    expect((await $.tool.call({ tool: 'Edit', file_path: T, old_string: 'a', new_string: 'b' } as never)).deny).toBeUndefined()
    expect((await $.tool.call({ tool: 'Edit', file_path: '/r/src/a.ts', old_string: 'a', new_string: 'x.skip(1)' } as never)).deny).toBeUndefined()
    expect(t.ran()).toBe(2)
  })

  test('flags removed cases to the next prompt, once', async ($, on) => {
    const t = engine(on)
    const r = await $.tool.call({ tool: 'Edit', file_path: T, old_string: "it('a', f)\nit('b', f)", new_string: "it('a', f)" } as never)
    expect(r.deny).toBeUndefined()
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(t.context()?.join('\n')).toMatch(/lost 1 test case/)
    await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
    expect(t.context()).toBeUndefined()
  })

  test('checks MultiEdit and replace_all', async ($, on) => {
    engine(on, { [T]: "it('a', f)\nit('b', f)" })
    const multi = await $.tool.call({ tool: 'MultiEdit', file_path: T, edits: [{ old_string: 'x', new_string: 'y' }, { old_string: "it('b'", new_string: "it.skip('b'" }] } as never)
    expect(multi.deny).toMatch(/skip/)
    const all = await $.tool.call({ tool: 'Edit', file_path: T, old_string: "it(", new_string: 'xit(', replace_all: true } as never)
    expect(all.deny).toMatch(/skip/)
  })

  test('/test-on-edit off lets it through', async ($, on) => {
    const t = engine(on)
    await $.command.run({ command: 'test-on-edit', args: 'off' })
    expect((await $.tool.call({ tool: 'Bash', command: 'rm src/a.test.ts' } as never)).deny).toBeUndefined()
    expect(t.ran()).toBe(1)
  })
})
