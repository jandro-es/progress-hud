import type { ElementTable } from 'claude-code'

import type { History, ShellRow } from '../types'
import { bar, clip, duration } from './estimate'
import { bytes, estimateShell, isLive } from './shells'
import type { ShellEstimate } from './shells'
import { ACCENT, GOOD, WARN, meterBar } from './svg'

const FINISHED_SHOWN = 4

type Labeller = (agentId: string | undefined) => string | undefined

function ordered(shells: readonly ShellRow[]) {
  const live = shells
    .filter(isLive)
    .sort((a, b) => (a.state === b.state ? a.startedAt - b.startedAt : a.state === 'running' ? -1 : 1))
  const finished = shells.filter(s => !isLive(s)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

  return { live, finished }
}

function tags(s: ShellRow, label: Labeller): string {
  const out: string[] = []
  if (s.kind === 'monitor') out.push('monitor')
  else if (s.state === 'background') {
    out.push(
      s.backgroundedBy === 'user'
        ? 'bg, ctrl+b'
        : s.backgroundedBy === 'timeout'
          ? 'bg, past its timeout'
          : 'bg',
    )
  }
  const who = label(s.agentId)
  if (who !== undefined) out.push(`in ${who}`)

  return out.length === 0 ? '' : ` · ${out.join(' · ')}`
}

function facts(s: ShellRow, est: ShellEstimate): string {
  const out = [duration(est.elapsedMs)]
  if (s.kind === 'monitor') {
    out.push(`${s.events ?? 0} event${s.events === 1 ? '' : 's'}`)
    if (s.limitMs !== undefined) out.push(`deadline ${duration(s.limitMs)}`)

    return out.join(' · ')
  }
  if (est.remainingMs !== undefined) out.push(est.isOverrun ? `running long, ~${duration(est.remainingMs)} more` : `~${duration(est.remainingMs)} left`)
  if (est.usualMs !== undefined) out.push(`usually ${duration(est.usualMs)}`)
  if (s.state === 'running' && s.limitMs !== undefined) out.push(`timeout ${duration(s.limitMs)}`)
  if (s.state === 'background') {
    if (s.outputBytes !== undefined) out.push(bytes(s.outputBytes))
    if (s.outputLines !== undefined) out.push(`${s.outputLines.toLocaleString('en-GB')} lines`)
    if (s.linesPerSec !== undefined && s.linesPerSec >= 0.1) out.push(`${s.linesPerSec.toFixed(1)} lines/s`)
  }

  return out.join(' · ')
}

function ending(s: ShellRow, est: ShellEstimate): string {
  const out = [duration(est.elapsedMs)]
  if (s.state === 'killed') out.push('stopped')
  else if (s.exitCode !== undefined && s.exitCode !== 0) out.push(`exit ${s.exitCode}`)
  if (s.kind === 'monitor' && s.events !== undefined) out.push(`${s.events} events`)
  else if (s.outputLines !== undefined) out.push(`${s.outputLines.toLocaleString('en-GB')} lines`)
  if (s.hasStderr) out.push('stderr')

  return out.join(' · ')
}

function title(s: ShellRow): string {
  return s.description || s.command
}

function heading(live: readonly ShellRow[], finished: readonly ShellRow[]): string {
  const fg = live.filter(s => s.state === 'running').length

  return `${fg} running · ${live.length - fg} background · ${finished.length} finished`
}

export function terminalShells(
  { Box, Text }: ElementTable<'terminal'>,
  shells: readonly ShellRow[],
  history: History,
  now: number,
  width: number,
  label: Labeller,
) {
  if (shells.length === 0) return null
  const { live, finished } = ordered(shells)
  const spin = '◐◓◑◒'[Math.floor(now / 500) % 4]

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>
        SHELLS <Text dimColor>{heading(live, finished)}</Text>
      </Text>
      {live.map(s => {
        const est = estimateShell(s, history, now)
        const isFg = s.state === 'running'
        const fill = est.fraction ?? est.limitFraction
        const isNearLimit = (est.limitFraction ?? 0) > 0.8
        const b = bar(fill ?? 0, Math.min(12, width - 30))

        return (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={isFg ? 'claude' : 'suggestion'}>{isFg ? spin : s.kind === 'monitor' ? '◎' : '◉'}</Text>{' '}
              <Text bold>{clip(title(s), width - 4)}</Text>
              <Text dimColor>{tags(s, label)}</Text>
            </Text>
            {s.description !== undefined && s.description !== '' && (
              <Text dimColor wrap="truncate-end">
                {'  $ '}
                {clip(s.command, width - 4)}
              </Text>
            )}
            <Text wrap="truncate-end">
              {'  '}
              {fill !== undefined && (
                <Text>
                  <Text color={est.isOverrun || isNearLimit ? 'warning' : isFg ? 'claude' : 'suggestion'}>{b.filled}</Text>
                  <Text color="subtle">{b.track}</Text>{' '}
                </Text>
              )}
              <Text dimColor>{facts(s, est)}</Text>
            </Text>
            {s.lastLine !== undefined && (
              <Text dimColor wrap="truncate-end">
                {'  › '}
                {clip(s.lastLine, width - 4)}
              </Text>
            )}
          </Box>
        )
      })}
      {finished.slice(0, FINISHED_SHOWN).map(s => {
        const est = estimateShell(s, history, now)
        const glyph = s.state === 'done' ? '✓' : s.state === 'killed' ? '■' : '✗'
        const color = s.state === 'done' ? 'success' : s.state === 'killed' ? 'inactive' : 'error'

        return (
          <Text wrap="truncate-end">
            <Text color={color}>{glyph}</Text>{' '}
            <Text dimColor>
              {clip(title(s), width - 24)} · {ending(s, est)}
            </Text>
          </Text>
        )
      })}
      {finished.length > FINISHED_SHOWN && <Text dimColor>  + {finished.length - FINISHED_SHOWN} more</Text>}
    </Box>
  )
}

