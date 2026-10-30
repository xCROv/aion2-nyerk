/**
 * Nyerk (an Aion 2 pet collection tracker): a tray app with a floating bubble, a panel and an in-game HUD, fed by the
 * Python tracker running as a child process.
 */
import { app } from 'electron'
import { addons, registerAddonScheme } from './addons.ts'
import { DISPLAY_NAME } from '../shared/app.ts'
import { broadcast } from './broadcast.ts'
import { keepPvpLogOn } from './builtins.ts'
import { startFieldBosses } from './fieldBosses.ts'
import { startHealthWatch } from './health.ts'
import { registerIpc } from './ipc.ts'
import { settings } from './settings.ts'
import { startIdleWatch } from './idle.ts'
import { join } from 'node:path'
import { moveDataFolder, OLD_NAMES } from './migrate.ts'
import { startTimers } from './timers.ts'
import { killTrackerNow, log, stopTracker, tracker } from './tracker.ts'
import { createTray, setTrayTooltip } from './tray.ts'
import { takeRestartState } from './restart.ts'
import { timers } from './timers.ts'
import { startUpdateChecks } from './update.ts'
import { appVersion } from './version.ts'
import { applyWindowSettings, markQuitting, refreshHud, showMerchant, showPanel, showPanelTab, startOnTopWatch } from './windows.ts'

// The name is also the data folder's (%APPDATA%\<name>): the old one is moved across once.
app.setName(DISPLAY_NAME)
const migrated = OLD_NAMES.map((name) => moveDataFolder(join(app.getPath('appData'), name), app.getPath('userData')))
  .filter((m) => m !== 'nothing to move')
  .join('; ')
// Kept from the first release: Windows ties the shortcut and the updater to this id.
app.setAppUserModelId('com.xcrov.aion2-drop-tracker')
// Addons' pages (nyerk-addon://): Electron wants the scheme named before the app is ready.
registerAddonScheme()

// One instance: a second launch opens the first one's panel instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showPanel())

  void app.whenReady().then(() => {
    if (migrated) log(`data folder: ${migrated}`)
    // Back from an update restart: the session, the alerts already seen, the open windows.
    const restored = takeRestartState(app.getPath('userData'))
    if (restored) {
      log(`restarted for an update: ${restored.from} -> ${restored.to}${restored.to === appVersion() ? '' : ` (running ${appVersion()})`}`)
      tracker.restoreSession(restored)
      timers.restore(restored.timers)
    }
    startHealthWatch()
    startFieldBosses()
    startOnTopWatch()
    registerIpc()
    createTray()
    if (keepPvpLogOn()) log('addons: PvP Log kept on (it now starts off; this profile has a pvp.json)')
    addons.start()

    settings.onChanged((all) => {
      broadcast('settings:changed', all)
      applyWindowSettings()
      tracker.applyDebugLogging()
    })
    // A tab of the Black Cloud Merchant was opened: its pets worth buying, in their own window.
    tracker.onShop(() => showMerchant())
    tracker.onStatus((status) => {
      refreshHud()
      const what = {
        starting: 'starting…',
        listening: 'waiting for the game',
        locked: status.gameActive ? 'tracking' : 'connected, no game traffic',
        idle: 'asleep until Aion 2 starts',
        stopped: 'replay finished',
        error: 'error',
        exited: 'restarting',
      }[status.state]
      setTrayTooltip(`${DISPLAY_NAME}: ${what}`)
    })

    // The bubble, the HUD and the tracker, once it is known whether the game is running.
    void startIdleWatch()
    startUpdateChecks()
    startTimers()
    if (restored?.panel.visible) {
      if (restored.panel.tab) showPanelTab(restored.panel.tab)
      else showPanel()
    }
    if (restored?.merchantOpen) showMerchant()
  })

  // Tray app: closing every window is not quitting.
  app.on('window-all-closed', () => undefined)

  app.on('before-quit', () => {
    markQuitting()
    stopTracker()
  })
  // Windows children outlive their parent: make sure the tracker goes with us.
  process.on('exit', () => killTrackerNow())
}
