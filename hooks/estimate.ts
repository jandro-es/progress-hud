import type { AgentRow, History, Meter, SpendSample, TaskRow, Tokens } from '../types'

export const EMPTY_HISTORY: History = { agentMs: {}, agentUsd: {}, taskMs: [], taskUsd: [] }
export const ZERO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const HISTORY_KEEP = 30

// List prices in US dollars per million tokens, by model family. Only the
// ratios matter once the session's real spend calibrates them.
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /haiku/i, input: 1, output: 5 },
  { match: /sonnet/i, input: 3, output: 15 },
  { match: /opus|fable/i, input: 5, output: 25 },
]
const DEFAULT_PRICE = { input: 5, output: 25 }

export function listUsd(model: string | undefined, t: Tokens): number {
  const price = PRICES.find(p => model !== undefined && p.match.test(model)) ?? DEFAULT_PRICE
  const input = t.input + t.cacheWrite * 1.25 + t.cacheRead * 0.1

  return (input * price.input + t.output * price.output) / 1_000_000
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}

export function totalTokens(t: Tokens): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite
}

// How far list prices are off the session's real spend: real dollars per
// list dollar, over everything the mod watched since it loaded.
export function calibration(meter: Meter, agents: readonly AgentRow[]): number {
  const watched = agents.reduce((sum, a) => sum + a.listUsd, 0)
  if (meter.usd === undefined || meter.baseUsd === undefined || watched < 0.02) return 1
  const real = meter.usd - meter.baseUsd
  if (real <= 0) return 1

  return Math.min(5, Math.max(0.2, real / watched))
}

export function median(xs: readonly number[]): number | undefined {
  if (xs.length === 0) return undefined
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  const at = (i: number) => sorted[i] ?? 0

  return sorted.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2
}

export function remember(xs: readonly number[] | undefined, x: number): number[] {
  return [...(xs ?? []), x].slice(-HISTORY_KEEP)
}

export type AgentEstimate = {
  elapsedMs: number
  // Absent when there is nothing yet to compare against.
  remainingMs?: number
  fraction?: number
  isOverrun: boolean
  usd: number
  projectedUsd?: number
}

export function estimateAgent(
  agent: AgentRow,
  history: History,
  now: number,
  factor: number,
): AgentEstimate {
  const elapsedMs = Math.max(0, (agent.endedAt ?? now) - agent.startedAt)
  const usd = agent.listUsd * factor
  if (agent.state !== 'running') {
    return { elapsedMs, isOverrun: false, usd, fraction: agent.state === 'done' ? 1 : undefined }
  }

  const ofType = history.agentMs[agent.type] ?? []
  const anyType = Object.values(history.agentMs).flat()
  const expected = median(ofType.length > 0 ? ofType : anyType)
  const expectedUsd = median(history.agentUsd[agent.type] ?? Object.values(history.agentUsd).flat())
  if (expected === undefined) return { elapsedMs, isOverrun: false, usd }

  const isOverrun = elapsedMs >= expected
  // Past the usual time, assume a quarter as long again: honest, never zero.
  const remainingMs = isOverrun ? Math.max(5_000, elapsedMs * 0.25) : expected - elapsedMs
  const fraction = Math.min(0.97, elapsedMs / (elapsedMs + remainingMs))
  const projectedUsd = expectedUsd === undefined ? undefined : Math.max(usd, usd / Math.max(fraction, 0.05))

  return { elapsedMs, remainingMs, fraction, isOverrun, usd, projectedUsd }
}

export type TaskEstimate = {
  total: number
  done: number
  active: number
  pending: number
  fraction: number
  avgMs?: number
  remainingMs?: number
  avgUsd?: number
  remainingUsd?: number
}

