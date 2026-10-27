import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bar, duration, estimateTasks, EMPTY_HISTORY, plain, usd } from './estimate'
import { commandKey, lastLine, parseNotice, stateFromNotice } from './shells'
import type { TaskRow } from '../types'

const PANE = {
  plugin: 'progress-hud',
  component: 'Pane',
  requestId: 'progress-hud',
  props: {
    title: 'Progress',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Stands for the engine beneath the mod: a session that costs a cent a second.
function engine(on: On, listed: () => unknown[] = () => [], isStoreMocked = true) {
  const clock = mock.clock(on, { now: 1_000_000 })
  if (isStoreMocked) mock.store(on)
  let ids = 0
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: listed() }))
  on('session.usage', () => ({
    value: {
      startedAt: 1_000_000,
      context: { tokens: 42_000, window: 200_000, percent: 21 },
      rateLimits: [],
      cost: { usd: (clock.now() - 1_000_000) / 100_000 },
    },
  }))
  on('tool.call', (_, e) => {
    const call = e as unknown as { tool: string; subject?: string; taskId?: string }
    if (call.tool === 'TaskCreate') return { result: { task: { id: String(++ids), subject: call.subject } } }
    if (call.tool === 'TaskUpdate') return { result: { success: true, taskId: call.taskId, updatedFields: ['status'] } }
    if (call.tool === 'Bash') {
      const bash = e as unknown as { run_in_background?: boolean }
      if (bash.run_in_background) {
        return {
          result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
          text: 'Command running in background with ID: b1. Output is being written to: /tmp/demo/tasks/b1.output',
        }
      }

      return clock.sleep(30_000).then(() => ({
        result: { stdout: 'Compiling\nLinking\nBuild succeeded\n', stderr: '', interrupted: false },
      }))
    }

    return { result: {} }
  })

  return clock
}

test('tasks move through the pane with an estimate, on terminal and desktop', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const subject of ['Write parser', 'Add tests', 'Wire the view']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await clock.advance(60_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Adding tests' })
  await clock.advance(2_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Write parser/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Adding tests/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Wire the view/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /~1m/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a running subagent shows with its elapsed time', async ($, on) => {
  const clock = engine(on, () => [
    { id: 'a1b2c3d4', description: 'Find the config files', type: 'Explore', status: 'running' },
  ])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(5_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Find the config files/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an empty session says what the pane is for', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /show here as they start/ })).toBeDefined()
  await ui.unmount()
})

test('the demo walks its tasks to done and teaches the estimates nothing', async ($, on) => {
  const clock = engine(on, () => [], false)
  const writes: unknown[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_, e) => {
    writes.push(e)

    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'progress', args: 'demo' })
  expect(ran.text).toMatch(/demo tasks/)
  await clock.advance(10_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Demo: Survey the docs folder/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Demo: Checking the open issues/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Demo: Review and wrap up/ })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(30_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /4\/4 done/ })).toBeDefined()
  await ui.unmount()
  // Nothing reached the history kept across sessions.
  expect(writes).toEqual([])
})

test('a foreground shell runs against its timeout, then settles with its output', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the app' })
  await clock.advance(10_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Build the app/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /npm run build/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /timeout 2m/ })).toBeDefined()
    await ui.unmount()
  }

  await clock.advance(25_000)
  await ran
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Build the app · 30s · 3 lines/ })).toBeDefined()
  await ui.unmount()
})

test('a background shell shows its output as it grows and ends on its notice', async ($, on) => {
  const clock = engine(on)
  on('fs.stat', () => ({ value: { kind: 'file', size: 2048, mtimeMs: 0, isLink: false } }))
  on('process.run', (_, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    const stdout = argv[0] === 'wc' ? '     340 /tmp/demo/tasks/b1.output\n' : 'PASS src/a.test.ts\n\u001b[32mPASS src/b.test.ts\u001b[0m\n'

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- --watch', description: 'Run the test watcher', run_in_background: true })
  await clock.advance(4_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Run the test watcher/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2.0 KB · 340 lines/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /› PASS src\/b.test.ts$/ })).toBeDefined()
    await ui.unmount()
  }

  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<task-notification><task-id>b1</task-id><status>completed</status><summary>Background command "Run the test watcher" completed (exit code 1)</summary></task-notification>',
        },
      ],
    },
    door: 'delivery',
    origin: { kind: 'task-notification' },
    uuid: 'n1',
  } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Run the test watcher · .* · exit 1/ })).toBeDefined()
  await ui.unmount()
})

test('untrusted text loses every escape sequence and control character', async () => {
  expect(plain('a\u001b]0;title\u001b\\b')).toBe('ab')
  expect(plain('a\u001b]8;;http://x\u0007link\u001b]8;;\u0007b')).toBe('alinkb')
  expect(plain('a\u001bP1$r\u001b\\b')).toBe('ab')
  expect(plain('a\u009b31mred\u001b[0mb')).toBe('aredb')
  expect(plain('bell\u0007 back\u0008space\u007f\u0085')).toBe('bell backspace')
  expect(plain('tab\tand\nnewline stay')).toBe('tab\tand\nnewline stay')
  expect(lastLine('ok\n\u001b]0;pwned\u001b\\done\u0007\n')).toBe('done')
})

test('the shell helpers', async () => {
  expect(commandKey('cd /repo && NODE_ENV=test npm run build -- --prod')).toBe('npm run build')
  expect(commandKey('/usr/bin/xcodebuild -scheme X test')).toBe('xcodebuild')
  expect(commandKey('git status')).toBe('git status')
  expect(lastLine('one\ntwo\r 40%\r 80%\n\n')).toBe('80%')
  expect(parseNotice('<task-id>b9</task-id><status>failed</status><summary>Background command failed (exit code 2)</summary>')).toEqual({
    taskId: 'b9',
    status: 'failed',
    exitCode: 2,
    summary: 'Background command failed (exit code 2)',
    outputPath: undefined,
  })
  expect(stateFromNotice('completed', 0)).toBe('done')
  expect(stateFromNotice('completed', 3)).toBe('failed')
  expect(stateFromNotice('killed', undefined)).toBe('killed')
})

test('the estimators', async () => {
  expect(bar(0.5, 4)).toEqual({ filled: '██', track: '░░' })
  expect(bar(0.3, 4).filled).toBe('█▎')
  expect(duration(65_000)).toBe('1m 05s')
  expect(duration(3_725_000)).toBe('1h 02m')
  expect(usd(0.004)).toBe('<$0.01')

  const at = (state: TaskRow['state'], startedAt?: number, completedAt?: number): TaskRow => ({
    id: String(Math.random()),
    subject: 's',
    state,
    source: 'task',
    createdAt: 0,
    startedAt,
    completedAt,
  })
  const est = estimateTasks(
    [at('completed', 0, 60_000), at('completed', 60_000, 120_000), at('pending'), at('pending')],
    EMPTY_HISTORY,
    120_000,
  )
  expect(est.avgMs).toBe(60_000)
  expect(est.remainingMs).toBe(120_000)
  expect(est.fraction).toBe(0.5)
})
