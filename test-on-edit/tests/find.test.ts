import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { candidates, runner } from '../hooks/find.ts'

describe('find', () => {
  test('maps a source file to its usual test files', async () => {
    expect(candidates('/r/lib/scoped.mjs', '/r')).toContain('/r/test/scoped.test.mjs')
    expect(candidates('/r/src/pkg/ingest.py', '/r')[0]).toBe('/r/tests/test_ingest.py')
    expect(candidates('/r/test/scoped.test.mjs', '/r')).toEqual(['/r/test/scoped.test.mjs'])
    expect(candidates('/r/README.md', '/r')).toEqual([])
    expect(candidates('/r/node_modules/x/index.js', '/r')).toEqual([])
  })

  test('picks the runner', async () => {
    expect(runner('test/a.test.mjs', { hasUvLock: false, deps: [] })).toBe("node --test 'test/a.test.mjs'")
    expect(runner('tests/test_a.py', { hasUvLock: true, deps: [] })).toBe("uv run pytest -q 'tests/test_a.py'")
    expect(runner('src/a.test.ts', { hasUvLock: false, deps: ['vitest'] })).toBe("npx vitest run 'src/a.test.ts'")
  })
})

function engine(on: On, exitCode: number) {
  const ran: string[] = []
  const toasts: string[] = []
  const out = (stdout: string, code = 0) => ({ value: { exitCode: code, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.cwd', () => ({ value: '/r' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('clock.now', () => ({ value: 0 }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/r/test/scoped.test.mjs' }))
  on('fs.read', () => ({ value: '{"devDependencies":{}}' }))
  on('process.run', (_$, e) => {
    if (e.argv[3] === 'mod-metrics') return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[0] === 'git') return out('/r\n')
    ran.push(e.argv.join(' '))

    return out(exitCode ? 'not ok 3 - rejects OR\n# fail 1' : '# pass 12', exitCode)
  })
  on('tool.call', { tool: 'Edit' }, () => ({ result: { filePath: '/r/lib/scoped.mjs' } }) as never)
  on('tool.call', { tool: 'Read' }, () => ({ result: {} }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  let context: readonly string[] | undefined
  on('prompt.submit', (_$, e) => {
    context = e.context

    return { text: e.text }
  })

  return { ran, toasts, context: () => context }
}

const EDIT = { tool: 'Edit', file_path: '/r/lib/scoped.mjs', old_string: 'a', new_string: 'b' } as const
const END = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
// The turn-end run is off the turn's path: wait on engine round-trips until it lands
const settle = async ($: { tool: { call: (x: never) => Promise<unknown> } }, done: () => boolean) => {
  for (let i = 0; i < 200 && !done(); i++) await $.tool.call({ tool: 'Read', file_path: '/r/x' } as never)
}

describe('hook', () => {
  test('edits run nothing; the turn end runs each file once and the next prompt carries a failure', async ($, on) => {
    const t = engine(on, 1)
    await $.tool.call(EDIT)
    await $.tool.call(EDIT)
    expect(t.ran).toEqual([])
    await $.turn.complete(END)
    await settle($ as never, () => t.toasts.length > 0)
    expect(t.ran).toEqual(["/bin/zsh -lc node --test 'test/scoped.test.mjs'"])
    expect(t.toasts[0]).toMatch(/test\/scoped\.test\.mjs failing/)

    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(t.context()?.join('\n')).toMatch(/some fail:[\s\S]*rejects OR/)
    await $.prompt.submit({ text: 'again', wait: false, origin: { kind: 'composer' } })
    expect(t.context()).toBeUndefined()
  })

  test('a pass is a toast, and nothing reaches Claude', async ($, on) => {
    const t = engine(on, 0)
    await $.tool.call(EDIT)
    await $.turn.complete(END)
    await settle($ as never, () => t.toasts.length > 0)
    expect(t.toasts).toEqual(['test-on-edit: 1 test file pass'])
    await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
    expect(t.context()).toBeUndefined()
  })
})

describe('/test-on-edit', () => {
  test('off stops runs for the session; on resumes them', async ($, on) => {
    const t = engine(on, 0)
    expect((await $.command.run({ command: 'test-on-edit', args: 'off' })).text).toBe('off for this session.')
    await $.tool.call(EDIT)
    await $.turn.complete(END)
    await settle($ as never, () => t.ran.length > 0)
    expect(t.ran).toEqual([])

    expect((await $.command.run({ command: 'test-on-edit', args: 'on' })).text).toBe('on.')
    await $.tool.call(EDIT)
    await $.turn.complete(END)
    await settle($ as never, () => t.toasts.length > 0)
    expect(t.ran).toHaveLength(1)
  })
})
