'use strict'

const list = document.querySelector('#list')
let items = []
let cleanupTimer = null
let timerInputs = new Set()
let settings = { captureKeys: true, captureMouse: true, fontSize: 18, width: 320, maxItems: 8, lifetime: 2200, transparency: 0, hideWhenIdle: false, hideIdlePrompt: false }

function updateTimerPreferences(value) {
  const timers = value && typeof value.timers === 'object' && !Array.isArray(value.timers) ? value.timers : {}
  timerInputs = new Set(Object.entries(timers).filter(([, enabled]) => enabled === true).map(([name]) => name.trim().toLowerCase()))
}

function isTimerEnabled(source) {
  return timerInputs.has(String(source || '').trim().toLowerCase())
}

function updateSettings(value) {
  settings = { ...settings, ...(value || {}) }
  document.documentElement.style.setProperty('--input-size', `${Number(settings.fontSize) || 18}px`)
  document.documentElement.style.setProperty('--input-width', `${Number(settings.width) || 320}px`)
  document.documentElement.style.setProperty('--overlay-opacity', `${1 - Math.max(0, Math.min(90, Number(settings.transparency) || 0)) / 100}`)
  document.body.classList.toggle('frameless', settings.showFrame === false)
  draw()
}

function draw() {
  if (cleanupTimer !== null) {
    clearTimeout(cleanupTimer)
    cleanupTimer = null
  }
  const now = Date.now()
  items = items
    .filter(item => item.held || now - item.time < Number(settings.lifetime))
    .filter(item => item.kind === 'key' ? settings.captureKeys !== false : settings.captureMouse !== false)
    .filter(item => settings.hideWhenIdle !== true || item.held)
  const heldItems = items.filter(item => item.held)
  const recentItems = items.filter(item => !item.held).slice(0, Number(settings.maxItems) || 8)
  items = [...heldItems, ...recentItems]
  if (!items.length) {
    document.body.classList.toggle('idle', settings.hideWhenIdle === true || settings.hideIdlePrompt === true)
    if (settings.hideWhenIdle === true || settings.hideIdlePrompt === true) {
      list.replaceChildren()
      return
    }
    const prompt = document.createElement('div')
    prompt.className = 'empty'
    prompt.textContent = 'Press a key or click to show input here'
    list.replaceChildren(prompt)
    return
  }
  document.body.classList.remove('idle')
  const displayItems = []
  const aliasGroups = new Map()
  for (const item of items) {
    if (!item.aliased) {
      displayItems.push({ label: item.label, items: [item], aliased: false })
      continue
    }
    const key = item.label.trim().toLowerCase()
    let group = aliasGroups.get(key)
    if (!group) {
      group = { label: item.label, items: [], aliased: true }
      aliasGroups.set(key, group)
      displayItems.push(group)
    }
    group.items.push(item)
  }
  list.replaceChildren(...displayItems.map(group => {
    const row = document.createElement('div')
    row.className = `entry${group.items.some(item => item.held) || group.aliased ? ' held' : ''}`
    const seen = new Set()
    for (const item of group.items) {
      const source = item.source || item.label
      const badgeText = group.aliased ? source : item.kind === 'mouse' ? 'MOUSE' : 'KEY'
      const badgeKey = `${item.kind}:${badgeText}`
      if (seen.has(badgeKey)) continue
      seen.add(badgeKey)
      const badge = document.createElement('span')
      badge.className = `badge${item.kind === 'mouse' ? ' mouse' : ''}`
      badge.textContent = badgeText
      if (group.aliased) badge.title = `${item.kind === 'mouse' ? 'Mouse' : 'Key'}: ${source}`
      row.append(badge)
    }
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = group.label
    row.append(label)
    const timedItems = new Map()
    for (const item of group.items) {
      if (!item.timerEnabled) continue
      const source = item.source || item.label
      const previous = timedItems.get(source)
      if (!previous || item.held || (!previous.held && item.time > previous.time)) timedItems.set(source, item)
    }
    for (const [source, item] of timedItems) {
      const elapsed = item.held ? performance.now() - item.startedAt : item.elapsedMs
      if (!Number.isFinite(elapsed)) continue
      const duration = document.createElement('span')
      duration.className = 'timer-duration'
      duration.textContent = `${group.aliased ? `${source} ` : ''}${Math.max(0, elapsed / 1000).toFixed(2)} s`
      row.append(duration)
    }
    return row
  }))
  const expiringItems = items.filter(item => !item.held)
  const nextExpiry = expiringItems.length
    ? Math.min(...expiringItems.map(item => item.time + Number(settings.lifetime))) - Date.now()
    : Infinity
  const refreshDelay = items.some(item => item.held && item.timerEnabled) ? 100 : Infinity
  const nextDraw = Math.min(nextExpiry, refreshDelay)
  if (Number.isFinite(nextDraw)) cleanupTimer = setTimeout(draw, Math.max(0, nextDraw))
}

nyerk.ready.then(() => {
  Promise.resolve().then(() => nyerk.storage.get('preferences')).then(saved => {
    const preferences = saved && typeof saved === 'object' ? saved : { inputFilter: '*', aliases: {} }
    updateTimerPreferences(preferences)
    return nyerk.send('configure', preferences)
  }).catch(() => nyerk.send('configure', { inputFilter: '*', aliases: {} }))
  nyerk.on('storage', event => {
    if (event && event.key === 'preferences' && event.value && typeof event.value === 'object') {
      updateTimerPreferences(event.value)
      void nyerk.send('configure', event.value)
    }
  })
  updateSettings(nyerk.settings)
  nyerk.on('settings', updateSettings)
  nyerk.on('inputStatus', status => {
    if (status && status.reset) {
      items = items.filter(item => !item.held)
      draw()
    }
  })
  nyerk.on('input', event => {
    if (!event || typeof event.label !== 'string') return
    if ((event.kind === 'key' && settings.captureKeys === false) || (event.kind === 'mouse' && settings.captureMouse === false)) return
    const kind = event.kind === 'mouse' ? 'mouse' : 'key'
    const source = typeof event.source === 'string' ? event.source : event.label
    if (event.state === 'up') {
      const heldItem = items.find(item => item.held && item.kind === kind && (item.source || item.label) === source)
      if (heldItem && heldItem.timerEnabled) {
        heldItem.held = false
        heldItem.elapsedMs = Math.max(0, performance.now() - heldItem.startedAt)
        heldItem.time = Date.now()
      } else {
        items = items.filter(item => !(item.held && item.kind === kind && (item.source || item.label) === source))
      }
    } else if (event.state === 'down') {
      if (!items.some(item => item.held && item.kind === kind && (item.source || item.label) === source)) {
        items.unshift({ kind, label: event.label.slice(0, 48), source, aliased: source !== event.label, timerEnabled: isTimerEnabled(source), startedAt: performance.now(), held: true, time: Date.now() })
      }
    } else {
      items.unshift({ kind, label: event.label.slice(0, 48), source, aliased: source !== event.label, held: false, time: Date.now() })
    }
    draw()
  })
})
