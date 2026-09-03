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

describe('readSessionLog provenance/surfaceOp hardening (importer-produced logs)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-move-prov-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  /** Simulates an importer-produced log whose provenance references streaming
   * chunks (dropped by the whitelist) plus garbage seqs, with missing
   * surfaceOp markers on surface-eligible events. */
  function makeImporterLog(): string {
    const header = JSON.stringify({
      type: 'session', version: 0, id: 'session-imp',
      createdAt: 1700000000000, cwd: '/tmp/b', delegationDepth: 0, agentPreset: 'standard',
    })
    const lines: string[] = [header]
    const push = (event: Record<string, unknown>): void => {
      const withMeta = { time: 1700000000001, ...event }
      lines.push(JSON.stringify(withMeta))
    }
    push({ type: 'session/imported', seq: 0, ignorable: true, data: { tool: 'import_dsh' } })
    push({ type: 'turn/start', seq: 1, data: { turn: 1 } })
    push({
      type: 'user/message', seq: 2, surfaceOp: 'append',
      data: { content: [{ type: 'text', text: 'hi' }] },
      sourceEventSeqs: [99999], // garbage: way beyond any event
    })
    push({ type: 'assistant/chunk', seq: 3, data: {} }) // dropped by whitelist
    push({
      type: 'assistant/message', seq: 4, surfaceOp: 'append',
      data: { message: { role: 'assistant', content: [] } },
      sourceEventSeqs: [3, 99999, 2], // [chunk(miss), garbage(miss), user/message(hit)]
    })
    push({ type: 'tool/call', seq: 5, data: { callId: 'c1', name: 'bash' } })
    push({ type: 'assistant/chunk', seq: 6, data: {} }) // dropped by whitelist
    push({
      type: 'tool/result', seq: 7,
      data: { callId: 'c1' },
      sourceEventSeqs: [5], // hit — but surfaceOp MISSING (importer gap)
    })
    push({ type: 'user/message', seq: 8, surfaceOp: 'append', data: { content: [{ type: 'text', text: 'go on' }] } }) // no provenance at all — legal
    push({ type: 'turn/end', seq: 9, data: { turn: 1 } })
    return lines.join('\n') + '\n'
  }

  it('fills missing surfaceOp on surface-eligible events', async () => {
    const path = join(dir, 'importer.jsonl')
    writeFileSync(path, makeImporterLog())
    const { events } = await readSessionLog(path)
    for (const event of events) {
      if (['user/message', 'assistant/message', 'tool/result'].includes(event.type as string)) {
        expect(event.surfaceOp, `${event.type}@${event.seq}`).toBe('append')
      }
    }
  })

  it('drops provenance refs that do not resolve to an earlier kept event', async () => {
    const path = join(dir, 'importer.jsonl')
    writeFileSync(path, makeImporterLog())
    const { events } = await readSessionLog(path)
    for (const event of events) {
      const refs = event.sourceEventSeqs
      if (!Array.isArray(refs)) continue
      for (const ref of refs as number[]) {
        expect(ref, `${event.type}@${event.seq}`).toBeLessThan(event.seq as number)
        expect(ref).toBeGreaterThanOrEqual(0)
      }
    }
    const user = events.find((event) => event.seq === 2)
    // [99999] does not resolve → the field is dropped (absence skips the
    // replay provenance check; empty is illegal for user/message).
    expect(user).not.toHaveProperty('sourceEventSeqs')
    const assistant = events.find((event) => event.seq === 3)
    // [chunk(miss), garbage(miss), user/message(hit)] → only the hit survives.
    expect(assistant.sourceEventSeqs).toEqual([2])
    const result = events.find((event) => event.type === 'tool/result')
    // [tool/call] resolves and is remapped to the call's new seq.
    expect(result.sourceEventSeqs).toEqual([4])
  })

  it('keeps the session/imported marker through a move', async () => {
    const path = join(dir, 'importer.jsonl')
    writeFileSync(path, makeImporterLog())
    const { events } = await readSessionLog(path)
    const imported = events.find((event) => event.type === 'session/imported')
    expect(imported).toBeDefined()
    expect(imported?.seq).toBe(0)
  })

  it('assistant/message provenance may legitimately become empty', async () => {
    const path = join(dir, 'importer-empty.jsonl')
    const header = JSON.stringify({
      type: 'session', version: 0, id: 'session-imp2',
      createdAt: 1700000000000, cwd: '/tmp/c', delegationDepth: 0, agentPreset: 'standard',
    })
    const lines = [
      header,
      JSON.stringify({ type: 'assistant/message', seq: 0, surfaceOp: 'append', time: 1, data: {}, sourceEventSeqs: [7, 8] }),
      // seqs 7/8: whitelist-outside events only → every ref is dropped
    ]
    writeFileSync(path, lines.join('\n') + '\n')
    const { events } = await readSessionLog(path)
    expect(events[0].sourceEventSeqs).toEqual([])
  })
})