export function estimateTasks(tasks: readonly TaskRow[], history: History, now: number): TaskEstimate {
  const done = tasks.filter(t => t.state === 'completed')
  const active = tasks.filter(t => t.state === 'in_progress')
  const pending = tasks.filter(t => t.state === 'pending')
  const total = tasks.length
  const fraction = total === 0 ? 0 : (done.length + active.length * 0.5) / total

  // Throughput over this session beats per-task timings: it counts the gaps.
  const starts = tasks.map(t => t.startedAt ?? t.createdAt)
  const ends = done.map(t => t.completedAt ?? now)
  const sessionAvg =
    done.length > 0 ? (Math.max(...ends) - Math.min(...starts)) / done.length : undefined
  const avgMs = sessionAvg !== undefined && done.length >= 2 ? sessionAvg : (median(history.taskMs) ?? sessionAvg)

  const costs = done.map(t => t.usd).filter((u): u is number => u !== undefined)
  const avgUsd =
    costs.length > 0 ? costs.reduce((a, b) => a + b, 0) / costs.length : median(history.taskUsd)

  const left = pending.length + active.length
  let remainingMs: number | undefined
  if (avgMs !== undefined && left > 0) {
    const activeCredit = active.reduce(
      (sum, t) => sum + Math.min(avgMs * 0.9, now - (t.startedAt ?? now)),
      0,
    )
    remainingMs = Math.max(0, left * avgMs - activeCredit)
  }

  return {
    total,
    done: done.length,
    active: active.length,
    pending: pending.length,
    fraction,
    avgMs,
    remainingMs,
    avgUsd,
    remainingUsd: avgUsd === undefined ? undefined : avgUsd * (pending.length + active.length * 0.5),
  }
}

// Dollars per minute over the trailing window.
export function burnRate(samples: readonly SpendSample[], now: number, windowMs = 5 * 60_000): number | undefined {
  const recent = samples.filter(s => s.t >= now - windowMs)
  if (recent.length < 2) return undefined
  const first = recent[0]
  const last = recent[recent.length - 1]
  if (first === undefined || last === undefined) return undefined
  const minutes = (last.t - first.t) / 60_000
  if (minutes < 0.25) return undefined

  return Math.max(0, (last.usd - first.usd) / minutes)
}

// Spend in each of `buckets` equal slices of the trailing window.
export function spendBuckets(
  samples: readonly SpendSample[],
  now: number,
  buckets: number,
  windowMs = 15 * 60_000,
): number[] {
  const out = new Array<number>(buckets).fill(0)
  const size = windowMs / buckets
  samples.forEach((sample, i) => {
    const before = samples[i - 1]
    const age = now - sample.t
    if (before === undefined || age > windowMs || age < 0) return
    const slot = Math.min(buckets - 1, Math.floor((windowMs - age) / size))
    out[slot] = (out[slot] ?? 0) + Math.max(0, sample.usd - before.usd)
  })

  return out
}

export function sparkline(values: readonly number[]): string {
  const ticks = '▁▂▃▄▅▆▇█'
  const max = Math.max(...values, 0)
  if (max <= 0) return '▁'.repeat(values.length)

  return values.map(v => ticks[Math.min(7, Math.round((v / max) * 7))]).join('')
}

// A bar in eighths of a cell: the filled part and the track, apart, to colour.
export function bar(fraction: number, width: number): { filled: string; track: string } {
  const cells = Math.max(1, width)
  const eighths = Math.round(Math.min(1, Math.max(0, fraction)) * cells * 8)
  const whole = Math.floor(eighths / 8)
  const part = eighths % 8
  const partial = part === 0 ? '' : ' ▏▎▍▌▋▊▉'[part]
  const used = whole + (partial === '' ? 0 : 1)

  return { filled: '█'.repeat(whole) + partial, track: '░'.repeat(Math.max(0, cells - used)) }
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)

  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function usd(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return '—'
  if (x > 0 && x < 0.01) return '<$0.01'
  if (x >= 100) return `$${x.toFixed(0)}`

  return `$${x.toFixed(2)}`
}

