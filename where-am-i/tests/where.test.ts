import { describe, expect, mock, test } from 'claude-code/testing'

const BAND = (isWorking: boolean) =>
  ({
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking, maxRows: 4, bodyColumns: 100, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  }) as const

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

describe('where-am-i', () => {
  test('the first prompt sets the goal; the band shows what Claude does now', async ($, on) => {
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    await $.prompt.submit({ text: 'Finish KEI-189 backup tooling\nand docs', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'also check the restore path', wait: false, origin: { kind: 'composer' } })
    await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests' })

    const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND(true) })
    expect(await ui.find({ type: 'Text', text: /Finish KEI-189 backup tooling/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /now Bash: Run tests/ })).toBeDefined()
  })

  test('/park saves a note that the next session in the folder shows', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_000_000 })
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)

    const r = await $.command.run({ command: 'park', args: 'stopped before the production reset', ...RUN })
    expect(r.text).toMatch(/Parked on main: stopped before the production reset/)
    await $.session.start({ cwd: '/r' } as never)
    const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND(false) })
    expect(await ui.find({ type: 'Text', text: /Parked just now on main: stopped before the production reset/ })).toBeDefined()
  })
})
