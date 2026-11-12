import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { writeFileAtomic, writeFileAtomicAsync } from '../src/main/atomicWrite.ts'
import { mergeSharedBosses, type FieldBosses } from '../src/shared/timers.ts'

describe('writeFileAtomic', () => {
  let dir = ''
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'nyerk-write-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('replaces the file and leaves nothing beside it', () => {
    const file = join(dir, 'pvp.json')
    writeFileSync(file, '[1]')
    writeFileAtomic(file, '[1,2]')
    assert.equal(readFileSync(file, 'utf8'), '[1,2]')
    assert.deepEqual(readdirSync(dir), ['pvp.json'])
  })

  it('does the same when written in the background', async () => {
    const file = join(dir, 'pvp.json')
    writeFileSync(file, '[1]')
    await writeFileAtomicAsync(file, '[1,2]')
    assert.equal(readFileSync(file, 'utf8'), '[1,2]')
    assert.deepEqual(readdirSync(dir), ['pvp.json'])
  })

  it('throws and cleans up when the new file cannot take the old one’s place', () => {
    const blocked = join(dir, 'storage.json')
    mkdirSync(blocked)
    assert.throws(() => writeFileAtomic(blocked, '{}'))
    assert.deepEqual(readdirSync(dir), ['storage.json'])
  })
})

describe('mergeSharedBosses', () => {
  const NOW = 1_800_000_000_000
  const GARTUA = 101021
  const KUTAR = 101002
  const mine: FieldBosses = { [GARTUA]: { up: false, at: NOW + 3_600_000, seen: NOW - 60_000, source: 'map' } }

  it('takes a newer shared reading of a known boss', () => {
    const next = mergeSharedBosses(mine, { [GARTUA]: { up: true, at: 0, observed: NOW - 1_000 } }, NOW)
    assert.deepEqual(next?.[GARTUA], { up: true, at: 0, seen: NOW - 1_000, source: 'shared' })
  })

  it('keeps the player’s own reading when the shared one is older', () => {
    assert.equal(mergeSharedBosses(mine, { [GARTUA]: { up: true, at: 0, observed: NOW - 120_000 } }, NOW), null)
  })

  it('holds a reading from a clock running fast to now', () => {
    const next = mergeSharedBosses(mine, { [GARTUA]: { up: true, at: 0, observed: NOW + 86_400_000 } }, NOW)
    assert.equal(next?.[GARTUA]?.seen, NOW)
  })

  it('ignores bosses it does not know', () => {
    const shared = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [900_000 + i, { up: true, at: 0, observed: NOW }]))
    assert.equal(mergeSharedBosses(mine, shared, NOW), null)
  })

  it('skips a bad entry and keeps the rest of the answer', () => {
    const next = mergeSharedBosses(mine, { [GARTUA]: null, [KUTAR]: { up: true, at: 0, observed: NOW } }, NOW)
    assert.equal(next?.[KUTAR]?.up, true)
    assert.equal(next?.[GARTUA], mine[GARTUA])
  })

  it('adds nothing from an answer that is not a list of bosses', () => {
    assert.equal(mergeSharedBosses(mine, null, NOW), null)
  })
})
