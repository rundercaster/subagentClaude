import { atom, read, update } from 'claude-code'
import type { AgentInfo, Register, SessionMessage, StateDollar } from 'claude-code'

import type { AgentRun, AgentStatus, AgentToolCall, InspectorTab } from '../types'

const PANE = 'subagents'
const TITLE = 'Subagents'
const MAX_RUNS = 50
const MAX_TOOLS = 200
const MAX_STORED = 60000
const MAX_DRAWN = 9000
const MAX_MESSAGE = 1500
const MAX_RESULT = 300
const CONTEXT_MESSAGES = 40
const TOOLS_SHOWN = 100

const runs = atom({ plugin: 'subagent-inspector', key: 'runs' } as const, [])
const selected = atom({ plugin: 'subagent-inspector', key: 'selected' } as const, '')
const tab = atom({ plugin: 'subagent-inspector', key: 'tab' } as const, 'prompt')

const TABS: { id: InspectorTab; label: string; hotkey: string }[] = [
  { id: 'prompt', label: 'Prompt', hotkey: 'p' },
  { id: 'context', label: 'Context', hotkey: 'c' },
  { id: 'tools', label: 'Tools', hotkey: 't' },
  { id: 'output', label: 'Output', hotkey: 'o' },
]

const GLYPH: Record<AgentStatus, string> = { running: '●', done: '✓', error: '✗', aborted: '■' }
const COLOR: Record<AgentStatus, string> = {
  running: 'warning',
  done: 'success',
  error: 'error',
  aborted: 'inactive',
}

const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'prompt']

// Surfaces refuse control characters other than tab and newline (ANSI escapes in Bash output)
const clean = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text

const oneLine = (text: string, max: number) => {
  const line = clean(text).replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function summarize(input: object): string {
  const fields = input as Record<string, unknown>
  for (const key of SUMMARY_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value, 120)
  }
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => !RESERVED.has(key)))
  return oneLine(JSON.stringify(rest), 120)
}

const blank = (id: string, now: number): AgentRun => ({
  id,
  description: '',
  type: '',
  model: '',
  prompt: '',
  name: '',
  parentId: '',
  isBackground: false,
  isFork: false,
  status: 'running',
  startedAt: now,
  endedAt: 0,
  answer: '',
  steps: 0,
  messageCount: 0,
  contextTokens: 0,
  outputTokens: 0,
  toolCount: 0,
  tools: [],
})

// Creates the run on first sight, so agents started before this mod loaded still show
const upsert = ($: StateDollar, id: string, now: number, fn: (run: AgentRun) => AgentRun) =>
  update($, runs, list => {
    const found = list.find(run => run.id === id)
    const changed = fn(found ?? blank(id, now))
    return found ? list.map(run => (run.id === id ? changed : run)) : [...list, changed].slice(-MAX_RUNS)
  })

// Agents only the engine knows of (spawned before this mod loaded, teammates) join the list
function merge(list: AgentRun[], known: AgentInfo[], now: number): AgentRun[] {
  const merged = list.map(run => {
    const info = known.find(one => one.id === run.id)
    if (info === undefined) return run
    const isGone = run.status === 'running' && (info.status === 'killed' || info.status === 'failed')
    return {
      ...run,
      description: run.description || info.description,
      type: run.type || info.type,
      name: run.name || (info.name ?? ''),
      status: isGone ? ('aborted' as const) : run.status,
    }
  })
  const extra = known
    .filter(info => !list.some(run => run.id === info.id))
    .map(info => ({
      ...blank(info.id, now),
      description: info.description,
      type: info.type,
      name: info.name ?? '',
      parentId: info.parentId ?? '',
      status: info.status === 'running' ? ('running' as const) : info.status === 'completed' ? ('done' as const) : ('aborted' as const),
    }))
  return [...merged, ...extra]
}

