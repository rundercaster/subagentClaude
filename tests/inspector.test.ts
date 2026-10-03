import { expect, mock, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
const AGENT = 'agent-1'

const PANE = {
  plugin: 'subagent-inspector',
  component: 'Pane',
  requestId: 'subagents',
  props: {
    title: 'Subagents',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('records a subagent run and draws prompt, context, tools and output on every surface', async ($, on) => {
  mock.clock(on)
  on('agent.spawn', () => ({ model: 'test-model', agentId: AGENT }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [{ id: AGENT, description: 'Find bugs', type: 'Explore', status: 'running' }] }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Look for bugs in src/', toolUses: [] },
      {
        role: 'assistant',
        text: 'Reading files now.',
        toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls src' }, text: 'a.py\nb.py' }],
      },
    ],
  }))
  on('tool.call', () => ({ result: { stdout: 'a.py' }, text: 'a.py' }))
  on('turn.step', async function* () {
    return {
      turnId: 'turn-1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'test-model',
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 400,
      },
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))

  await $.agent.spawn({
    tool_use_id: 'spawn-1',
    prompt: 'Look for bugs in src/',
    description: 'Find bugs',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'test-model',
    background: true,
    fork: false,
  })
  await $.tool.call({ tool: 'Bash', command: 'ls src', tool_use_id: 'tool-1', agentId: AGENT } as never)
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'test-model', messageCount: 2, agentId: AGENT })
  for await (const _ of stream) {
  }
  await $.turn.complete({
    answer: 'Found 2 bugs.',
    durationMs: 1000,
    isAborted: false,
    turnId: 'turn-1',
    agentId: AGENT,
    reason: 'answer',
  })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const has = async (type: string, text: RegExp, what: string) =>
      expect(await ui.find({ type, text }), `${what} on ${surface}`).toBeDefined()

    expect((await ui.find({ key: `agent:${AGENT}` }))?.text, `agent row on ${surface}`).toMatch(
      /✓ Find bugs · Explore · .* · 2\.5k ctx · 1 tools/,
    )
    await has('Markdown', /Look for bugs in src/, 'prompt')

    await ui.press({ key: 'tab:context' })
    await has('Text', /2\.5k tokens in context/, 'context size')
    await has('Text', /→ Bash ls src/, 'context tool use')

    await ui.press({ key: 'tab:tools' })
    await has('Text', /✓ Bash ls src/, 'tool list')

    await ui.press({ key: 'tab:output' })
    await has('Markdown', /Found 2 bugs\./, 'output')

    await ui.press({ key: 'tab:prompt' })
    await ui.unmount()
  }
})

test('shows an empty state before any subagent runs', async ($, on) => {
  mock.clock(on)
  on('agent.list', () => ({ value: [] }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No subagents yet/ })).toBeDefined()
  await ui.unmount()
})
