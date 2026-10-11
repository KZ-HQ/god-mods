import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, Register } from 'claude-code'

import type { FleetAgent } from '../types'
import { GLYPH, describeTool, elapsed, tokens } from './format.ts'

const PANE = 'fleet'

// claude-opus-5-5 → opus-5-5; anything else as given
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
const TICK_MS = 5000
const KEEP = 30

const agents = atom({ plugin: 'agent-fleet', key: 'agents' } as const, [])
const now = atom({ plugin: 'agent-fleet', key: 'now' } as const, 0)
const wasClosed = atom({ plugin: 'agent-fleet', key: 'wasClosed' } as const, false)

const patch = ($: EngineInterface, id: string, fn: (a: FleetAgent) => FleetAgent) =>
  update($, agents, list => list.map(a => (a.id === id ? fn(a) : a)))

// A finished agent that is messaged again (SendMessage) resumes under the same id
const revive = (a: FleetAgent): FleetAgent => (a.status === 'running' ? a : { ...a, status: 'running', endedAt: null })

async function showStatus($: EngineInterface) {
  const running = (await read($, agents)).filter(a => a.status === 'running').length
  $.ui.status(running > 0 ? `agents: ${running} running (/fleet)` : undefined)
}

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    count($, 'session.start')
    await $.command.register({ name: 'fleet', description: 'Show running background agents in a pane; /fleet clear drops finished ones' })
    // Elapsed times move while agents run; nothing redraws while none do
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const live = await $.agent.list().catch(() => undefined)
        if (!live) return
        const known = new Set((await read($, agents)).map(a => a.id))
        const now_ = Date.now()
        // Agents started before this module loaded (a reload, /reload-plugins) never raised our agent.spawn
        const found: FleetAgent[] = live
          .filter(a => !known.has(a.id) && (a.status === 'running' || a.status === 'pending' || a.status === 'waiting'))
          .map(a => ({
            id: a.id,
            description: a.description,
            type: a.type,
            model: '',
            startedAt: now_,
            endedAt: null,
            status: 'running',
            tools: 0,
            lastTool: 'already running when the fleet loaded',
            contextTokens: 0,
            tokensOut: 0,
          }))
        if (found.length) await update($, agents, list => [...list, ...found].slice(-KEEP))

        const live_ = new Map(live.map(a => [a.id, a.status]))
        const isLive = (s: string | undefined) => s === 'running' || s === 'pending' || s === 'waiting'
        if ((await read($, agents)).some(a => a.status !== 'running' && isLive(live_.get(a.id)))) {
          await update($, agents, all => all.map(a => (a.status !== 'running' && isLive(live_.get(a.id)) ? revive(a) : a)))
        }

        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) {
          await showStatus($)

          return
        }
        await update($, now, () => now_)
        // Agents can end without a turn.complete reaching us (stopped, failed to start)
        const status = new Map(live.map(a => [a.id, a.status]))
        await update($, agents, all =>
          all.map(a => {
            const s = status.get(a.id)
            if (a.status !== 'running' || s === undefined || s === 'running' || s === 'pending' || s === 'waiting') return a

            return { ...a, status: s === 'completed' || s === 'idle' ? 'completed' : s === 'killed' ? 'killed' : 'failed', endedAt: now_ }
          }),
        )
        await showStatus($)
      })()
    })

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    count($, 'command.run')
    if (e.args.trim() === 'clear') {
      await update($, agents, list => list.filter(a => a.status === 'running'))

      return { text: 'Cleared finished agents.' }
    }
    await update($, wasClosed, () => false)
    await update($, now, () => Date.now())
    await $.ui.open({ id: PANE, title: 'Agents' })
    const list = await read($, agents)

    return { text: `${list.filter(a => a.status === 'running').length} running, ${list.length} this session.` }
  })

  on('agent.spawn', async ($, e, next) => {
    count($, 'agent.spawn')
    const r = await next(e)
    if (r.deny !== undefined || !r.agentId) return r

    const agent: FleetAgent = {
      id: r.agentId,
      description: e.description,
      type: e.subagentType,
      model: r.model,
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      tools: 0,
      lastTool: 'starting',
      contextTokens: 0,
      tokensOut: 0,
    }
    await update($, agents, list => [...list.filter(a => a.id !== agent.id), agent].slice(-KEEP))
    await update($, now, () => Date.now())
    await showStatus($)
    // Unasked, it seats only where there's room for a sidebar; closed once, it stays closed
    if (!(await read($, wasClosed))) void $.ui.open({ id: PANE, title: 'Agents' })

    return r
  })

  on('tool.call', async ($, e, next) => {
    count($, 'tool.call')
    if (e.agentId === undefined) return next(e)
    const id = e.agentId
    await patch($, id, a => ({ ...revive(a), tools: a.tools + 1, lastTool: describeTool(e as unknown as Record<string, unknown>) }))
    await showStatus($)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    count($, 'turn.step')
    const r = yield* next(e)
    const id = e.agentId
    if (id !== undefined && r.usage) {
      const u = r.usage
      await patch($, id, a => ({
        ...revive(a),
        // Each request re-reads the whole context: summing it would count the same tokens again every step
        // Agents found by the tick start with no model; the request names it
        model: u.model || a.model,
        contextTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        tokensOut: a.tokensOut + u.output_tokens,
      }))
    }

    return r
  })

  on('turn.complete', async ($, e, next) => {
    count($, 'turn.complete')
    const done = await next(e)
    if (e.agentId === undefined) return done
    const status = e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'killed' : 'failed'
    await patch($, e.agentId, a => ({ ...a, status, endedAt: Date.now() }))
    await showStatus($)

    return done
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    count($, 'ui.close')
    if (e.origin.kind === 'person') await update($, wasClosed, () => true)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    count($, 'ui.render')
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const at = (await read($, now)) || Date.now()
    const width = Math.max(24, e.props.bodyColumns)
    const running = list.filter(a => a.status === 'running')
    const finished = list.filter(a => a.status !== 'running').slice(-8).reverse()

    const row = (a: FleetAgent) => (
      <Box flexDirection="column" key={a.id}>
        <Box flexDirection="row" gap={1}>
          <Text color={a.status === 'failed' ? 'red' : a.status === 'running' ? 'cyan' : undefined}>{GLYPH[a.status]}</Text>
          <Text bold={a.status === 'running'} wrap="truncate-end">
            {a.description}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {'  '}
          {elapsed((a.endedAt ?? at) - a.startedAt)} · {a.tools} tools · ctx {tokens(a.contextTokens)} · out {tokens(a.tokensOut)} · {a.type}
          {a.model ? ` · ${shortModel(a.model)}` : ''}
        </Text>
        {a.status === 'running' && (
          <Box flexDirection="row" gap={1}>
            <Text dimColor wrap="truncate-end">
              {'  '}
              {a.lastTool}
            </Text>
          </Box>
        )}
        {a.status === 'running' && (
          <Button
            key={`stop-${a.id}`}
            label="Stop"
            onPress={async () => {
              const r = await $.tool.call({ tool: 'TaskStop', task_id: a.id })
              track($, 'agent-fleet', 'stopped', { ok: r.deny === undefined && !r.isError })
              if (r.deny !== undefined || r.isError) $.ui.toast(`Couldn't stop ${a.description}: ${r.deny ?? r.text ?? 'error'}`)
            }}
          />
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" width={width}>
        {list.length === 0 && <Text dimColor>No background agents yet.</Text>}
        {running.map(row)}
        {finished.length > 0 && <Text dimColor>── finished ──</Text>}
        {finished.map(row)}
      </Box>
    )
  })
}
