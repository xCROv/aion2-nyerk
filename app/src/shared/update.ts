/** The app's own updates: what the panel shows of them. */

export type UpdateState =
  | 'idle' // nothing checked yet
  | 'unsupported' // a development run: there is no feed to update from
  | 'checking'
  | 'none' // up to date
  | 'available' // a newer version is on the feed; nothing downloaded yet
  | 'downloading'
  | 'ready' // downloaded: a restart installs it
  | 'restarting' // about to restart to install it (restartAt)
  | 'error'

/**
 * What a restart will do. A bundle is the app alone, a few MB adopted on a quick restart; an
 * installer is the whole install (a new Electron or tracker helper), the long way round.
 */
export type UpdateKind = 'bundle' | 'installer'

export interface UpdateStatus {
  state: UpdateState
  /** The version running (a downloaded bundle's, when one is). */
  current: string
  /** The version on offer (available, downloading, ready, restarting). */
  version: string | null
  kind: UpdateKind | null
  percent: number | null
  /** The last failure in a short line with its code (ENOENT, HTTP 404…); the full error is in tracker.log. */
  error: string | null
  checkedAt: number | null
  /** When the restart happens (state restarting). */
  restartAt: number | null
}

/** What an automatic check does with an update it has downloaded. */
export type AutoInstallStep = 'restart' | 'wait-for-game' | 'ask'

/**
 * A bundle installs itself, but never under someone playing. An installer replaces the whole
 * install, so it always waits for the player's Restart to install.
 */
export function autoInstallStep(kind: UpdateKind | null, gameRunning: boolean): AutoInstallStep {
  if (kind !== 'bundle') return 'ask'
  return gameRunning ? 'wait-for-game' : 'restart'
}

export const initialUpdateStatus = (current: string): UpdateStatus => ({
  state: 'idle',
  current,
  version: null,
  kind: null,
  percent: null,
  error: null,
  checkedAt: null,
  restartAt: null,
})
