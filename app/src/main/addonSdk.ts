/**
 * What `/_nyerk/` serves on each addon's origin (nyerk-addon://<id>/_nyerk/): `nyerk.js`, the API, and `nyerk.css`, the
 * app's colours and type, so a tab looks like the panel around it. Kept as text here rather than
 * as files beside the renderer: the protocol handler is the one place that serves them.
 *
 * nyerk.js speaks to the window holding the frame by postMessage (lib/addonFrame.ts relays to main):
 *   nyerk.on(name, fn)       an event: the app's (by permission: 'nearby', 'soul', ...), 'settings',
 *                            or one the addon's Python part emits. State-like ones (in the first
 *                            snapshot) are replayed to a listener added later. Returns an unsubscribe.
 *   nyerk.send(name, data)   to the addon's Python part (its on_message)
 *   nyerk.notify()           chime and pulse the bubble ('notify')
 *   nyerk.sound(id)          play one of the alert sounds, nyerk.sounds ([{ id, label }]), at the
 *                            timers' volume ('sound'; each once a second at most)
 *   nyerk.serverName(id)     a game server's name (Kaisinel for 1104), or its id when not known
 *   nyerk.storage            get(key) / set(key, value) / all(): its own JSON ('storage')
 *   nyerk.settings           its declared settings' values, kept current
 *   nyerk.hud                its HUD section: shown and detached (null when it has none), show(on),
 *                            detach(on) (a window of its own, moved like the HUD); the 'hud' event
 *                            ({ shown, detached }) says when either changes
 *   nyerk.on('storage', fn)  { key, value }: its storage changed (from any of its pages)
 *   nyerk.map.markers(list)  its markers on the Collection Map ('map'), replacing the last list:
 *                            [{ world, position: [x, y], color: '#rrggbb', label }]; [] clears them
 *   nyerk.ready              a promise, once the first snapshot is in
 * Every page also posts its height to the window holding it, which a HUD section is sized by.
 * Errors thrown in the page go to the app's log and the addon's card in Settings.
 */
import { GAME_SERVERS } from '../shared/gameServers.ts'
import { ALARM_SOUNDS } from '../shared/timers.ts'

export const SDK_JS = String.raw`(() => {
  'use strict'
  const SOUNDS = ${JSON.stringify(ALARM_SOUNDS)}
  const SERVERS = ${JSON.stringify(GAME_SERVERS)}
  const pending = new Map()
  const listeners = new Map()
  const latest = new Map()
  let seq = 0
  let resolveReady
  const call = (method, ...args) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      parent.postMessage({ nyerk: 1, kind: 'call', id, method, args }, '*')
    })
  const report = (error) => {
    const text = error && error.stack ? error.stack : String(error)
    call('error', text.slice(0, 2000)).catch(() => undefined)
  }
  const deliver = (name, data) => {
    if (name === 'settings') nyerk.settings = data
    if (name === 'hud' && data) {
      nyerk.hud.shown = data.shown
      nyerk.hud.detached = data.detached
    }
    if (latest.has(name)) latest.set(name, data)
    for (const fn of listeners.get(name) ?? []) {
      try {
        fn(data)
      } catch (error) {
        report(error)
      }
    }
  }
  addEventListener('message', (event) => {
    if (event.source !== parent) return
    const m = event.data
    if (!m || m.nyerk !== 1) return
    if (m.kind === 'reply') {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m.result)
    } else if (m.kind === 'event') deliver(m.name, m.data)
  })
  addEventListener('error', (event) => report(event.error ?? event.message))
  addEventListener('unhandledrejection', (event) => report(event.reason))

  const nyerk = {
    id: location.hostname,
    settings: {},
    ready: new Promise((resolve) => (resolveReady = resolve)),
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      if (latest.has(name)) queueMicrotask(() => fn(latest.get(name)))
      return () => listeners.get(name)?.delete(fn)
    },
    send: (name, data) => call('send', name, data),
    notify: () => call('notify'),
    sounds: SOUNDS.map((s) => ({ ...s })),
    sound: (id) => call('sound', id),
    serverName: (id) => SERVERS[id] ?? String(id),
    storage: {
      get: (key) => call('storage.get', key),
      set: (key, value) => call('storage.set', key, value),
      all: () => call('storage.all'),
    },
    hud: {
      shown: null,
      detached: null,
      show: (on) => call('hud.show', on === true),
      detach: (on) => call('hud.detach', on === true),
    },
    map: {
      markers: (list) => call('map.markers', Array.isArray(list) ? list : []),
    },
  }
  window.nyerk = nyerk

  // The page's height, for a frame sized to what it shows (the HUD's). A MutationObserver, not
  // only a ResizeObserver: the HUD window is hidden while empty, and a hidden window does not
  // run ResizeObservers, so its first content would never show it.
  let sentHeight = -1
  const sendHeight = () => {
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height)
    if (height === sentHeight) return
    sentHeight = height
    parent.postMessage({ nyerk: 1, kind: 'size', height }, '*')
  }
  let sizeQueued = false
  const queueHeight = () => {
    if (sizeQueued) return
    sizeQueued = true
    queueMicrotask(() => {
      sizeQueued = false
      sendHeight()
    })
  }
  const watchSize = () => {
    new MutationObserver(queueHeight).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    new ResizeObserver(queueHeight).observe(document.documentElement)
    addEventListener('load', queueHeight)
    document.fonts?.addEventListener('loadingdone', queueHeight)
    sendHeight()
  }

  // Once the page's own scripts have run (and set up their listeners): the state as it is now.
  const start = () =>
    setTimeout(() =>
      call('ready').then((snapshot) => {
        nyerk.settings = snapshot.settings
        if (snapshot.hud) snapshot.events.push({ name: 'hud', data: snapshot.hud })
        for (const { name } of snapshot.events) latest.set(name, undefined)
        for (const { name, data } of snapshot.events) deliver(name, data)
        resolveReady(nyerk)
      }, report),
    )
  const begin = () => {
    watchSize()
    start()
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', begin, { once: true })
  else begin()
})()
`

