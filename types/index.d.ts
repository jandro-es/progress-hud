export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type AgentState = 'running' | 'idle' | 'done' | 'failed' | 'stopped'

export type AgentRow = {
  id: string
  label: string
  type: string
  state: AgentState
  model?: string
  startedAt: number
  endedAt?: number
  steps: number
  tokens: Tokens
  // Priced at list rates; the pane scales it by the session's real spend.
  listUsd: number
  isMain?: boolean
  isListed?: boolean
}

export type TaskState = 'pending' | 'in_progress' | 'completed'

export type TaskRow = {
  id: string
  subject: string
  activeForm?: string
  state: TaskState
  source: 'task' | 'todo'
  createdAt: number
  startedAt?: number
  completedAt?: number
  usdAtStart?: number
  usd?: number
}

export type SpendSample = { t: number; usd: number }

export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Meter = {
  now: number
  usd?: number
  // The session's spend when the mod first saw it, so calibration counts only what it watched.
  baseUsd?: number
  contextPercent?: number
  rateLimits: RateLimit[]
  samples: SpendSample[]
}

export type History = {
  agentMs: Record<string, number[]>
  agentUsd: Record<string, number[]>
  taskMs: number[]
  taskUsd: number[]
  // Durations of commands that exited cleanly, by what they run (`npm test`).
  shellMs?: Record<string, number[]>
}

// running: in the foreground, the loop waits on it; background: detached.
export type ShellState = 'running' | 'background' | 'done' | 'failed' | 'killed'

export type ShellRow = {
  id: string
  // The background task's id, once it has one.
  taskId?: string
  kind: 'shell' | 'monitor'
  command: string
  description?: string
  key: string
  agentId?: string
  state: ShellState
  startedAt: number
  endedAt?: number
  // The foreground timeout, or a monitor's deadline.
  limitMs?: number
  backgroundedBy?: 'model' | 'user' | 'timeout'
  exitCode?: number
  outputPath?: string
  outputBytes?: number
  outputLines?: number
  linesPerSec?: number
  // When the output file was last measured, for the rate.
  sampledAt?: number
  lastLine?: string
  hasStderr?: boolean
  // A monitor's events so far.
  events?: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-hud': {
      agents: Shaped<AgentRow[]>
      tasks: Shaped<TaskRow[]>
      shells: Shaped<ShellRow[]>
      meter: Shaped<Meter>
      history: Shaped<History>
      hasAutoOpened: boolean
    }
  }
}
