// Pure translation from Claude Code activity to AgentViz trace events (agentviz/v1).
// No $ here: register.tsx owns the engine, this file only shapes values, so it is tested directly.

export type Detail = 'summaries' | 'names'

// An AgentViz trace event, as the relay's POST /events takes it
export type VizEvent = { type: string; t: number; run?: string } & Record<string, unknown>

export const MAIN = 'claude'
export const USER = 'you'

// The tool calls that launch a subagent: agent.spawn draws those as agents, not tools
export const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

// One line, at most n characters
export function clip(text: string, n = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > n ? `${line.slice(0, n - 1)}…` : line
}

const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path

export type ToolNode = {
  id: string
  label: string
  kind: 'tool' | 'memory'
  // message kinds for the call and its result
  call: 'tool_call' | 'memory_write' | 'memory_read'
  result: 'tool_result' | 'memory_read'
}

// The node a tool is drawn as. Todo tools are Claude's working memory; MCP tools show their server
export function toolNode(tool: string): ToolNode {
  if (tool === 'TodoWrite' || /^Task(Create|Update|List|Get)$/.test(tool)) {
    return { id: 'mem.todos', label: 'Todo list', kind: 'memory', call: tool === 'TaskList' || tool === 'TaskGet' ? 'memory_read' : 'memory_write', result: 'memory_read' }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  const label = mcp ? `${mcp[1]!.replace(/_/g, ' ')} · ${mcp[2]}` : tool

  return { id: `tool.${tool}`, label, kind: 'tool', call: 'tool_call', result: 'tool_result' }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

// A short description of one tool call: the command, a file name, a pattern. Never file contents
export function summarize(tool: string, input: Record<string, unknown>, detail: Detail): string | undefined {
  if (detail === 'names') return undefined
  const path = str(input.file_path) ?? str(input.notebook_path)
  switch (tool) {
    case 'Bash':
      return str(input.command) && clip(str(input.description) ?? str(input.command)!)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return path && base(path)
    case 'Grep':
      return str(input.pattern) && clip(`"${input.pattern}"${str(input.path) ? ` in ${base(str(input.path)!)}` : ''}`)
    case 'Glob':
      return str(input.pattern) && clip(str(input.pattern)!)
    case 'WebFetch': {
      const url = str(input.url)
      try {
        return url && new URL(url).host
      } catch {
        return undefined
      }
    }
    case 'WebSearch':
      return str(input.query) && clip(str(input.query)!)
    case 'Skill':
      return str(input.skill) ?? str(input.command)
    default:
      return undefined
  }
}

// First line of a prompt or answer, or nothing when only names are sent
export function firstLine(text: string, detail: Detail, n = 80): string | undefined {
  if (detail === 'names') return undefined
  const line = text.split('\n').find(l => l.trim()) ?? ''

  return line ? clip(line.replace(/^#+\s*/, ''), n) : undefined
}

// Tokens a turn processed, from its usage
export function turnTokens(usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): number {
  if (!usage) return 0

  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}

// Rough token count of a tool result, for packet size (~4 characters a token)
export const estimateTokens = (text: unknown) => (typeof text === 'string' ? Math.round(text.length / 4) : 0)

// Relay URL without a trailing slash; http(s) only
export function relayBase(url: string): string | null {
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null

    return u.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}
