/**
 * Saving a file whole or not at all: written beside it under another name, then renamed over it,
 * as bundles/state.json is. A crash, a shutdown or a full disk mid-write then leaves the last good
 * copy, rather than half a file that the next start cannot parse and so starts empty from. (No
 * Electron import here, so the tests can run it.)
 */
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'

let writes = 0
// A name per write: the PvP log's background save and its flush at quit can overlap.
const partialPath = (path: string): string => `${path}.${++writes}.part`

export function writeFileAtomic(path: string, text: string): void {
  const partial = partialPath(path)
  try {
    writeFileSync(partial, text)
    renameSync(partial, path)
  } catch (err) {
    rmSync(partial, { force: true })
    throw err
  }
}

export async function writeFileAtomicAsync(path: string, text: string): Promise<void> {
  const partial = partialPath(path)
  try {
    await writeFile(partial, text)
    await rename(partial, path)
  } catch (err) {
    await rm(partial, { force: true })
    throw err
  }
}
