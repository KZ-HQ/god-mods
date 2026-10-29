import { describe, expect, mock, test } from 'claude-code/testing'
import type { EngineInterface, On } from 'claude-code'

const CLAUDE_MD = [
  '# Prefs',
  '- Use `pnpm` instead of `npm`.',
  '- Never run `git push --force`.',
  '- Prefer the Read tool over `cat` for files.',
  '- Run the tests after every edit.',
  '- Be concise.',
  '- Write good code, not `bad <code>`.',
].join('\n')

const RM = 'never||rm -rf'
const BROKEN = {
  a: { t: 1, tally: { [RM]: [0, 2] } },
  b: { t: 2, tally: { [RM]: [0, 1] } },
  c: { t: 3, tally: { [RM]: [1, 0] } },
}

function engine(on: On, seed: Record<string, unknown> = {}) {
  const rows: Record<string, unknown>[] = []
  mock.store(on, seed)
  on('clock.now', () => ({ value: 1000 }))
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.cwd', () => ({ value: '/r' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === '/bin/sh' && e.argv[4]) rows.push(JSON.parse(e.argv[4]))

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))

  return rows
}

const load = ($: EngineInterface, content = CLAUDE_MD) =>
  $.prompt.context({ blocks: [], instructionFiles: [{ path: '/r/CLAUDE.md', kind: 'project', content }] } as never)
const bash = ($: EngineInterface, command: string) => $.tool.call({ tool: 'Bash', input: { command } } as never)
const endTurn = ($: EngineInterface) => $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
const settle = async () => {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

describe('rule-score', () => {
  test('extracts only the checkable rules, and its metrics row holds counts only', async ($, on) => {
    const rows = engine(on)
    await load($)
    await settle()
    const r = rows.find(x => x.event === 'rules')
    expect(r).toMatchObject({ files: 1, prefer: 2, never: 1, tests: 1 })
    expect(JSON.stringify(rows)).not.toContain('pnpm')
  })

  test('scores prefer and never rules from shell commands and tool use', async ($, on) => {
    engine(on)
    await load($)
    await bash($, 'cd app && pnpm install')
    await bash($, 'FOO=1 npm test')
    await bash($, 'git push --force origin main')
    await bash($, 'cat README.md | head')
    await $.tool.call({ tool: 'Read', input: { file_path: '/r/a' } } as never)
    await endTurn($)
    const out = await $.command.run({ command: 'rules', args: '' })
    const text = (out as { text: string }).text
    expect(text).toContain('50%     1 ok    1 broken    1 sessions  `pnpm` not `npm`')
    expect(text).toContain('0 ok    1 broken    1 sessions  never `git push --force`')
    expect(text).toContain('1 ok    1 broken    1 sessions  `Read` not `cat`')
  })

  test('counts a turn with edits as following the tests rule only if tests ran after the edit', async ($, on) => {
    engine(on)
    await load($, '- Always run tests after code changes.')
    await $.tool.call({ tool: 'Edit', input: { file_path: '/r/a.ts' } } as never)
    await bash($, 'pnpm test')
    await endTurn($)
    await bash($, 'ls')
    await endTurn($)
    await $.tool.call({ tool: 'Write', input: { file_path: '/r/b.ts' } } as never)
    await endTurn($)
    const text = ((await $.command.run({ command: 'rules', args: '' })) as { text: string }).text
    expect(text).toContain('1 ok    1 broken    1 sessions  run tests after edits')
  })

  test('flags a rule broken across sessions as a hook candidate', async ($, on) => {
    engine(on, {
      rules: { 'never||rm -rf': { kind: 'never', b: 'rm -rf' } },
      sessions: {
        a: { t: 1, tally: { 'never||rm -rf': [0, 2] } },
        b: { t: 2, tally: { 'never||rm -rf': [0, 1] } },
        c: { t: 3, tally: { 'never||rm -rf': [1, 0] } },
      },
    })
    const text = ((await $.command.run({ command: 'rules', args: '' })) as { text: string }).text
    expect(text).toMatch(/^! +25% .*never `rm -rf`$/m)
    expect(text).toContain('chronically ignored')
  })

  test('toasts a chronically ignored rule at session start, once a week', async ($, on) => {
    engine(on, { rules: { [RM]: { kind: 'never', b: 'rm -rf' } }, sessions: BROKEN })
    const toasts: string[] = []
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)

      return { value: undefined } as never
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
    on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
    await $.session.start({ cwd: '/r' } as never)
    await $.session.start({ cwd: '/r' } as never)
    expect(toasts.filter(t => t.includes('keeps breaking never `rm -rf`'))).toHaveLength(1)
  })

  test("tells Claude about a loaded rule it keeps breaking, and nothing when it doesn't", async ($, on) => {
    engine(on, { rules: { [RM]: { kind: 'never', b: 'rm -rf' } }, sessions: BROKEN })
    const out = await load($, '- Never run `rm -rf` here.')
    expect(out.blocks.find(b => b.name === 'ruleScore')?.text).toContain('never `rm -rf`')
    const quiet = await load($, '- Never run `curl`.')
    expect(quiet.blocks).toHaveLength(0)
  })

  test('says what it reads when no rule is checkable', async ($, on) => {
    engine(on)
    await load($, '- Be concise.\n- Prefer clarity over cleverness.')
    const text = ((await $.command.run({ command: 'rules', args: '' })) as { text: string }).text
    expect(text).toContain('no checkable rules')
  })
})