export const register: Register = on => {
  let hasOpened = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'subagents',
      description: 'Inspect subagents: prompt, live context, tool calls, output',
    })

    return next(e)
  })

  on('command.run', { command: 'subagents' }, async $ => {
    hasOpened = true
    await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: 'Subagents pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const id = started.agentId
    if (id === undefined) return started

    const now = await $.clock.now()
    await upsert($, id, now, run => ({
      ...run,
      description: e.description,
      type: e.subagentType,
      model: started.model ?? run.model,
      prompt: clip(e.prompt, MAX_STORED),
      name: e.name ?? '',
      parentId: e.parentAgentId ?? '',
      isBackground: e.background,
      isFork: e.fork,
      status: 'running',
      startedAt: now,
    }))
    await update($, selected, current => (current === '' ? id : current))

    if (!hasOpened) {
      hasOpened = true
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return started
  })

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)

    const now = await $.clock.now()
    const call: AgentToolCall = {
      id: e.tool_use_id ?? `${agentId}-${now}`,
      tool: String(e.tool),
      summary: summarize(e),
      isDone: false,
      isError: false,
    }
    await upsert($, agentId, now, run => ({
      ...run,
      status: 'running',
      toolCount: run.toolCount + 1,
      tools: [...run.tools, call].slice(-MAX_TOOLS),
    }))

    const ran = await next(e)
    const isError = ran.deny !== undefined || ran.isError === true
    await upsert($, agentId, now, run => ({
      ...run,
      tools: run.tools.map(one => (one.id === call.id ? { ...one, isDone: true, isError } : one)),
    }))

    return ran
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (agentId === undefined) return yield* next(e)

    const step = yield* next(e)
    const usage = step.usage
    const now = await $.clock.now()
    await upsert($, agentId, now, run => ({
      ...run,
      status: 'running',
      steps: run.steps + 1,
      messageCount: e.messageCount,
      model: usage?.model ?? run.model,
      contextTokens: usage
        ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        : run.contextTokens,
      outputTokens: run.outputTokens + (usage?.output_tokens ?? 0),
    }))

    return step
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId === undefined) return next(e)

    const now = await $.clock.now()
    const status: AgentStatus = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'aborted' : 'error'
    await upsert($, agentId, now, run => ({ ...run, status, endedAt: now, answer: clip(e.answer, MAX_STORED) }))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const now = await $.clock.now()
    const list = merge(await read($, runs), await $.agent.list(), now)
    const chosenId = await read($, selected)
    const current = await read($, tab)
    const width = Math.max(20, e.props.bodyColumns - 4)

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No subagents yet.</Text>
          <Text dimColor>They show up here as soon as Claude starts one.</Text>
        </Box>
      )
    }

    const newest = [...list].reverse()
    const run = newest.find(one => one.id === chosenId) ?? newest[0]!
    const elapsed = (one: AgentRun) => duration((one.endedAt || now) - one.startedAt)
    const label = (one: AgentRun) =>
      oneLine(
        `${GLYPH[one.status]} ${one.description || one.name || one.id} · ${one.type || '?'} · ${elapsed(one)}` +
          (one.contextTokens > 0 ? ` · ${tokens(one.contextTokens)} ctx` : '') +
          ` · ${one.toolCount} tools`,
        width,
      )

    const found = await $.session.messages({ agentId: run.id })
    const messages: SessionMessage[] = Array.isArray(found) ? found : []
    const firstUser = messages.find(message => message.role === 'user')?.text ?? ''
    const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant' && message.text !== '')?.text ?? ''

    const meta = [
      run.type && `type ${run.type}`,
      run.model && `model ${run.model}`,
      run.isBackground ? 'background' : 'foreground',
      run.isFork && 'fork',
      run.name && `name ${run.name}`,
      run.parentId && `parent ${run.parentId}`,
      `id ${run.id}`,
    ].filter(Boolean)

    const body = () => {
      if (current === 'prompt') {
        const prompt = run.prompt || firstUser
        return (
          <Box flexDirection="column">
            <Text dimColor>{oneLine(meta.join(' · '), width * 3)}</Text>
            {prompt === '' ? (
              <Text dimColor>Prompt not captured (agent started before this mod loaded).</Text>
            ) : (
              <Markdown text={clip(clean(prompt), MAX_DRAWN)} />
            )}
          </Box>
        )
      }

      if (current === 'context') {
        const shown = messages.slice(-CONTEXT_MESSAGES)
        return (
          <Box flexDirection="column">
            <Text color="permission">
              {`≈${tokens(run.contextTokens)} tokens in context · ${messages.length} messages · ${run.steps} model calls · ${tokens(run.outputTokens)} tokens out`}
            </Text>
            {!Array.isArray(found) && <Text dimColor>{oneLine(found.deny, width * 2)}</Text>}
            {messages.length > shown.length && (
              <Text dimColor>{`… ${messages.length - shown.length} earlier messages`}</Text>
            )}
            {shown.map((message, index) => (
              <Box flexDirection="column" marginTop={1}>
                <Text bold color={message.role === 'user' ? 'suggestion' : 'claude'}>
                  {`${message.role} #${messages.length - shown.length + index + 1}`}
                </Text>
                {message.text !== '' && <Markdown text={clip(clean(message.text), MAX_MESSAGE)} />}
                {message.toolUses.map(use => (
                  <Box flexDirection="column">
                    <Text>{oneLine(`→ ${use.tool} ${summarize(use.input)}`, width)}</Text>
                    {use.text !== undefined && (
                      <Text dimColor color={use.isError ? 'error' : undefined}>
                        {`  ← ${oneLine(use.text, MAX_RESULT)}`}
                      </Text>
                    )}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )
      }

      if (current === 'tools') {
        const shown = run.tools.slice(-TOOLS_SHOWN)
        return (
          <Box flexDirection="column">
            <Text dimColor>{`${run.toolCount} tool calls${run.toolCount > shown.length ? `, last ${shown.length} shown` : ''}`}</Text>
            {shown.length === 0 && <Text dimColor>No tool calls yet.</Text>}
            {shown.map(call => (
              <Text
                color={call.isDone ? (call.isError ? 'error' : undefined) : 'warning'}
                dimColor={call.isDone && !call.isError}
              >
                {oneLine(`${call.isDone ? (call.isError ? '✗' : '✓') : '…'} ${call.tool}  ${call.summary}`, width)}
              </Text>
            ))}
          </Box>
        )
      }

      const answer = run.answer
      return (
        <Box flexDirection="column">
          {answer !== '' && <Markdown text={clip(clean(answer), MAX_DRAWN)} />}
          {answer === '' && run.status === 'running' && (
            <Text dimColor>Still running. Latest text from the agent:</Text>
          )}
          {answer === '' && lastAssistant !== '' && <Markdown text={clip(clean(lastAssistant), MAX_DRAWN)} />}
          {answer === '' && lastAssistant === '' && <Text dimColor>No output yet.</Text>}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {newest.map((one, index) => (
          <Box>
            <Text color={COLOR[one.status]}>{one.id === run.id ? '▸ ' : '  '}</Text>
            <Button
              key={`agent:${one.id}`}
              label={label(one)}
              plain
              hotkey={index < 9 ? String(index + 1) : undefined}
              dimColor={one.id !== run.id}
              onPress={() => update($, selected, () => one.id)}
            />
          </Box>
        ))}
        <Box marginTop={1} gap={1} flexWrap="wrap">
          {TABS.map(item => (
            <Button
              key={`tab:${item.id}`}
              label={item.label}
              hotkey={item.hotkey}
              variant={item.id === current ? 'primary' : 'secondary'}
              onPress={() => update($, tab, () => item.id)}
            />
          ))}
          <Button
            key="clear"
            label="Clear finished"
            hotkey="x"
            dimColor
            onPress={() => update($, runs, all => all.filter(one => one.status === 'running'))}
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold color={COLOR[run.status]}>
            {oneLine(`${GLYPH[run.status]} ${run.description || run.name || run.id} (${run.status}, ${elapsed(run)})`, width)}
          </Text>
          {body()}
        </Box>
      </Box>
    )
  })
}
