import type { History, ShellRow, ShellState } from '../types'
import { median } from './estimate'

export const SHELLS_KEEP = 30
export const DEFAULT_TIMEOUT_MS = 120_000

// What a command runs, in a few words: `npm run build`, `xcodebuild`, `git status`.
// Leading `cd …` steps and VAR=value assignments are not what it runs.
export function commandKey(command: string): string {
  const parts = command
    .split(/\n|&&|\|\||;|\|/)
    .map(p => p.trim())
    .filter(p => p !== '' && !/^cd(\s|$)/.test(p))
  const words = (parts[0] ?? command.trim()).split(/\s+/)
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) words.shift()
  const [head, ...rest] = words
  if (head === undefined || head === '') return 'shell'
  const plain: string[] = []
  for (const word of rest) {
    if (plain.length === 2 || !/^[a-z][\w:.-]*$/i.test(word)) break
    plain.push(word)
  }

  return [head.split('/').pop() ?? head, ...plain].join(' ')
}

export type ShellNotice = {
  taskId: string
  status?: string
  exitCode?: number
  summary?: string
  outputPath?: string
}

// A background task's notification, as the engine words it:
// <task-id>…</task-id> … <status>completed</status> <summary>… (exit code 1)</summary>
export function parseNotice(text: string): ShellNotice | undefined {
  const tag = (name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()
  const taskId = tag('task-id')
  if (taskId === undefined || taskId === '') return undefined
  const summary = tag('summary')
  const code = (summary ?? text).match(/exit code[:\s]+(-?\d+)/i)?.[1]

  return {
    taskId,
    status: tag('status'),
    exitCode: code === undefined ? undefined : Number(code),
    summary,
    outputPath: tag('output-file'),
  }
}

export function stateFromNotice(status: string | undefined, exitCode: number | undefined): ShellState | undefined {
  if (status === undefined) return undefined
  if (/^(completed|done|success)/i.test(status)) return exitCode !== undefined && exitCode !== 0 ? 'failed' : 'done'
  if (/^fail|error|timed?_?out/i.test(status)) return 'failed'
  if (/^(killed|stopped|cancel)/i.test(status)) return 'killed'

  return undefined
}

// Where a background command writes, from the launch message the model reads.
export function outputPathIn(text: string | undefined): string | undefined {
  return text?.match(/(\/[^\s'"`<>]+\.output)\b/)?.[1]
}

// The last line a terminal would show: escapes dropped, a carriage-return
// progress line reduced to what it last drew.
export function lastLine(text: string, width = 240): string | undefined {
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const lines = clean
    .split(/\n/)
    .map(l => (l.split('\r').filter(p => p.trim() !== '').pop() ?? '').trim())
    .filter(l => l !== '')
  const last = lines[lines.length - 1]

  return last === undefined ? undefined : last.slice(0, width)
}

export function countLines(text: string): number {
  if (text === '') return 0

  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function bytes(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`

  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function isLive(row: ShellRow): boolean {
  return row.state === 'running' || row.state === 'background'
}

export type ShellEstimate = {
  elapsedMs: number
  usualMs?: number
  remainingMs?: number
  // Of the usual time, while it runs; absent with no history.
  fraction?: number
  isOverrun: boolean
  // Of the timeout or deadline.
  limitFraction?: number
}

export function estimateShell(row: ShellRow, history: History, now: number): ShellEstimate {
  const elapsedMs = Math.max(0, (row.endedAt ?? now) - row.startedAt)
  const limitFraction = row.limitMs === undefined || !isLive(row) ? undefined : Math.min(1, elapsedMs / row.limitMs)
  const usualMs = median(history.shellMs?.[row.key] ?? [])
  if (!isLive(row) || usualMs === undefined || row.kind === 'monitor') {
    return { elapsedMs, usualMs, isOverrun: false, limitFraction }
  }
  const isOverrun = elapsedMs >= usualMs
  const remainingMs = isOverrun ? Math.max(2_000, elapsedMs * 0.25) : usualMs - elapsedMs
  const fraction = Math.min(0.97, elapsedMs / (elapsedMs + remainingMs))

  return { elapsedMs, usualMs, remainingMs, fraction, isOverrun, limitFraction }
}

// How long until every foreground shell is likely done; background ones
// (watchers, servers) are not waited on.
export function shellEta(shells: readonly ShellRow[], history: History, now: number): number | undefined {
  const left = shells.filter(s => s.state === 'running').map(s => estimateShell(s, history, now).remainingMs)
  if (left.length === 0 || left.some(r => r === undefined)) return undefined

  return Math.max(...(left as number[]))
}

// Keeps every live shell and the newest finished ones.
export function trimShells(list: readonly ShellRow[]): ShellRow[] {
  const finished = list.filter(s => !isLive(s)).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const excess = finished.length - SHELLS_KEEP
  if (excess <= 0) return [...list]
  const dropped = new Set(finished.slice(0, excess).map(s => s.id))

  return list.filter(s => !dropped.has(s.id))
}