export function richShells(
  { Box, Text, Svg }: ElementTable<'desktop'> | ElementTable<'vscode'> | ElementTable<'mobile'>,
  shells: readonly ShellRow[],
  history: History,
  now: number,
  px: number,
  label: Labeller,
) {
  if (shells.length === 0) return null
  const { live, finished } = ordered(shells)

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text size="heading" weight="semibold">
          Shells
        </Text>
        <Text size="footnote" dimColor>
          {heading(live, finished)}
        </Text>
      </Box>
      {live.map(s => {
        const est = estimateShell(s, history, now)
        const isFg = s.state === 'running'
        const fill = est.fraction ?? est.limitFraction
        const isNearLimit = (est.limitFraction ?? 0) > 0.8

        return (
          <Box flexDirection="column" gap={0}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text weight="medium" wrap="truncate-end">
                <Text color={isFg ? 'claude' : 'suggestion'}>{isFg ? '● ' : s.kind === 'monitor' ? '◎ ' : '◉ '}</Text>
                {title(s)}
              </Text>
              <Text tabular dimColor>
                {duration(est.elapsedMs)}
              </Text>
            </Box>
            {s.description !== undefined && s.description !== '' && (
              <Text mono size="footnote" dimColor wrap="truncate-end">
                $ {s.command}
              </Text>
            )}
            <Svg
              source={meterBar(fill, px, est.isOverrun || isNearLimit ? WARN : isFg ? ACCENT : GOOD)}
              alt={fill === undefined ? 'No estimate yet' : `${Math.round(fill * 100)}%`}
              width={px}
              height={6}
            />
            <Text size="footnote" dimColor wrap="truncate-end">
              {facts(s, est)}
              {tags(s, label)}
            </Text>
            {s.lastLine !== undefined && (
              <Text mono size="footnote" dimColor wrap="truncate-end">
                › {s.lastLine}
              </Text>
            )}
          </Box>
        )
      })}
      {finished.slice(0, FINISHED_SHOWN + 2).map(s => {
        const est = estimateShell(s, history, now)
        const glyph = s.state === 'done' ? '✓ ' : s.state === 'killed' ? '■ ' : '✗ '
        const color = s.state === 'done' ? 'success' : s.state === 'killed' ? 'inactive' : 'error'

        return (
          <Text size="footnote" wrap="truncate-end">
            <Text color={color}>{glyph}</Text>
            <Text dimColor>
              {title(s)} · {ending(s, est)}
            </Text>
          </Text>
        )
      })}
      {finished.length > FINISHED_SHOWN + 2 && (
        <Text size="footnote" dimColor>
          + {finished.length - FINISHED_SHOWN - 2} more
        </Text>
      )}
    </Box>
  )
}
