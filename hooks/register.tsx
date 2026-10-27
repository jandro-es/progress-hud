import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentState, History, Meter, ShellRow, TaskRow, Tokens } from '../types'
import {
  EMPTY_HISTORY,
  ZERO_TOKENS,
  addTokens,
  bar,
  calibration,
  clip,
  duration,
  isHistory,
  listUsd,
  moveTask,
  plain,
  remember,
  shortModel,
  sparkline,
  spendBuckets,
  summarize,
  usd,
} from './estimate'
import type { Summary } from './estimate'
import { ACCENT, BAD, GOOD, WARN, area, meterBar, ring } from './svg'
import {
  DEFAULT_TIMEOUT_MS,
  commandKey,
  countLines,
  isLive,
  lastLine,
  outputPathIn,
  parseNotice,
  shellEta,
  stateFromNotice,
  trimShells,
} from './shells'
import { richShells, terminalShells } from './shells-view'

const PANE = 'progress-hud'
const TITLE = 'Progress'
const STORE_KEY = 'history'
const SAMPLE_EVERY_MS = 10_000
const SAMPLES_KEEP_MS = 60 * 60_000

const agents = atom({ plugin: 'progress-hud', key: 'agents' } as const, [], { shape: 'agents-1' })
const tasks = atom({ plugin: 'progress-hud', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const meter = atom({ plugin: 'progress-hud', key: 'meter' } as const, { now: 0, rateLimits: [], samples: [] }, {
  shape: 'meter-1',
})
const history = atom({ plugin: 'progress-hud', key: 'history' } as const, EMPTY_HISTORY, { shape: 'history-1' })
const shells = atom({ plugin: 'progress-hud', key: 'shells' } as const, [], { shape: 'shells-1' })
const hasAutoOpened = atom({ plugin: 'progress-hud', key: 'hasAutoOpened' } as const, false)

const LIVE: readonly string[] = ['pending', 'running', 'waiting']

function stateOf(status: string): AgentState {
  if (LIVE.includes(status)) return 'running'
  if (status === 'idle') return 'idle'
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'stopped'

  return 'done'
}

function tokensOf(u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): Tokens {
  return {
    input: u.input_tokens,
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens,
    cacheWrite: u.cache_creation_input_tokens,
  }
}

function newAgent(id: string | undefined, now: number): AgentRow {
  return {
    id: id ?? 'main',
    label: id === undefined ? 'Main thread' : `agent ${id.slice(0, 6)}`,
    type: id === undefined ? 'main' : 'workflow',
    state: 'running',
    startedAt: now,
    steps: 0,
    tokens: ZERO_TOKENS,
    listUsd: 0,
    isMain: id === undefined,
  }
}

function withAgent(list: readonly AgentRow[], id: string | undefined, now: number, fn: (a: AgentRow) => AgentRow) {
  const key = id ?? 'main'
  const found = list.find(a => a.id === key)

  return found === undefined ? [...list, fn(newAgent(id, now))] : list.map(a => (a.id === key ? fn(a) : a))
}

async function remembered($: EngineInterface, fn: (h: History) => History) {
  const next = await update($, history, fn)
  void $.store.set(STORE_KEY, next)
}

async function recordAgentsDone($: EngineInterface, done: readonly AgentRow[]) {
  if (done.length === 0) return
  const factor = calibration(await read($, meter), await read($, agents))
  await remembered($, h => {
    const agentMs = { ...h.agentMs }
    const agentUsd = { ...h.agentUsd }
    for (const a of done) {
      agentMs[a.type] = remember(agentMs[a.type], (a.endedAt ?? a.startedAt) - a.startedAt)
      agentUsd[a.type] = remember(agentUsd[a.type], a.listUsd * factor)
    }

    return { ...h, agentMs, agentUsd }
  })
}

async function recordTasksDone($: EngineInterface, done: readonly { ms?: number; usd?: number }[]) {
  if (done.length === 0) return
  await remembered($, h => {
    let { taskMs, taskUsd } = h
    for (const d of done) {
      if (d.ms !== undefined) taskMs = remember(taskMs, d.ms)
      if (d.usd !== undefined) taskUsd = remember(taskUsd, d.usd)
    }

    return { ...h, taskMs, taskUsd }
  })
}

// Applies task moves found by `plan`, then files what finished in history.
async function moveTasks(
  $: EngineInterface,
  plan: (list: readonly TaskRow[], now: number, usdNow: number | undefined) => TaskRow[],
) {
  const now = await $.clock.now()
  const usdNow = (await read($, meter)).usd
  let finished: { ms?: number; usd?: number }[] = []
  await update($, tasks, list => {
    finished = []
    const before = new Map(list.map(t => [t.id, t]))

    return plan(list, now, usdNow).map(t => {
      // A task that arrives already started or done is stamped as if it had been pending.
      const was = before.get(t.id) ?? (t.state === 'pending' ? undefined : { ...t, state: 'pending' as const })
      if (was === undefined || was.state === t.state) return t
      const moved = moveTask(was, t.state, now, usdNow)
      if (moved.finished !== undefined && !t.id.startsWith(DEMO_PREFIX)) finished.push(moved.finished)

      return { ...moved.row, subject: t.subject, activeForm: t.activeForm }
    })
  })
  await recordTasksDone($, finished)
  await openOnce($)
}

const DEMO_PREFIX = 'demo:'
const DEMO_TASKS = [
  { subject: 'Survey the docs folder', activeForm: 'Surveying the docs folder', ms: 5_000 },
  { subject: 'Check the open issues', activeForm: 'Checking the open issues', ms: 8_000 },
  { subject: 'Draft the findings', activeForm: 'Drafting the findings', ms: 6_000 },
  { subject: 'Review and wrap up', activeForm: 'Reviewing and wrapping up', ms: 7_000 },
] as const

// Walks sample tasks through the pane on a timer. Their timings never enter
// the history the estimates learn from.
async function startDemo($: EngineInterface) {
  const now = await $.clock.now()
  await update($, tasks, list => [
    ...list.filter(t => !t.id.startsWith(DEMO_PREFIX)),
    ...DEMO_TASKS.map(
      (d, i): TaskRow => ({
        id: `${DEMO_PREFIX}${i}`,
        subject: `Demo: ${d.subject}`,
        activeForm: `Demo: ${d.activeForm}`,
        state: 'pending',
        source: 'task',
        createdAt: now,
      }),
    ),
  ])
  let at = 500
  DEMO_TASKS.forEach((d, i) => {
    $.clock.after(at, () => void demoStep($, i, 'in_progress'))
    at += d.ms
    $.clock.after(at, () => void demoStep($, i, 'completed'))
  })
}

async function demoStep($: EngineInterface, index: number, state: TaskRow['state']) {
  await moveTasks($, list => list.map(t => (t.id === `${DEMO_PREFIX}${index}` ? { ...t, state } : t)))
}

async function clearFinished($: EngineInterface) {
  await update($, agents, list => list.filter(a => a.isMain || a.state === 'running' || a.state === 'idle'))
  await update($, tasks, list => list.filter(t => t.state !== 'completed'))
  await update($, shells, list => list.filter(isLive))
}

async function openOnce($: EngineInterface) {
  if (await read($, hasAutoOpened)) return
  await update($, hasAutoOpened, () => true)
  void $.ui.open({ id: PANE, title: TITLE })
}

function appendSample(m: Meter, now: number, spent: number | undefined) {
  if (spent === undefined) return m.samples
  const last = m.samples[m.samples.length - 1]
  const isDue = last === undefined || now - last.t >= SAMPLE_EVERY_MS
  if (!isDue) return m.samples

  return [...m.samples.filter(s => now - s.t <= SAMPLES_KEEP_MS), { t: now, usd: spent }]
}

type BashResult = {
  stdout?: string
  stderr?: string
  interrupted?: boolean
  backgroundTaskId?: string
  backgroundOutputPath?: string
  backgroundedByUser?: boolean
  timedOutAfterMs?: number
}

type Ran = { deny?: string; result?: unknown; text?: string; isError?: boolean }

async function recordShellDone($: EngineInterface, row: ShellRow) {
  if (row.endedAt === undefined || row.kind !== 'shell') return
  const ms = row.endedAt - row.startedAt
  await remembered($, h => ({ ...h, shellMs: { ...h.shellMs, [row.key]: remember(h.shellMs?.[row.key], ms) } }))
}

// What became of a Bash call: finished, or moved to the background.
async function settleBash($: EngineInterface, id: string, ran: Ran) {
  if (ran.deny !== undefined) {
    await update($, shells, list => list.filter(s => s.id !== id))

    return
  }
  const now = await $.clock.now()
  const r = (ran.result ?? {}) as BashResult
  let done: ShellRow | undefined
  await update($, shells, list => {
    done = undefined

    return list.map(s => {
      if (s.id !== id) return s
      if (r.backgroundTaskId !== undefined) {
        const how = r.backgroundedByUser ? 'user' : r.timedOutAfterMs !== undefined ? 'timeout' : 'model'

        return {
          ...s,
          state: 'background' as const,
          taskId: r.backgroundTaskId,
          limitMs: undefined,
          backgroundedBy: s.backgroundedBy ?? how,
          outputPath: r.backgroundOutputPath ?? outputPathIn(ran.text),
        }
      }
      const out = r.stdout ?? ''
      const err = r.stderr ?? ''
      const code = ran.text?.match(/exit code[:\s]+(-?\d+)/i)?.[1]
      const exitCode = code !== undefined ? Number(code) : ran.isError ? undefined : 0
      const state = r.interrupted ? 'killed' : ran.isError || (exitCode ?? 0) !== 0 ? 'failed' : 'done'
      const settled: ShellRow = {
        ...s,
        state,
        endedAt: now,
        exitCode,
        outputLines: countLines(out) + countLines(err),
        lastLine: lastLine(out) ?? lastLine(err) ?? (ran.isError ? lastLine(ran.text ?? '') : undefined),
        hasStderr: err.trim() !== '',
      }
      done = settled

      return settled
    })
  })
  const row = done as ShellRow | undefined
  if (row?.state === 'done') await recordShellDone($, row)
  if (r.backgroundTaskId !== undefined) await openOnce($)
}

// A background task's notification: a shell or monitor that ended, or a monitor's event.
async function noticeShell($: EngineInterface, text: string) {
  const notice = parseNotice(text)
  if (notice === undefined) return
  const now = await $.clock.now()
  let done: ShellRow | undefined
  await update($, shells, list => {
    done = undefined

    return list.map(s => {
      if (s.taskId !== notice.taskId || !isLive(s)) return s
      const state = stateFromNotice(notice.status, notice.exitCode)
      if (state === undefined) {
        const said = lastLine(notice.summary ?? text.replace(/<[^>]+>/g, ' '))

        return { ...s, events: (s.events ?? 0) + 1, lastLine: said ?? s.lastLine }
      }
      const ended: ShellRow = {
        ...s,
        state,
        endedAt: now,
        exitCode: notice.exitCode ?? s.exitCode,
        outputPath: s.outputPath ?? notice.outputPath,
      }
      done = ended

      return ended
    })
  })
  const row = done as ShellRow | undefined
  if (row === undefined) return
  if (row.state === 'done') await recordShellDone($, row)
  await measureOutput($, row.id, now)
}

// The size, line count, rate and last line of a background task's output file.
async function measureOutput($: EngineInterface, id: string, now: number) {
  const row = (await read($, shells)).find(s => s.id === id)
  const path = row?.outputPath
  if (row === undefined || path === undefined) return
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (stat === undefined || stat.kind !== 'file' || stat.size === row.outputBytes) return
  const tail = await $.process.run(['tail', '-c', '4096', path], { timeoutMs: 2_000 }).catch(() => undefined)
  // Counting lines reads the whole file: skip it for very large output.
  const wc =
    stat.size <= 64 * 1024 * 1024
      ? await $.process.run(['wc', '-l', path], { timeoutMs: 2_000 }).catch(() => undefined)
      : undefined
  const counted = wc === undefined ? undefined : Number(wc.stdout.trim().split(/\s+/)[0])
  const lines = counted !== undefined && Number.isFinite(counted) ? counted : undefined
  await update($, shells, list =>
    list.map(s => {
      if (s.id !== id) return s
      let linesPerSec = s.linesPerSec
      if (lines !== undefined && s.outputLines !== undefined && s.sampledAt !== undefined && now > s.sampledAt) {
        const rate = Math.max(0, (lines - s.outputLines) / ((now - s.sampledAt) / 1000))
        linesPerSec = s.linesPerSec === undefined ? rate : s.linesPerSec * 0.5 + rate * 0.5
      }

      return {
        ...s,
        outputBytes: stat.size,
        outputLines: lines ?? s.outputLines,
        events: s.kind === 'monitor' ? (lines ?? s.events) : s.events,
        linesPerSec,
        sampledAt: now,
        lastLine: (tail === undefined ? undefined : lastLine(tail.stdout)) ?? s.lastLine,
      }
    }),
  )
}

function statusLine(s: Summary, shellRows: readonly ShellRow[], past: History): string | undefined {
  const left = s.tasks.pending + s.tasks.active
  const liveShells = shellRows.filter(isLive)
  if (s.running.length === 0 && left === 0 && liveShells.length === 0) return undefined
  const parts: string[] = []
  if (s.fraction !== undefined) {
    const b = bar(s.fraction, 8)
    parts.push(`${b.filled}${b.track} ${Math.round(s.fraction * 100)}%`)
  }
  if (s.tasks.total > 0) parts.push(`${s.tasks.done}/${s.tasks.total} tasks`)
  if (s.running.length > 0) parts.push(`${s.running.length} agent${s.running.length === 1 ? '' : 's'}`)
  if (liveShells.length > 0) parts.push(`${liveShells.length} shell${liveShells.length === 1 ? '' : 's'}`)
  if (s.spentUsd !== undefined) parts.push(usd(s.spentUsd))
  const eta = latest(s.etaMs, shellEta(shellRows, past, s.now))
  if (eta !== undefined) parts.push(`ETA ~${duration(eta)}`)

  return `◆ ${parts.join(' · ')}`
}

function latest(...xs: (number | undefined)[]): number | undefined {
  const known = xs.filter((x): x is number => x !== undefined)

  return known.length === 0 ? undefined : Math.max(...known)
}

let ticks = 0
let lastStatus: string | undefined

async function tick($: EngineInterface) {
  ticks += 1
  const now = await $.clock.now()
  const listed = await $.agent.list()
  const rows = await read($, agents)
  const taskRows = await read($, tasks)
  const shellRows = await read($, shells)
  const isBusy =
    listed.some(a => LIVE.includes(a.status)) ||
    rows.some(a => a.state === 'running' && !a.isMain) ||
    taskRows.some(t => t.state === 'in_progress') ||
    shellRows.some(isLive)
  // Idle: look in every five seconds; busy: every second, so clocks move.
  if (!isBusy && ticks % 5 !== 0) return

  let ended: AgentRow[] = []
  await update($, agents, list => {
    ended = []
    const byId = new Map(listed.map(a => [a.id, a]))
    const known = new Set(list.map(a => a.id))
    const kept = list.map(row => {
      const info = byId.get(row.id)
      if (info === undefined) {
        // A listed agent that left the list has ended.
        if (row.isListed && row.state === 'running') return { ...row, state: 'done' as const, endedAt: now }

        return row
      }
      const state = stateOf(info.status)
      const next: AgentRow = {
        ...row,
        label: plain(info.description || info.name || row.label),
        type: plain(info.type),
        isListed: true,
        state,
        endedAt: state === 'running' ? undefined : (row.endedAt ?? now),
      }
      if (row.state === 'running' && state === 'done') ended.push(next)

      return next
    })
    const added = listed
      .filter(a => !known.has(a.id))
      .map(a => ({
        ...newAgent(a.id, now),
        label: plain(a.description || a.name || a.type),
        type: plain(a.type),
        isListed: true,
        state: stateOf(a.status),
      }))

    return [...kept, ...added]
  })
  await recordAgentsDone($, ended)

  if (ticks % 2 === 0) {
    for (const s of shellRows.filter(r => r.state === 'background' && r.outputPath !== undefined).slice(0, 8)) {
      await measureOutput($, s.id, now)
    }
  }

  const usage = await $.session.usage()
  const m = await update($, meter, old => {
    const spent = usage.cost?.usd

    return {
      now,
      usd: spent,
      baseUsd: old.baseUsd ?? spent,
      contextPercent: usage.context.percent,
      rateLimits: usage.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
      samples: appendSample(old, now, spent),
    }
  })

  const all = await read($, agents)
  if (all.some(a => !a.isMain)) await openOnce($)
  const past = await read($, history)
  const text = statusLine(summarize(all, await read($, tasks), m, past), await read($, shells), past)
  if (text !== lastStatus) {
    lastStatus = text
    $.ui.status(text)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Show or hide the progress pane for subagents, shells and tasks',
      argumentHint: '[clear|demo]',
    })
    const stored = await $.store.get(STORE_KEY)
    if (isHistory(stored)) await update($, history, () => stored)
    $.clock.every(1000, () => void tick($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, agents, () => [])
      await update($, tasks, () => [])
      await update($, shells, () => [])
      await update($, meter, () => ({ now: 0, rateLimits: [], samples: [] }))
      $.ui.status(undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await clearFinished($)

      return { text: 'Cleared finished agents, shells and tasks from the progress pane.' }
    }
    if (e.args.trim() === 'demo') {
      await startDemo($)
      await $.ui.open({ id: PANE, title: TITLE })

      return { text: 'Walking four demo tasks through the progress pane, about 30 s. /progress clear removes them.' }
    }
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isShown) {
      await $.ui.close({ id: PANE })

      return { text: 'Progress pane closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return { text: opened.isPlaced ? 'Progress pane opened.' : `Progress pane waiting: ${opened.reason}` }
  }).catch(() => ({ text: 'Could not toggle the progress pane.' }))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const now = await $.clock.now()
      await update($, agents, list =>
        withAgent(list, e.agentId, now, a =>
          a.state === 'idle' ? { ...a, state: 'running', startedAt: now, endedAt: undefined } : a,
        ),
      )
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const used = result?.usage
    if (used) {
      const now = await $.clock.now()
      const tokens = tokensOf(used)
      await update($, agents, list =>
        withAgent(list, e.agentId, now, a => ({
          ...a,
          model: plain(used.model),
          steps: a.steps + 1,
          tokens: addTokens(a.tokens, tokens),
          listUsd: a.listUsd + listUsd(used.model, tokens),
        })),
      )
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      const now = await $.clock.now()
      let ended: AgentRow[] = []
      await update($, agents, list => {
        ended = []

        return list.map(a => {
          // Listed agents follow the engine's list; the rest end with their turn.
          if (a.id !== e.agentId || a.isListed || a.state !== 'running') return a
          const done: AgentRow = { ...a, state: e.isAborted ? 'stopped' : 'done', endedAt: now }
          if (!e.isAborted) ended.push(done)

          return done
        })
      })
      await recordAgentsDone($, ended)
    }

    return result
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const made = (ran.result as { task?: { id?: string; subject?: string } } | undefined)?.task
    if (ran.deny === undefined && !ran.isError && made?.id !== undefined) {
      const now = await $.clock.now()
      const row: TaskRow = {
        id: made.id,
        subject: plain(made.subject ?? e.subject),
        activeForm: e.activeForm === undefined ? undefined : plain(e.activeForm),
        state: 'pending',
        source: 'task',
        createdAt: now,
      }
      await update($, tasks, list => [...list.filter(t => t.id !== row.id), row])
      await openOnce($)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    const ok = ran.deny === undefined && !ran.isError && (ran.result as { success?: boolean } | undefined)?.success !== false
    if (ok) {
      const status = e.status === 'deleted' ? undefined : e.status
      await moveTasks($, list => {
        if (e.status === 'deleted') return list.filter(t => t.id !== e.taskId)

        return list.map(t =>
          t.id === e.taskId
            ? {
                ...t,
                subject: e.subject === undefined ? t.subject : plain(e.subject),
                activeForm: e.activeForm === undefined ? t.activeForm : plain(e.activeForm),
                state: status ?? t.state,
              }
            : t,
        )
      })
    }

    return ran
  })

  on('tool.call', { tool: 'TaskList' }, async ($, e, next) => {
    const ran = await next(e)
    const listed = (ran.result as { tasks?: { id: string; subject: string; status: TaskRow['state'] }[] } | undefined)
      ?.tasks
    if (ran.deny === undefined && !ran.isError && listed !== undefined) {
      await moveTasks($, (list, now) => {
        const byId = new Map(list.map(t => [t.id, t]))
        const fromList = listed.map(
          (t): TaskRow => ({
            ...(byId.get(t.id) ?? { id: t.id, source: 'task' as const, createdAt: now, state: t.status }),
            subject: plain(t.subject),
            state: t.status,
          }),
        )

        return [...list.filter(t => t.source === 'todo'), ...fromList]
      })
    }

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    // A subagent's to-do list is its own; the pane follows the main thread's.
    if (ran.deny === undefined && !ran.isError && e.agentId === undefined) {
      await moveTasks($, (list, now) => {
        const byId = new Map(list.map(t => [t.id, t]))
        const todos = e.todos.map(
          (todo): TaskRow => ({
            ...(byId.get(`todo:${todo.content}`) ?? {
              id: `todo:${todo.content}`,
              source: 'todo' as const,
              createdAt: now,
              state: 'pending' as const,
            }),
            subject: plain(todo.content),
            activeForm: plain(todo.activeForm),
            state: todo.status,
          }),
        )
        return [...list.filter(t => t.source === 'task'), ...todos]
      })
    }

    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id ?? `bash:${crypto.randomUUID()}`
    const isBackground = e.run_in_background === true
    const row: ShellRow = {
      id,
      kind: 'shell',
      command: plain(e.command),
      description: e.description === undefined ? undefined : plain(e.description),
      key: commandKey(plain(e.command)),
      agentId: e.agentId,
      state: isBackground ? 'background' : 'running',
      startedAt: await $.clock.now(),
      limitMs: isBackground ? undefined : Math.min(600_000, e.timeout ?? DEFAULT_TIMEOUT_MS),
      backgroundedBy: isBackground ? 'model' : undefined,
    }
    await update($, shells, list => trimShells([...list.filter(s => s.id !== id), row]))
    const ran = await next(e)
    await settleBash($, id, ran)

    return ran
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    const r = ran.result as { taskId?: string; timeoutMs?: number; persistent?: boolean } | undefined
    if (ran.deny === undefined && !ran.isError && r?.taskId !== undefined) {
      const taskId = r.taskId
      const row: ShellRow = {
        id: `monitor:${taskId}`,
        taskId,
        kind: 'monitor',
        command: plain(e.command ?? e.ws?.url ?? 'monitor'),
        description: plain(e.description),
        key: 'monitor',
        agentId: e.agentId,
        state: 'background',
        startedAt: await $.clock.now(),
        limitMs: r.persistent || !r.timeoutMs ? undefined : r.timeoutMs,
        events: 0,
        outputPath: outputPathIn(ran.text),
      }
      await update($, shells, list => trimShells([...list.filter(s => s.id !== row.id), row]))
      await openOnce($)
    }

    return ran
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const target = e.task_id ?? e.shell_id
    if (ran.deny === undefined && !ran.isError && target !== undefined) {
      const now = await $.clock.now()
      await update($, shells, list =>
        list.map(s => (s.taskId === target && isLive(s) ? { ...s, state: 'killed' as const, endedAt: now } : s)),
      )
    }

    return ran
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if ((e.origin as { kind?: string }).kind === 'task-notification') {
      const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
      await noticeShell($, text)
    }

    return stored
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const past = await read($, history)
    const agentRows = await read($, agents)
    const shellRows = await read($, shells)
    const base = summarize(agentRows, await read($, tasks), await read($, meter), past)
    const s = { ...base, etaMs: latest(base.etaMs, shellEta(shellRows, past, base.now)) }
    const label = (id: string | undefined) =>
      id === undefined ? undefined : (agentRows.find(a => a.id === id)?.type ?? 'a subagent')
    const m = await read($, meter)
    const taskRows = await read($, tasks)
    const width = Math.max(24, e.props.bodyColumns)

    if (e.surface === 'terminal') {
      const table = $.ui.resolve(e)
      const { Box, Text, Button } = table
      const spin = '◐◓◑◒'[Math.floor(s.now / 500) % 4]
      const barWidth = Math.min(32, width - 8)
      const whole = bar(s.fraction ?? 0, barWidth)
      const ctx = m.contextPercent
      const ctxColor = ctx === undefined || ctx < 60 ? 'success' : ctx < 85 ? 'warning' : 'error'
      const ctxBar = bar((ctx ?? 0) / 100, 10)
      const sparkWidth = Math.min(30, width - 16)
      const ordered = [
        ...taskRows.filter(t => t.state === 'in_progress'),
        ...taskRows.filter(t => t.state === 'pending'),
      ]
      const completed = taskRows.filter(t => t.state === 'completed')
      const recentDone = completed.slice(-3)
      const isEmpty = s.running.length === 0 && s.finished.length === 0 && taskRows.length === 0 && shellRows.length === 0

      return (
        <Box flexDirection="column">
          <Box justifyContent="space-between">
            <Text bold color="claude">
              ◆ {s.running.length > 0 || s.tasks.active > 0 ? 'Working' : isEmpty ? 'Idle' : 'Settled'}
            </Text>
            <Text dimColor>⏱ {duration(s.sinceMs)}</Text>
          </Box>
          {s.fraction !== undefined && (
            <Text>
              <Text color="claude">{whole.filled}</Text>
              <Text color="subtle">{whole.track}</Text>
              <Text bold> {Math.round(s.fraction * 100)}%</Text>
            </Text>
          )}
          <Text wrap="truncate-end">
            <Text dimColor>ETA </Text>
            <Text bold>{s.etaMs === undefined ? '—' : `~${duration(s.etaMs)}`}</Text>
            <Text dimColor> · spent </Text>
            <Text bold>{usd(s.spentUsd)}</Text>
            <Text dimColor> → </Text>
            <Text>≈{usd(s.projectedUsd)}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text color="claude">{sparkline(spendBuckets(m.samples, s.now, sparkWidth))}</Text>
            <Text dimColor> {s.burnPerMin === undefined ? '' : `${usd(s.burnPerMin)}/min`}</Text>
          </Text>
          <Text wrap="truncate-end">
            <Text dimColor>ctx </Text>
            <Text color={ctxColor}>{ctxBar.filled}</Text>
            <Text color="subtle">{ctxBar.track}</Text>
            <Text dimColor> {ctx === undefined ? '—' : `${ctx}%`}</Text>
            {m.rateLimits.map(r => (
              <Text dimColor>
                {' · '}
                {r.kind.replace('_hour', 'h').replace('seven_day', '7d').replace('five', '5')} {r.percentUsed}%
              </Text>
            ))}
          </Text>

          {isEmpty && (
            <Box marginTop={1}>
              <Text dimColor>Subagents, shells and tasks show here as they start.</Text>
            </Box>
          )}

          {(s.running.length > 0 || s.finished.length > 0) && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>
                AGENTS{' '}
                <Text dimColor>
                  {s.running.length} running · {s.finished.length} finished
                </Text>
              </Text>
              {s.running.map(a => {
                const est = s.agentEstimates.get(a.id)
                const b = bar(est?.fraction ?? 0, Math.min(16, width - 30))

                return (
                  <Box flexDirection="column">
                    <Text wrap="truncate-end">
                      <Text color="claude">{spin}</Text> <Text bold>{a.type}</Text>{' '}
                      <Text>{clip(a.label, width - a.type.length - 4)}</Text>
                    </Text>
                    <Text wrap="truncate-end">
                      {'  '}
                      <Text color={est?.isOverrun ? 'warning' : 'claude'}>{b.filled}</Text>
                      <Text color="subtle">{b.track}</Text>
                      <Text dimColor>
                        {' '}
                        {duration(est?.elapsedMs)}
                        {est?.remainingMs === undefined ? '' : ` · ~${duration(est.remainingMs)} left`} ·{' '}
                        {usd(est?.usd)}
                      </Text>
                    </Text>
                  </Box>
                )
              })}
              {s.finished.slice(0, 4).map(a => {
                const est = s.agentEstimates.get(a.id)
                const isGood = a.state === 'done' || a.state === 'idle'

                return (
                  <Text wrap="truncate-end">
                    <Text color={isGood ? 'success' : 'error'}>{a.state === 'idle' ? '◇' : isGood ? '✓' : '✗'}</Text>{' '}
                    <Text dimColor>
                      {a.type} {clip(a.label, width - 26)} · {duration(est?.elapsedMs)} · {usd(est?.usd)}
                    </Text>
                  </Text>
                )
              })}
              {s.finished.length > 4 && <Text dimColor>  + {s.finished.length - 4} more</Text>}
            </Box>
          )}

          {terminalShells(table, shellRows, past, s.now, width, label)}

          {taskRows.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>
                TASKS{' '}
                <Text dimColor>
                  {s.tasks.done}/{s.tasks.total} done
                  {s.tasks.avgMs === undefined ? '' : ` · ~${duration(s.tasks.avgMs)} each`}
                  {s.tasks.avgUsd === undefined ? '' : ` · ~${usd(s.tasks.avgUsd)} each`}
                </Text>
              </Text>
              {completed.length > recentDone.length && (
                <Text dimColor>✓ {completed.length - recentDone.length} earlier done</Text>
              )}
              {recentDone.map(t => (
                <Text wrap="truncate-end">
                  <Text color="success">✓</Text>{' '}
                  <Text dimColor>
                    {clip(t.subject, width - 12)}
                    {t.startedAt !== undefined && t.completedAt !== undefined
                      ? ` · ${duration(t.completedAt - t.startedAt)}`
                      : ''}
                  </Text>
                </Text>
              ))}
              {ordered.map(t =>
                t.state === 'in_progress' ? (
                  <Text wrap="truncate-end">
                    <Text color="claude">{spin}</Text> <Text bold>{clip(t.activeForm || t.subject, width - 12)}</Text>
                    <Text dimColor> {duration(s.now - (t.startedAt ?? s.now))}</Text>
                  </Text>
                ) : (
                  <Text wrap="truncate-end">
                    <Text color="subtle">○</Text> <Text>{clip(t.subject, width - 3)}</Text>
                  </Text>
                ),
              )}
            </Box>
          )}

          <Box marginTop={1} justifyContent="space-between">
            <Text dimColor>
              {s.factor === 1 ? 'list prices' : `calibrated ${s.factor.toFixed(2)}×`} · estimates
            </Text>
            {(s.finished.length > 0 || completed.length > 0 || shellRows.some(r => !isLive(r))) && (
              <Button key="clear" plain label="clear finished" onPress={() => void clearFinished($)} />
            )}
          </Box>
        </Box>
      )
    }

    const table = $.ui.resolve(e)
    const { Box, Text, Button, Svg } = table
    const px = 260
    const ctx = m.contextPercent
    const pct = s.fraction === undefined ? undefined : Math.round(s.fraction * 100)
    const isEmpty = s.running.length === 0 && s.finished.length === 0 && taskRows.length === 0 && shellRows.length === 0
    const tile = (label: string, value: string, hint?: string) => (
      <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="round" borderDimColor minWidth={14}>
        <Text size="caption" dimColor>
          {label}
        </Text>
        <Text size="heading" weight="semibold" tabular>
          {value}
        </Text>
        {hint !== undefined && (
          <Text size="footnote" dimColor>
            {hint}
          </Text>
        )}
      </Box>
    )
    const completed = taskRows.filter(t => t.state === 'completed')
    const ordered = [
      ...completed.slice(-3),
      ...taskRows.filter(t => t.state === 'in_progress'),
      ...taskRows.filter(t => t.state === 'pending'),
    ]

    return (
      <Box flexDirection="column" gap={2} padding={1}>
        <Box flexDirection="row" gap={2} alignItems="center">
          <Svg source={ring(s.fraction ?? 0, 72)} alt={`Overall progress ${pct ?? 0}%`} width={72} height={72} />
          <Box flexDirection="column">
            <Text size="title" weight="bold" tabular>
              {pct === undefined ? '—' : `${pct}%`}
            </Text>
            <Text dimColor>
              {s.tasks.total > 0 ? `${s.tasks.done} of ${s.tasks.total} tasks` : 'No tasks yet'} ·{' '}
              {s.running.length} agent{s.running.length === 1 ? '' : 's'} running
            </Text>
            <Text size="footnote" dimColor>
              Elapsed {duration(s.sinceMs)}
            </Text>
          </Box>
        </Box>

        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {tile('ETA', s.etaMs === undefined ? '—' : `~${duration(s.etaMs)}`)}
          {tile('Spent', usd(s.spentUsd), 'this session')}
          {tile('Projected', `≈${usd(s.projectedUsd)}`, 'at finish')}
          {tile('Burn', s.burnPerMin === undefined ? '—' : `${usd(s.burnPerMin)}/m`, 'last 5 min')}
        </Box>

        <Box flexDirection="column" gap={1}>
          <Text size="caption" dimColor>
            Spend, last 15 minutes
          </Text>
          <Svg
            source={area(spendBuckets(m.samples, s.now, 30), px, 40)}
            alt="Spend per half minute over the last 15 minutes"
            width={px}
            height={40}
          />
          <Text size="caption" dimColor>
            Context {ctx === undefined ? '—' : `${ctx}%`}
            {m.rateLimits.map(r => ` · ${r.kind.replace(/_/g, ' ')} ${r.percentUsed}%`).join('')}
          </Text>
          <Svg
            source={meterBar((ctx ?? 0) / 100, px, ctx === undefined || ctx < 60 ? GOOD : ctx < 85 ? WARN : BAD)}
            alt={`Context window ${ctx ?? 0}% used`}
            width={px}
            height={6}
          />
        </Box>

        {isEmpty && <Text dimColor>Subagents, shells and tasks show here as they start.</Text>}

        {(s.running.length > 0 || s.finished.length > 0) && (
          <Box flexDirection="column" gap={1}>
            <Text size="heading" weight="semibold">
              Agents
            </Text>
            {s.running.map(a => {
              const est = s.agentEstimates.get(a.id)

              return (
                <Box flexDirection="column" gap={0}>
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text weight="medium" wrap="truncate-end">
                      <Text color="claude">● </Text>
                      {a.label}
                    </Text>
                    <Text tabular dimColor>
                      {duration(est?.elapsedMs)}
                    </Text>
                  </Box>
                  <Svg
                    source={meterBar(est?.fraction, px, est?.isOverrun ? WARN : ACCENT)}
                    alt={est?.fraction === undefined ? 'No estimate yet' : `${Math.round(est.fraction * 100)}% by time`}
                    width={px}
                    height={6}
                  />
                  <Text size="footnote" dimColor>
                    {a.type}
                    {shortModel(a.model) === undefined ? '' : ` · ${shortModel(a.model)}`} · {a.steps} steps ·{' '}
                    {usd(est?.usd)}
                    {est?.remainingMs === undefined
                      ? ''
                      : est.isOverrun
                        ? ` · running long, ~${duration(est.remainingMs)} more`
                        : ` · ~${duration(est.remainingMs)} left`}
                  </Text>
                </Box>
              )
            })}
            {s.finished.slice(0, 6).map(a => {
              const est = s.agentEstimates.get(a.id)
              const isGood = a.state === 'done' || a.state === 'idle'

              return (
                <Text size="footnote" wrap="truncate-end">
                  <Text color={isGood ? 'success' : 'error'}>{isGood ? '✓ ' : '✗ '}</Text>
                  <Text dimColor>
                    {a.label} · {a.type} · {duration(est?.elapsedMs)} · {usd(est?.usd)}
                  </Text>
                </Text>
              )
            })}
          </Box>
        )}

        {richShells(table, shellRows, past, s.now, px, label)}

        {taskRows.length > 0 && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text size="heading" weight="semibold">
                Tasks
              </Text>
              <Text size="footnote" dimColor>
                {s.tasks.avgMs === undefined ? '' : `~${duration(s.tasks.avgMs)} each`}
                {s.tasks.avgUsd === undefined ? '' : ` · ~${usd(s.tasks.avgUsd)} each`}
              </Text>
            </Box>
            <Svg
              source={meterBar(s.tasks.fraction, px, GOOD)}
              alt={`${s.tasks.done} of ${s.tasks.total} tasks done`}
              width={px}
              height={6}
            />
            {completed.length > 3 && (
              <Text size="footnote" dimColor>
                ✓ {completed.length - 3} earlier done
              </Text>
            )}
            {ordered.map(t => (
              <Text wrap="truncate-end">
                <Text color={t.state === 'completed' ? 'success' : t.state === 'in_progress' ? 'claude' : 'subtle'}>
                  {t.state === 'completed' ? '✓ ' : t.state === 'in_progress' ? '◐ ' : '○ '}
                </Text>
                {t.state === 'completed' ? (
                  <Text dimColor>{t.subject}</Text>
                ) : t.state === 'in_progress' ? (
                  <Text weight="semibold">{t.activeForm || t.subject}</Text>
                ) : (
                  <Text>{t.subject}</Text>
                )}
                {t.state === 'in_progress' && <Text dimColor> · {duration(s.now - (t.startedAt ?? s.now))}</Text>}
              </Text>
            ))}
          </Box>
        )}

        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text size="caption" dimColor>
            Costs per agent are estimates{s.factor === 1 ? ' at list prices' : `, calibrated ${s.factor.toFixed(2)}×`}
          </Text>
          {(s.finished.length > 0 || completed.length > 0 || shellRows.some(r => !isLive(r))) && (
            <Button key="clear" label="Clear finished" onPress={() => void clearFinished($)} />
          )}
        </Box>
      </Box>
    )
  })
}
