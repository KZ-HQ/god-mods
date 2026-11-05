import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register } from 'claude-code'

import type { StreamStats, StreamStatus } from '../types'
import { AGENT_TOOLS, MAIN, USER, clip, estimateTokens, firstLine, relayBase, summarize, toolNode, turnTokens } from './events.ts'
import type { Detail, VizEvent } from './events.ts'

// Streams this session to an AgentViz relay (KZ-HQ/threeMono apps/agentviz) as one run:
// you and Claude as agents, each prompt as a task, tools and the todo list as nodes, subagents
// as agents Claude delegates to, every call and result as a message between them.

const MOD = 'agentviz'
const PANE = 'agentviz'
const FLUSH_MS = 250
// While the relay is unreachable, try again this often instead of every tick
const RETRY_MS = 5000
const BATCH = 500
// Events kept while the relay is down; the oldest go first
const MAX_QUEUE = 5000
// Prompts kept on screen as tasks; older ones are removed from the graph
const KEEP_TURNS = 6

const EMPTY: StreamStats = { run: '', relay: '', status: 'connecting', sent: 0, queued: 0, toolCalls: 0, errors: 0, agents: 0, usd: 0, lastError: '' }

const streamStats = atom({ plugin: 'agentviz', key: 'stats' } as const, EMPTY, { shape: 'stats-1' })
const isPaused = atom({ plugin: 'agentviz', key: 'isPaused' } as const, false)

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: '○ Connecting',
  streaming: '● Streaming',
  offline: '▲ Relay unreachable',
  paused: '❚❚ Paused',
}

const errorText = (err: unknown) => clip(err instanceof Error ? err.message : String(err), 120)

// <metrics: generated from shared/metrics.ts by shared/sync.sh>
// Shared mod metrics (schema v2). Source of truth: ~/.claude/mods/shared/metrics.ts.
// shared/sync.sh inlines it between the metrics markers in each mod's register.tsx (the engine only lets $
// into functions declared in the same file). Edit here, run sync.sh, never edit an inlined copy.
//
// Rows appended to ~/.claude/mods/metrics.jsonl, all with { v: 2, t, mod, event, ver, session, project }:
//   loaded   once per load (logLoaded, or count() in the mod's session.start hook), at session.start: proves which version of the mod is running
//   turn     once per turn with activity (logTurns, or count() in the mod's turn.complete hook): { hooks: { <event>: calls } }
//   <other>  outcome rows from track(), e.g. merge-gate 'verdict'
// Privacy: never put prompt, command, tool-input or matched-secret text in a row; lengths, kinds and counts only.

const APPEND = 'mkdir -p "$HOME/.claude/mods" && printf "%s\\n" "$1" >> "$HOME/.claude/mods/metrics.jsonl"'


const ctx = { ver: '', session: '', project: '' }
const stats = new Map<string, number>()
let writeFailed = false

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

function write($: EngineInterface, mod: string, event: string, data: Record<string, unknown>): void {
  void (async () => {
    const t = new Date(await $.clock.now()).toISOString()
    if (!ctx.project) ctx.project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? ''
    const line = JSON.stringify({ v: 2, t, mod, event, ver: ctx.ver, session: ctx.session, project: ctx.project, ...data })
    const { exitCode, stderr } = await $.process.run(['/bin/sh', '-c', APPEND, 'mod-metrics', line], { timeoutMs: 3000 })
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
  })().catch((err: unknown) => {
    if (writeFailed) return
    writeFailed = true
    $.ui.toast(`${mod}: metrics write failed (${message(err)})`)
  })
}

// An outcome row: something the mod decided or did. Fire-and-forget.
function track($: EngineInterface, mod: string, event: string, data: Record<string, unknown> = {}): void {
  write($, mod, event, data)
}

async function loaded($: EngineInterface): Promise<void> {
  const mod = $.plugin.name
  ctx.session = await $.session.id().catch(() => '')
  ctx.project = ''
  try {
    const manifest = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)) as { version?: string }
    ctx.ver = manifest.version ?? ''
  } catch {
    ctx.ver = '?'
  }
  write($, mod, 'loaded', {})
}

