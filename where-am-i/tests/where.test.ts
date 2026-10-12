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

describe('/where', () => {
  test('sets, shows and clears the goal; after clear the next prompt sets it', async ($, on) => {
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    const goal = (args: string) => $.command.run({ command: 'where', args, ...RUN }).then(r => r.text)
    expect(await goal('')).toBe('Goal: not set')
    expect(await goal('Ship KEI-200 billing export')).toBe('Goal: Ship KEI-200 billing export')
    await $.prompt.submit({ text: 'look at the csv writer', wait: false, origin: { kind: 'composer' } })
    expect(await goal('')).toBe('Goal: Ship KEI-200 billing export')

    expect(await goal('clear')).toBe('Goal cleared; your next prompt sets it.')
    await $.prompt.submit({ text: '/compact', wait: false, origin: { kind: 'composer' } })
    expect(await goal('')).toBe('Goal: not set')
    await $.prompt.submit({ text: 'fix the restore path', wait: false, origin: { kind: 'composer' } })
    expect(await goal('')).toBe('Goal: fix the restore path')
  })

  test('hide removes the band; show brings it back', async ($, on) => {
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)
    await $.prompt.submit({ text: 'Finish KEI-189 backup tooling', wait: false, origin: { kind: 'composer' } })
    const band = async () => {
      const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND(false) })
      const found = (await ui.find({ type: 'Text', text: /Finish KEI-189/ })) !== undefined
      await ui.unmount()

      return found
    }
    expect(await band()).toBe(true)
    expect((await $.command.run({ command: 'where', args: 'hide', ...RUN })).text).toBe('where-am-i band hidden.')
    expect(await band()).toBe(false)
    expect((await $.command.run({ command: 'where', args: 'show', ...RUN })).text).toBe('where-am-i band shown.')
    expect(await band()).toBe(true)
  })
})

describe('start', () => {
  test('a refused command name does not stop /park or a parked note from coming back', async ($, on) => {
    mock.store(on, { 'park:/r': { note: 'stopped before the reset', goal: 'Ship KEI-200', branch: 'main', at: 1_000_000 } })
    mock.clock(on, { now: 1_000_000 })
    on('session.cwd', () => ({ value: '/r' }))
    on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    const registered: string[] = []
    on('command.register', (_$, e) => {
      if (e.name === 'where' || e.name === 'goal') throw new Error(`"/${e.name}" refused: it is a built-in`)
      registered.push(e.name)

      return { value: { command: e.name } }
    })
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => h($.ui.resolve(e).Box, {}) as never)
    await $.session.start({ cwd: '/r' } as never)
    expect(registered).toEqual(['park'])
    const ui = await $.ui.mount({ plugin: 'where-am-i', surface: 'terminal', ...BAND(false) })
    expect(await ui.find({ type: 'Text', text: /stopped before the reset/ })).toBeDefined()
  })
})
