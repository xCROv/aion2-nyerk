import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { writeFileAtomic, writeFileAtomicAsync } from '../src/main/atomicWrite.ts'

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