function flush($: EngineInterface): void {
  const mod = $.plugin.name
  if (!stats.size) return
  const hooks = Object.fromEntries(stats)
  stats.clear()
  write($, mod, 'turn', { hooks })
}

// The engine allows one hook per event per plugin, and counts them by spelling. A mod that hooks
// session.start or turn.complete itself calls count() in that hook, which writes the row; otherwise
// it calls the matching helper once in register.
function logLoaded(on: On): void {
  on('session.start', async ($, e, next) => {
    await loaded($)

    return next(e)
  })
}

function logTurns(on: On): void {
  on('turn.complete', async ($, e, next) => {
    flush($)

    return next(e)
  })
}

// First statement of every hook: counts the call into this turn's row. The engine only accepts
// function literals as hooks, so calls are counted from inside rather than by wrapping.
// In a session.start hook it also writes the loaded row; in a turn.complete hook it writes the turn row.
function count($: EngineInterface, event: string): void {
  stats.set(event, (stats.get(event) ?? 0) + 1)
  if (event === 'session.start') void loaded($)
  if (event === 'turn.complete') flush($)
}
// </metrics>

// The stream's state: module level, because the engine only lets $ into functions declared at the
// top of this file. register() fills in the options; session.start resets the rest.
const S = {
  relay: null as string | null,
  relayText: '',
  token: '',
  detail: 'summaries' as Detail,
  run: '',
  queue: [] as VizEvent[],
  sending: false,
  paused: false,
  status: 'connecting' as StreamStatus,
  lastError: '',
  retryAt: 0,
  toldOffline: false,
  toldStreaming: false,
  published: '',
  tick: undefined as { cancel(): void } | undefined,
  counts: { sent: 0, toolCalls: 0, errors: 0, agents: 0, usd: 0 },
  // subagent id -> node id, and the Agent tool call that launched it -> node id
  agents: new Map<string, string>(),
  byToolUse: new Map<string, string>(),
  sent: new Set<string>(),
  turns: [] as string[],
  turnNo: 0,
  currentTurn: '',
  turnStartUsd: 0,
}

function viewUrl(): string {
  return S.relay ? `${S.relay}/?run=${encodeURIComponent(S.run)}` : ''
}

async function emit($: EngineInterface, ev: Omit<VizEvent, 't' | 'run'>): Promise<void> {
  if (S.paused || !S.run || !S.relay) return
  S.queue.push({ ...ev, t: await $.clock.now(), run: S.run } as VizEvent)
  if (S.queue.length > MAX_QUEUE) S.queue.splice(0, S.queue.length - MAX_QUEUE)
}

// node.add / edge.add once per session: the relay keeps them, so repeats only cost bandwidth
async function once($: EngineInterface, key: string, ev: Omit<VizEvent, 't' | 'run'>): Promise<void> {
  if (S.sent.has(key)) return
  S.sent.add(key)
  await emit($, ev)
}

async function publish($: EngineInterface): Promise<void> {
  const next: StreamStats = { run: S.run, relay: S.relay ?? S.relayText, status: S.paused ? 'paused' : S.status, queued: S.queue.length, lastError: S.lastError, ...S.counts }
  const key = JSON.stringify(next)
  if (key === S.published) return
  S.published = key
  await update($, streamStats, () => next)
}

