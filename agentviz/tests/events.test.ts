import { describe, expect, test } from 'claude-code/testing'

import { clip, firstLine, relayBase, summarize, toolNode, turnTokens } from '../hooks/events.ts'

describe('agentviz translation', () => {
  test('summaries name the command, file or pattern, never contents', () => {
    expect(summarize('Bash', { command: 'npm test -- --watch=false', description: 'Run the tests' }, 'summaries')).toBe('Run the tests')
    expect(summarize('Bash', { command: 'ls  -la\n  src' }, 'summaries')).toBe('ls -la src')
    expect(summarize('Edit', { file_path: '/repo/src/app.ts', old_string: 'secret', new_string: 'x' }, 'summaries')).toBe('app.ts')
    expect(summarize('Grep', { pattern: 'TODO', path: '/repo/src' }, 'summaries')).toBe('"TODO" in src')
    expect(summarize('WebFetch', { url: 'https://example.com/a?b=c' }, 'summaries')).toBe('example.com')
    expect(summarize('mcp__linear__save_issue', { title: 'x' }, 'summaries')).toBeUndefined()
  })

  test('names mode sends no summaries or prompt text', () => {
    expect(summarize('Bash', { command: 'rm -rf build' }, 'names')).toBeUndefined()
    expect(firstLine('Fix the login bug', 'names')).toBeUndefined()
    expect(firstLine('\n## Fixed it\nDetails', 'summaries')).toBe('Fixed it')
  })

  test('tools map to nodes: todo tools are memory, MCP tools show their server', () => {
    expect(toolNode('TodoWrite')).toMatchObject({ id: 'mem.todos', kind: 'memory', call: 'memory_write' })
    expect(toolNode('mcp__claude_ai_Linear__list_issues')).toMatchObject({ id: 'tool.mcp__claude_ai_Linear__list_issues', label: 'claude ai Linear · list_issues', kind: 'tool' })
    expect(toolNode('Bash')).toMatchObject({ id: 'tool.Bash', label: 'Bash', call: 'tool_call', result: 'tool_result' })
  })

  test('relay URLs, clipping and token counts', () => {
    expect(relayBase('http://localhost:8787/')).toBe('http://localhost:8787')
    expect(relayBase('https://viz.example.com/base//')).toBe('https://viz.example.com/base')
    expect(relayBase('ftp://x')).toBeNull()
    expect(relayBase('not a url')).toBeNull()
    expect(clip('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`)
    expect(turnTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 })).toBe(116)
    expect(turnTokens(undefined)).toBe(0)
  })
})