export const SDK_CSS = `/* Nyerk's look for addon pages: <link rel="stylesheet" href="/_nyerk/nyerk.css">. */
@font-face {
  font-family: 'Inter Variable';
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url('inter.woff2') format('woff2-variations');
}
:root {
  color-scheme: dark;
  --bg-app: #0e101d;
  --bg-card: #141528;
  --bg-tile: #191b33;
  --bg-control: #1e1f2c;
  --bg-control-hover: #252735;
  --border-card: #1f1f4f;
  --border: #373948;
  --text: #eaebef;
  --text-dark: #dae0ff;
  --text-darker: #b5b7c0;
  --text-darkest: #787b8a;
  --accent: #4f3cdd;
  --accent-hover: #4427cb;
  --accent-soft: #1f1f4f;
  --accent-text: #a3acff;
  --red: #ff9592;
  --green: #3dd68c;
  --yellow: #ffca16;
  --orange: #ffa057;
  --blue: #70b8ff;
  --radius: 8px;
}
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
body {
  font: 14px/1.4 'Inter Variable', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif;
  font-optical-sizing: auto;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  user-select: none;
}
input, textarea, select { user-select: text; font: inherit; color: inherit; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: #474959; border-radius: 4px; }
::-webkit-scrollbar-track { background: transparent; }
:focus:not(:focus-visible) { outline: none; }
:focus-visible { outline: 2px solid #5453c5; outline-offset: 1px; }

.n-card { background: var(--bg-card); border: 1px solid var(--border-card); border-radius: var(--radius); }
.n-heading { margin: 0 0 4px; font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--text-darkest); }
.n-hint { font-size: 12px; color: var(--text-darker); }
.n-muted { color: var(--text-darkest); }
.n-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; }
.n-row + .n-row { border-top: 1px solid #252735; }
.n-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 6px; background: var(--bg-control); color: var(--text);
  font-size: 12px; font-weight: 500; cursor: pointer;
}
.n-button:hover { background: var(--bg-control-hover); border-color: #606272; }
.n-button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.n-button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.n-input, .n-select {
  height: 28px; padding: 0 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-control); font-size: 12px;
}
.n-pill {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--bg-control); color: var(--text-darker); font-size: 12px; cursor: pointer;
}
.n-pill.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-text); }
`