export function shortModel(model: string | undefined): string | undefined {
  return model?.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

export function clip(text: string, width: number): string {
  if (width <= 1) return ''
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length <= width ? one : one.slice(0, width - 1) + '…'
}

export type Summary = {
  now: number
  factor: number
  running: AgentRow[]
  finished: AgentRow[]
  agentEstimates: Map<string, AgentEstimate>
  tasks: TaskEstimate
  spentUsd?: number
  burnPerMin?: number
  etaMs?: number
  projectedUsd?: number
  // Whole progress, 0 to 1: tasks where there are some, else running agents.
  fraction?: number
  sinceMs?: number
}

export function summarize(
  agents: readonly AgentRow[],
  tasks: readonly TaskRow[],
  meter: Meter,
  history: History,
): Summary {
  const now = meter.now
  const factor = calibration(meter, agents)
  const shown = agents.filter(a => !a.isMain)
  const running = shown.filter(a => a.state === 'running')
  const finished = shown.filter(a => a.state !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  const agentEstimates = new Map(shown.map(a => [a.id, estimateAgent(a, history, now, factor)]))
  const taskEstimate = estimateTasks(tasks, history, now)

  const agentRemaining = running.map(a => agentEstimates.get(a.id)?.remainingMs)
  const agentEta = agentRemaining.every(r => r !== undefined) && agentRemaining.length > 0
    ? Math.max(...(agentRemaining as number[]))
    : undefined
  const etas = [taskEstimate.remainingMs, agentEta].filter((x): x is number => x !== undefined)
  const etaMs = etas.length > 0 ? Math.max(...etas) : undefined

  const agentExtra = running.reduce((sum, a) => {
    const est = agentEstimates.get(a.id)

    return sum + Math.max(0, (est?.projectedUsd ?? est?.usd ?? 0) - (est?.usd ?? 0))
  }, 0)
  // Agents usually serve the tasks, so take the larger, never the sum.
  const extra = Math.max(taskEstimate.remainingUsd ?? 0, agentExtra)
  const projectedUsd = meter.usd === undefined ? undefined : meter.usd + extra

  let fraction: number | undefined
  if (taskEstimate.total > 0) {
    fraction = taskEstimate.fraction
  } else if (running.length > 0 || finished.length > 0) {
    const parts = shown.map(a => agentEstimates.get(a.id)?.fraction ?? (a.state === 'running' ? 0.1 : 1))
    fraction = parts.reduce((x, y) => x + y, 0) / parts.length
  }

  const starts = [...shown.map(a => a.startedAt), ...tasks.map(t => t.createdAt)]

  return {
    now,
    factor,
    running,
    finished,
    agentEstimates,
    tasks: taskEstimate,
    spentUsd: meter.usd,
    burnPerMin: burnRate(meter.samples, now),
    etaMs,
    projectedUsd,
    fraction,
    sinceMs: starts.length > 0 ? now - Math.min(...starts) : undefined,
  }
}

// Moves a task to `state`, stamping when it started or finished and what it
// cost; `finished` is set when this move completed it.
export function moveTask(
  row: TaskRow,
  state: TaskRow['state'],
  now: number,
  usdNow: number | undefined,
): { row: TaskRow; finished?: { ms?: number; usd?: number } } {
  if (row.state === state) return { row }
  if (state === 'in_progress') {
    return { row: { ...row, state, startedAt: row.startedAt ?? now, usdAtStart: row.usdAtStart ?? usdNow } }
  }
  if (state === 'completed') {
    const spent =
      usdNow !== undefined && row.usdAtStart !== undefined ? Math.max(0, usdNow - row.usdAtStart) : undefined
    const ms = row.startedAt === undefined ? undefined : now - row.startedAt

    return { row: { ...row, state, completedAt: now, usd: spent }, finished: { ms, usd: spent } }
  }

  return { row: { ...row, state, completedAt: undefined } }
}

export function isHistory(x: unknown): x is History {
  if (typeof x !== 'object' || x === null) return false
  const h = x as Record<string, unknown>

  return (
    typeof h.agentMs === 'object' &&
    typeof h.agentUsd === 'object' &&
    Array.isArray(h.taskMs) &&
    Array.isArray(h.taskUsd)
  )
}
