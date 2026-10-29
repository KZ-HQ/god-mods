import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildNote, isPrCreate, isTestCommand, lineDelta, prUrl, withNote } from '../hooks/note.ts'
import { MCP_MERGE, judge, mergeFromMcp, parseMerge, stepsFromMakefile, stepsFromWorkflow } from '../hooks/steps.ts'

const CI = `name: CI
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: sites-owner
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 26
      - run: npm ci
      # Includes the household data-access guard (FEAT-42).
      - run: npm run lint
      - run: npx tsc --noEmit --incremental false
      - run: node --test test/*.test.mjs
      - name: Build it
        run: |
          npm run build
          echo done
  other:
    steps:
      - run: npm run lint
        working-directory: sites-owner
      - run: make docs
        working-directory: docs
`

describe('steps', () => {
  test('reads run steps and working directories from a workflow, skipping installs', async () => {
    expect(stepsFromWorkflow(CI)).toEqual([
      { name: 'npm run lint', run: 'npm run lint', cwd: 'sites-owner' },
      { name: 'npx tsc --noEmit --incremental false', run: 'npx tsc --noEmit --incremental false', cwd: 'sites-owner' },
      { name: 'node --test test/*.test.mjs', run: 'node --test test/*.test.mjs', cwd: 'sites-owner' },
      { name: 'Build it', run: 'npm run build\necho done', cwd: 'sites-owner' },
      { name: 'make docs', run: 'make docs', cwd: 'docs' },
    ])
  })

  test('falls back to Makefile check targets', async () => {
    expect(stepsFromMakefile('help:\nlint: ## Ruff\ntest: ## tests\nformat:\n').map(s => s.run)).toEqual(['make lint', 'make test'])
  })
})

describe('parseMerge', () => {
  test('finds the PR, repo and leading cd', async () => {
    expect(parseMerge('gh pr merge 32 --squash --delete-branch')).toEqual({ selector: '32', repo: undefined, cwd: undefined })
    expect(parseMerge('cd /repo && gh pr merge --squash -R KZ-HQ/my-app')).toEqual({ selector: undefined, repo: 'KZ-HQ/my-app', cwd: '/repo' })
    expect(parseMerge('gh pr merge -t "Fix it" 31')?.selector).toBe('31')
    expect(parseMerge('gh pr view 32')).toBeUndefined()
    expect(parseMerge('echo gh pr merge-thing')).toBeUndefined()
  })

  test('ignores help, auto-merge, and the words inside quotes or other commands', async () => {
    expect(parseMerge('gh pr merge --help | grep auto')).toBeUndefined()
    expect(parseMerge('gh pr merge 32 --auto --squash')).toBeUndefined()
    expect(parseMerge('git commit -m "docs: explain gh pr merge 32"')).toBeUndefined()
    expect(parseMerge("echo 'run gh pr merge 32 later'")).toBeUndefined()
    expect(parseMerge('echo gh pr merge 32')).toBeUndefined()
    expect(parseMerge('git push && gh pr merge 32 -t "Ship; it"')?.selector).toBe('32')
    // A heredoc body mentioning a merge is text, even with an unbalanced quote in it
    const body = `gh pr create --title T --body "$(cat <<'EOF'\nit doesn't: \`cd ~/x && gh pr merge 5\` failed\nEOF\n)"`
    expect(parseMerge(body)).toBeUndefined()
    expect(parseMerge(`${body} && gh pr merge --squash --auto`)).toBeUndefined()
    expect(parseMerge(`${body} && gh pr merge 7 --squash`)?.selector).toBe('7')
    expect(parseMerge(`cat > /tmp/b <<EOF\ngh pr merge 9\nEOF`)).toBeUndefined()
  })

  test('reads an MCP merge tool call', async () => {
    expect(MCP_MERGE.test('mcp__a8b6__merge_pull_request')).toBe(true)
    expect(MCP_MERGE.test('mcp__a8b6__get_pull_request')).toBe(false)
    expect(mergeFromMcp({ owner: 'KZ-HQ', repo: 'my-app', pull_number: 58 })).toEqual({ selector: '58', repo: 'KZ-HQ/my-app' })
  })
})