async function sendQueued($: EngineInterface): Promise<void> {
  if (S.sending || !S.relay) return
  const now = await $.clock.now()
  if (!S.queue.length || (S.status === 'offline' && now < S.retryAt)) return publish($)
  S.sending = true
  const batch = S.queue.splice(0, BATCH)
  try {
    const res = await $.http.fetch(`${S.relay}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(S.token ? { authorization: `Bearer ${S.token}` } : {}) },
      body: JSON.stringify(batch),
    })
    if (!res.ok) throw new Error(res.status === 401 ? 'HTTP 401: the relay wants an ingest token (set it in /config)' : `HTTP ${res.status}`)
    S.counts.sent += batch.length
    if (S.status === 'offline') $.ui.toast(`AgentViz: relay reachable again, streaming to ${S.relay}`)
    else if (!S.toldStreaming) $.ui.toast('AgentViz: streaming this session · /agentviz for the live view')
    S.toldStreaming = true
    S.status = 'streaming'
    S.lastError = ''
  } catch (err) {
    // keep the events for the next try, newest kept when over the cap
    S.queue = [...batch, ...S.queue].slice(-MAX_QUEUE)
    S.lastError = errorText(err)
    S.retryAt = now + RETRY_MS
    if (!S.toldOffline) $.ui.toast(`AgentViz: can't reach ${S.relay} (${S.lastError}). Events are queued until it is up`)
    S.toldOffline = true
    S.status = 'offline'
  } finally {
    S.sending = false
  }
  await publish($)
}

async function setPaused($: EngineInterface, value: boolean): Promise<void> {
  S.paused = value
  await update($, isPaused, () => value)
  await publish($)
}

export const register: Register = (on, options) => {
  S.relayText = String(options.relayUrl ?? '')
  S.relay = relayBase(S.relayText)
  S.token = String(options.token ?? '')
  S.detail = options.detail === 'names' ? 'names' : 'summaries'
  const detail = S.detail

  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    const done = await next(e)
    await $.command.register({ name: 'agentviz', description: 'AgentViz live view: opens its pane; /agentviz off|on pauses or resumes streaming' })
    S.paused = await read($, isPaused)
    const id = await $.session.id().catch(() => '')
    S.run = `cc-${id || Math.round(await $.clock.now()).toString(36)}`
    S.queue = []
    S.sent.clear()
    S.agents.clear()
    S.byToolUse.clear()
    S.turns.length = 0
    S.turnNo = 0
    S.counts = { sent: 0, toolCalls: 0, errors: 0, agents: 0, usd: 0 }
    S.toldOffline = S.toldStreaming = false
    S.published = ''
    S.status = S.relay ? 'connecting' : 'offline'
    S.lastError = S.relay ? '' : `relay URL is not an http(s) URL: ${clip(S.relayText, 60)}`
    const project = done.cwd.split('/').filter(Boolean).pop() ?? 'session'
    const model = await $.session.model().catch(() => '')
    await emit($, { type: 'run.meta', label: `${project} · Claude Code`, meta: { source: 'claude-code', surface: e.surface ?? 'none' } })
    await once($, `n:${USER}`, { type: 'node.add', id: USER, kind: 'agent', label: 'You', meta: { human: true } })
    await once($, `n:${MAIN}`, { type: 'node.add', id: MAIN, kind: 'agent', label: 'Claude', meta: model ? { model } : {} })
    await once($, `e:${USER}>${MAIN}`, { type: 'edge.add', from: USER, to: MAIN, kind: 'delegates' })
    S.tick?.cancel()
    S.tick = $.clock.every(FLUSH_MS, () => void sendQueued($))
    await publish($)

    return done
  })

  on('turn.start', async ($, e, next) => {
    count($, 'turn.start')
    if (e.agentId !== undefined) {
      const node = S.agents.get(e.agentId)
      if (node) await emit($, { type: 'node.update', id: node, status: 'running', detail: 'working' })

      return next(e)
    }
    S.turnNo++
    S.currentTurn = `task.turn-${S.turnNo}`
    S.turnStartUsd = (await $.session.usage().catch(() => undefined))?.cost?.usd ?? S.turnStartUsd
    await emit($, { type: 'node.add', id: S.currentTurn, kind: 'task', label: firstLine(e.text, detail, 48) ?? `Prompt ${S.turnNo}`, status: 'running' })
    await emit($, { type: 'edge.add', from: MAIN, to: S.currentTurn, kind: 'assigned' })
    await emit($, { type: 'message', from: USER, to: MAIN, kind: 'prompt', summary: firstLine(e.text, detail), tokens: estimateTokens(e.text) })
    await emit($, { type: 'node.update', id: MAIN, status: 'running', detail: 'thinking' })
    S.turns.push(S.currentTurn)
    while (S.turns.length > KEEP_TURNS) await emit($, { type: 'node.remove', id: S.turns.shift()! })

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    const failed = e.reason === 'error' || e.reason === 'refusal'
    const tokens = turnTokens(done.usage)
    if (e.agentId !== undefined) {
      const node = S.agents.get(e.agentId)
      if (node) {
        if (tokens) await emit($, { type: 'usage', id: node, tokens })
        await emit($, { type: 'node.update', id: node, status: failed ? 'error' : 'done', detail: failed ? e.reason : 'finished' })
      }

      return done
    }
    const usd = (await $.session.usage().catch(() => undefined))?.cost?.usd
    if (usd !== undefined) S.counts.usd = usd
    if (tokens || usd !== undefined) await emit($, { type: 'usage', id: MAIN, tokens, costUsd: usd !== undefined ? Math.max(0, usd - S.turnStartUsd) : undefined })
    if (!e.isAborted && e.answer) await emit($, { type: 'message', from: MAIN, to: USER, kind: 'response', summary: firstLine(e.answer, detail), tokens: estimateTokens(e.answer) })
    if (failed) S.counts.errors++
    if (S.currentTurn) await emit($, { type: 'node.update', id: S.currentTurn, status: failed ? 'error' : 'done', progress: 1, detail: e.isAborted ? 'stopped' : failed ? e.reason : 'answered' })
    await emit($, { type: 'node.update', id: MAIN, status: failed ? 'error' : 'idle', detail: e.isAborted ? 'stopped' : '' })

    return done
  })

  on('agent.spawn', async ($, e, next) => {
    count($, 'agent.spawn')
    const done = await next(e)
    if (done.deny !== undefined || !done.agentId) return done
    const parentId = (e as { agentId?: string }).agentId
    const parent = (parentId !== undefined && S.agents.get(parentId)) || MAIN
    const node = `agent.${done.agentId}`
    S.agents.set(done.agentId, node)
    S.byToolUse.set(e.tool_use_id, node)
    S.counts.agents++
    const label = detail === 'names' ? e.subagentType : clip(`${e.subagentType}: ${e.description}`, 48)
    await emit($, { type: 'node.add', id: node, kind: 'agent', label, parent, status: 'running', meta: { type: e.subagentType, model: done.model } })
    await emit($, { type: 'edge.add', from: parent, to: node, kind: 'delegates' })
    await emit($, { type: 'message', from: parent, to: node, kind: 'handoff', summary: firstLine(e.description, detail), tokens: estimateTokens(e.prompt) })

    return done
  })

  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    const actor = (e.agentId !== undefined && S.agents.get(e.agentId)) || MAIN
    // The call that runs a subagent: its result is the subagent reporting back
    if (AGENT_TOOLS.has(e.tool)) {
      const done = await next(e)
      const node = S.byToolUse.get(e.tool_use_id ?? '')
      if (node) {
        const bad = done.deny !== undefined || done.isError === true
        await emit($, { type: 'message', from: node, to: actor, kind: bad ? 'error' : 'response', summary: bad ? 'failed' : 'report', tokens: estimateTokens(done.text) })
        await emit($, { type: 'node.update', id: node, status: bad ? 'error' : 'done' })
      }

      return done
    }
    if (S.paused || !S.relay) return next(e)
    const tool = toolNode(e.tool)
    const summary = summarize(e.tool, e as unknown as Record<string, unknown>, detail)
    S.counts.toolCalls++
    await once($, `n:${tool.id}`, { type: 'node.add', id: tool.id, kind: tool.kind, label: tool.label })
    await once($, `e:${actor}>${tool.id}`, { type: 'edge.add', from: actor, to: tool.id, kind: tool.kind === 'memory' ? 'writes' : 'uses' })
    await emit($, { type: 'message', from: actor, to: tool.id, kind: tool.call, summary })
    await emit($, { type: 'node.update', id: tool.id, status: 'running', detail: summary ?? '' })
    await emit($, { type: 'node.update', id: actor, status: 'waiting', detail: summary ? `${e.tool}: ${summary}` : e.tool })
    const done = await next(e)
    if (done.deny !== undefined) {
      await emit($, { type: 'message', from: tool.id, to: actor, kind: 'error', summary: 'blocked' })
      await emit($, { type: 'node.update', id: tool.id, status: 'idle', detail: '' })
    } else if (done.isError === true) {
      S.counts.errors++
      const why = detail === 'names' || typeof done.text !== 'string' ? 'failed' : clip(done.text, 100)
      await emit($, { type: 'message', from: tool.id, to: actor, kind: 'error', summary: why })
      await emit($, { type: 'node.update', id: tool.id, status: 'error', detail: why })
    } else {
      await emit($, { type: 'message', from: tool.id, to: actor, kind: tool.result, summary: summary && `ok: ${summary}`, tokens: estimateTokens(done.text) })
      await emit($, { type: 'node.update', id: tool.id, status: 'idle', detail: '' })
    }
    await emit($, { type: 'node.update', id: actor, status: 'running', detail: actor === MAIN ? 'thinking' : 'working' })

    return done
  })

  on('session.end', async ($, e, next) => {
    count($, 'session.end')
    await emit($, { type: 'node.update', id: MAIN, status: 'done', detail: 'session ended' })
    await emit($, { type: 'node.update', id: USER, status: 'done' })
    S.tick?.cancel()
    S.tick = undefined
    // one last send, after any send already under way
    for (let i = 0; i < 20 && S.sending; i++) await $.clock.sleep(50)
    S.retryAt = 0
    await sendQueued($)
    track($, MOD, 'stream', { sent: S.counts.sent, unsent: S.queue.length, toolCalls: S.counts.toolCalls, agents: S.counts.agents, wasOffline: S.toldOffline })

    return next(e)
  })

  on('command.run', { command: 'agentviz' }, async ($, e) => {
    count($, 'command.run{agentviz}')
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      await setPaused($, arg === 'off')

      return { text: S.paused ? 'AgentViz streaming paused for this session. /agentviz on resumes it.' : 'AgentViz streaming resumed.' }
    }
    await $.ui.open({ id: PANE, title: 'AgentViz' })
    await publish($)
    if (!S.relay) return { text: `AgentViz: ${S.lastError}. Set the relay URL in /config.` }

    return { text: `AgentViz: ${STATUS_TEXT[S.paused ? 'paused' : S.status].replace(/^\S+ /, '').toLowerCase()} · live view: ${viewUrl()}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    count($, 'ui.render')
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const s = await read($, streamStats)
    const isOff = await read($, isPaused)
    const status: StreamStatus = isOff ? 'paused' : s.status
    const href = s.relay && s.run ? `${s.relay}/?run=${encodeURIComponent(s.run)}` : ''

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text bold color={status === 'offline' ? 'error' : status === 'streaming' ? 'success' : undefined}>
            {STATUS_TEXT[status]}
          </Text>
          <Text dimColor wrap="truncate-middle">
            {s.relay || 'no relay URL'}
          </Text>
          {s.lastError !== '' && <Text color="error">{s.lastError}</Text>}
        </Box>
        {href !== '' && <Link href={href} label="Open the 3D live view" />}
        <Box flexDirection="column">
          <Text>
            {s.toolCalls} tool calls · {s.agents} subagents · {s.errors} errors
          </Text>
          <Text dimColor>
            {s.sent} events sent{s.queued ? ` · ${s.queued} queued` : ''}
            {s.usd ? ` · $${s.usd.toFixed(2)} session` : ''}
          </Text>
        </Box>
        <Button
          key="pause"
          label={isOff ? 'Resume streaming' : 'Pause streaming'}
          onPress={() => setPaused($, !isOff)}
        />
      </Box>
    )
  })
}
