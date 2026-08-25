import { afterAll, describe, expect, it } from 'vitest'
import { readSessionLog } from '../src/index.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeLog(): string {
  const header = JSON.stringify({
    type: 'session', version: 0, id: 'session-x',
    createdAt: 1700000000000, cwd: '/tmp/a', delegationDepth: 0, agentPreset: 'standard',
  })
  const lines: string[] = [header]
  let seq = 0
  const push = (type: string, withSeq: boolean, data: Record<string, unknown> = {}): void => {
    const event: Record<string, unknown> = { type, time: 1700000000001 }
    if (withSeq) event.seq = seq++
    event.data = data
    lines.push(JSON.stringify(event))
  }
  push('permission/preset', true) // runtime stamp — dropped
  push('turn/start', true)
  push('user/message', true, { content: [{ type: 'text', text: 'hi' }] })
  push('reasoning-chunks', false) // streaming chunk — dropped
  push('assistant/chunk', false) // streaming chunk — dropped
  push('step/start', true)
  push('tool/call', true)
  push('tool/result', true)
  push('session/end-seed', true) // runtime stamp — dropped
  push('step/end', true)
  push('turn/end', true)
  return lines.join('\n') + '\n'
}

describe('readSessionLog (move pipeline)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-move-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps only durable events and renumbers seq from zero', async () => {
    const path = join(dir, 'session.jsonl')
    writeFileSync(path, makeLog())
    const { header, events } = await readSessionLog(path)
    expect(header.id).toBe('session-x')
    expect(header.cwd).toBe('/tmp/a')
    expect(header).not.toHaveProperty('type')
    expect(events.map((event) => event.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ])
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('counts unparsable lines (truncated tails, corrupt rows) instead of failing', async () => {
    const truncatedPath = join(dir, 'truncated.jsonl')
    writeFileSync(truncatedPath, makeLog() + '{"type":"assistant/chunk","data":{"tex')
    const truncated = await readSessionLog(truncatedPath)
    expect(truncated.events.length).toBe(7)
    expect(truncated.skippedLines).toBe(1)

    // A mid-log corrupt row is indistinguishable from a torn tail at the line
    // level, so it is tolerated and counted the same way (importer contract).
    const corruptPath = join(dir, 'corrupt.jsonl')
    writeFileSync(corruptPath, makeLog().replace('"turn/start"', '"turn/start" {"broken'))
    const corrupt = await readSessionLog(corruptPath)
    expect(corrupt.skippedLines).toBe(1)
    expect(corrupt.events.some((event) => event.type === 'user/message')).toBe(true)
  })

  it('rejects a log whose first line is not the session header', async () => {
    const path = join(dir, 'noheader.jsonl')
    writeFileSync(path, JSON.stringify({ type: 'sandbox/mode' }) + '\n')
    await expect(readSessionLog(path)).rejects.toThrow(/not a session header/)
  })
})