describe('judge', () => {
  test('fail beats pending beats pass', async () => {
    expect(judge([])).toEqual({ kind: 'none' })
    expect(judge([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'skipping' }])).toEqual({ kind: 'pass', count: 2 })
    expect(judge([{ name: 'a', bucket: 'pending' }, { name: 'b', bucket: 'fail' }])).toEqual({ kind: 'fail', names: ['b'] })
    expect(judge([{ name: 'a', bucket: 'pending' }, { name: 'b', bucket: 'pass' }])).toEqual({ kind: 'pending', names: ['a'] })
  })
})

function engine(on: On, checks: string) {
  let merged = false
  on('session.cwd', () => ({ value: '/repo' }))
  on('ui.toast', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.exists', (_$, e) => ({ value: ['/repo', '/home/t/code/app'].includes(e.path) }))
  const calls: string[][] = []
  const dirs: (string | undefined)[] = []
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[0].endsWith('/gh')) dirs.push(e.init?.cwd)
    const sub = e.argv.slice(1, 3).join(' ')
    const stdout =
      e.argv[0] === '/bin/zsh' ? '/opt/homebrew/bin/gh\n' : sub === 'pr view' ? '{"number":32,"isDraft":false,"state":"OPEN"}' : checks

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    merged = true

    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  return Object.assign(() => merged, { calls, dirs })
}

describe('merge hook', () => {
  test('holds the merge while a check fails', async ($, on) => {
    const didMerge = engine(on, '[{"name":"verify","bucket":"fail","state":"FAILURE"}]')
    const r = await $.tool.call({ tool: 'Bash', command: 'gh pr merge 32 --squash' })
    expect(didMerge()).toBe(false)
    expect(String(r.deny ?? r.text)).toMatch(/CI failed on PR 32: verify/)
    // gh is found through a login shell, since the desktop app's PATH lacks Homebrew
    expect(didMerge.calls.some(c => c[0] === '/opt/homebrew/bin/gh')).toBe(true)
  })

  test('expands ~ in a leading cd and runs gh there', async ($, on) => {
    const didMerge = engine(on, '[{"name":"verify","bucket":"pass","state":"SUCCESS"}]')
    await $.tool.call({ tool: 'Bash', command: 'cd ~/code/app && gh pr merge 32 --squash' })
    expect(didMerge()).toBe(true)
    expect(didMerge.dirs.length).toBeGreaterThan(0)
    expect(didMerge.dirs.every(d => d === '/home/t/code/app')).toBe(true)
  })

  test('holds with a clear reason when the cd target does not exist, without running gh', async ($, on) => {
    const didMerge = engine(on, '[{"name":"verify","bucket":"pass","state":"SUCCESS"}]')
    const r = await $.tool.call({ tool: 'Bash', command: 'cd ~/nope && gh pr merge 32 --squash' })
    expect(didMerge()).toBe(false)
    expect(String(r.deny ?? r.text)).toMatch(/runs in \/home\/t\/nope, which does not exist/)
    expect(didMerge.dirs.length).toBe(0)
  })

  test('lets an auto-merge through without checking', async ($, on) => {
    const didMerge = engine(on, '[{"name":"verify","bucket":"pending","state":"PENDING"}]')
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 32 --auto --squash' })
    expect(didMerge()).toBe(true)
  })

  test('holds a connector merge while CI fails', async ($, on) => {
    engine(on, '[{"name":"verify","bucket":"fail","state":"FAILURE"}]')
    let merged = false
    on('tool.call', { tool: 'mcp__gh__merge_pull_request' }, () => {
      merged = true

      return { result: 'merged' }
    })
    const r = await $.tool.call({ tool: 'mcp__gh__merge_pull_request', owner: 'KZ-HQ', repo: 'my-app', pull_number: 58 } as never)
    expect(merged).toBe(false)
    expect(String(r.deny ?? r.text)).toMatch(/CI failed on PR 58/)
  })

  test('lets the merge through when every check passed', async ($, on) => {
    const didMerge = engine(on, '[{"name":"verify","bucket":"pass","state":"SUCCESS"}]')
    await $.tool.call({ tool: 'Bash', command: 'gh pr merge 32 --squash' })
    expect(didMerge()).toBe(true)
  })

  test('leaves other commands alone', async ($, on) => {
    const didRun = engine(on, '[]')
    await $.tool.call({ tool: 'Bash', command: 'gh pr view 32' })
    expect(didRun()).toBe(true)
  })
})

