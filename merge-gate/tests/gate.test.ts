import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
