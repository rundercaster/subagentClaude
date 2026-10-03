export type AgentStatus = 'running' | 'done' | 'error' | 'aborted'

export type AgentToolCall = {
  id: string
  tool: string
  summary: string
  isDone: boolean
  isError: boolean
}

export type AgentRun = {
  id: string
  description: string
  type: string
  model: string
  prompt: string
  name: string
  parentId: string
  isBackground: boolean
  isFork: boolean
  status: AgentStatus
  startedAt: number
  endedAt: number
  answer: string
  steps: number
  messageCount: number
  contextTokens: number
  outputTokens: number
  toolCount: number
  tools: AgentToolCall[]
}

export type InspectorTab = 'prompt' | 'context' | 'tools' | 'output'

declare module 'claude-code' {
  interface PluginState {
    'subagent-inspector': {
      runs: AgentRun[]
      selected: string
      tab: InspectorTab
    }
  }
}