describe('/gate', () => {
  // A repo at /repo whose .claude/gate.json has lint then test; test exits 1 when failTest
  function repo(on: On, opts: { inRepo?: boolean; failTest?: boolean } = {}) {
    const ran: string[] = []
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    on('clock.now', () => ({ value: 0 }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('ui.status', () => ({ value: undefined }))
    on('fs.read', (_$, e) => {
      if (e.path === '/repo/.claude/gate.json') return { value: JSON.stringify({ steps: [{ name: 'lint', run: 'npm run lint' }, { name: 'test', run: 'npm test', cwd: 'app' }] }) }
      throw new Error('ENOENT')
    })
    on('process.run', (_$, e) => {
      if (e.argv[3] === 'mod-metrics') return ok('')
      if (e.argv[0] === 'git') return opts.inRepo === false ? ok('', 128) : ok('/repo\n')
      ran.push(`${e.init?.cwd}: ${e.argv[2]}`)

      return e.argv[2] === 'npm test' && opts.failTest ? ok('1 failing\nAssertionError: boom', 1) : ok('fine')
    })

    return ran
  }

  test('runs each step in its folder and reports passes', async ($, on) => {
    const ran = repo(on)
    const out = (await $.command.run({ command: 'gate', args: '' })).text
    expect(ran).toEqual(['/repo: npm run lint', '/repo/app: npm test'])
    expect(out).toMatch(/gate: 2 steps from \.claude\/gate\.json/)
    expect(out).toMatch(/✔ lint/)
    expect(out).toMatch(/✔ test/)
  })

  test('stops at the first failing step and shows its output tail', async ($, on) => {
    repo(on, { failTest: true })
    const out = (await $.command.run({ command: 'gate', args: '' })).text
    expect(out).toMatch(/✘ test \(exit 1/)
    expect(out).toMatch(/AssertionError: boom/)
  })

  test('list shows the steps without running them', async ($, on) => {
    const ran = repo(on)
    const out = (await $.command.run({ command: 'gate', args: 'list' })).text
    expect(out).toBe('From .claude/gate.json:\n  [.] npm run lint\n  [app] npm test')
    expect(ran).toEqual([])
  })

  test('outside a git repository it runs nothing', async ($, on) => {
    const ran = repo(on, { inRepo: false })
    expect((await $.command.run({ command: 'gate', args: '' })).text).toBe('gate: not in a git repository.')
    expect(ran).toEqual([])
  })
})

describe('PR provenance note', () => {
  test('helpers parse create commands, urls, tests and edits', async () => {
    expect(isPrCreate('gh pr create --title T --body-file b.md')).toBe(true)
    expect(isPrCreate('cd x && gh pr create -F -')).toBe(true)
    expect(isPrCreate('gh pr create --web')).toBe(false)
    expect(isPrCreate('echo "gh pr create"')).toBe(false)
    expect(prUrl('Creating...\nhttps://github.com/o/r/pull/12\n')).toBe('https://github.com/o/r/pull/12')
    expect(isTestCommand('cd app && npm test')).toBe(true)
    expect(isTestCommand('FOO=1 npx vitest run && echo ok')).toBe(true)
    expect(isTestCommand('pip install pytest')).toBe(false)
    expect(isTestCommand('grep jest package.json')).toBe(false)
    expect(isTestCommand('git commit -m "run npm test"')).toBe(false)
    expect(lineDelta('Edit', { old_string: 'a\nb', new_string: 'c' })).toEqual({ added: 1, removed: 2 })
    expect(lineDelta('Write', { content: 'x\ny\nz' })).toEqual({ added: 3, removed: 0 })
    expect(lineDelta('Read', {})).toBeUndefined()
    const note = buildNote({ usd: '$1.20', tests: { runs: 2, pass: 1, fail: 1 }, added: 5, removed: 2 })
    expect(note.split('\n')).toHaveLength(4)
    expect(withNote('body', note)).toContain('Tests run: 2 (1 passed, 1 failed)')
    expect(withNote(withNote('body', note), note)).toBe(withNote('body', note))
  })

  function setup(on: On, opts: { createFails?: boolean } = {}) {
    const edits: string[] = []
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    on('session.cwd', () => ({ value: '/repo' }))
    on('ui.toast', () => ({ value: undefined }))
    on('session.usage', () => ({ value: { cost: { usd: 2.5 } } }) as never)
    on('process.run', (_$, e) => {
      if (e.argv[3] === 'mod-metrics') return ok('')
      if (e.argv[0] === '/bin/zsh') return ok('/opt/homebrew/bin/gh\n')
      if (e.argv[2] === 'view') return ok('My body\n')
      if (e.argv[2] === 'edit') edits.push(e.argv[5]!)

      return ok('')
    })
    on('tool.call', { tool: 'Bash' }, (_$, e) => {
      const create = e.command.startsWith('gh pr create')
      if (opts.createFails && create) return { result: { stdout: '', stderr: 'boom', interrupted: false }, text: 'boom', isError: true } as never

      return { result: { stdout: '', stderr: '', interrupted: false }, text: create ? 'https://github.com/o/r/pull/9\n' : '' } as never
    })
    on('tool.call', { tool: 'Edit' }, () => ({ result: {}, text: '' }) as never)

    return edits
  }

  test('appends the note after gh pr create, counting tests and edits', async ($, on) => {
    mock.store(on)
    const edits = setup(on)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b\nc' } as never)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --title T --body "hi"' })
    await new Promise(r => setTimeout(r, 50))
    expect(edits).toHaveLength(1)
    expect(edits[0]).toMatch(/^My body\n\n---\n/)
    expect(edits[0]).toMatch(/\$2\.50 so far/)
    expect(edits[0]).toMatch(/Tests run: 1 \(1 passed, 0 failed\)/)
    expect(edits[0]).toMatch(/\+2 \/ -1 lines/)
  })

  test('session end (/clear) resets the counters', async ($, on) => {
    mock.store(on)
    const edits = setup(on)
    on('session.end', () => ({ sessionId: 's' }) as never)
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    await $.session.end({ reason: 'clear' } as never)
    await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
    await new Promise(r => setTimeout(r, 50))
    expect(edits[0]).toMatch(/Tests run: none this session/)
  })

  test('adds nothing when gh pr create fails', async ($, on) => {
    mock.store(on)
    const edits = setup(on, { createFails: true })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
    await new Promise(r => setTimeout(r, 50))
    expect(edits).toHaveLength(0)
  })

  test('/prnote off stops the note', async ($, on) => {
    mock.store(on)
    const edits = setup(on)
    expect((await $.command.run({ command: 'prnote', args: 'off' })).text).toBe('PR provenance note is off.')
    await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
    await new Promise(r => setTimeout(r, 50))
    expect(edits).toHaveLength(0)
    expect((await $.command.run({ command: 'prnote', args: 'on' })).text).toBe('PR provenance note is on.')
    await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
    await new Promise(r => setTimeout(r, 50))
    expect(edits).toHaveLength(1)
  })
})
