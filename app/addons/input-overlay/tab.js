'use strict'

const status = document.querySelector('#status')
const show = document.querySelector('#show')
const hide = document.querySelector('#hide')
const detach = document.querySelector('#detach')
const dock = document.querySelector('#dock')
const filterCapture = document.querySelector('#filterCapture')
const filterState = document.querySelector('#filterState')
const clearFilter = document.querySelector('#clearFilter')
const allInputs = document.querySelector('#allInputs')
const inputList = document.querySelector('#inputList')
let hudPlace = null
let hookStatus = null
let lastInput = null
let preferences = { inputFilter: '*', aliases: {}, timers: {} }
let listening = false
let listenReadyAt = 0

function paint(place) {
  if (place) hudPlace = place
  const shown = hudPlace?.shown === true
  const detached = hudPlace?.detached === true
  for (const [button, active] of [[show, shown], [hide, !!hudPlace && !shown], [detach, detached], [dock, !!hudPlace && !detached]]) {
    button.classList.toggle('primary', active)
    button.setAttribute('aria-pressed', String(active))
  }
  const overlay = !hudPlace
    ? 'Overlay state is not available.'
    : !hudPlace.shown
      ? 'Overlay hidden.'
      : hudPlace.detached
        ? 'Separate overlay selected; it appears while Aion is open and Nyerk’s HUD is enabled.'
        : 'Overlay section selected; it appears while Aion is open and Nyerk’s HUD is enabled.'
  const hooks = !hookStatus
    ? 'Waiting for input hooks to start…'
    : hookStatus.state === 'active'
      ? 'Background input capture active.'
      : `Background input capture failed: ${hookStatus.detail || 'unknown error'}. Check tracker.log for details.`
  const received = lastInput
    ? `Last received: ${lastInput.kind === 'mouse' ? 'mouse' : 'key'} ${lastInput.state === 'up' ? 'released' : 'pressed'} — ${lastInput.label}.`
    : 'No input event received yet.'
  status.textContent = `${overlay} ${hooks} ${received}`
}

async function run(action, message) {
  try {
    await action()
    paint({ shown: nyerk.hud.shown, detached: nyerk.hud.detached })
    status.textContent = message
  } catch (error) {
    status.textContent = `Nyerk could not change the overlay: ${error.message || error}`
  }
}

function renderFilter() {
  filterCapture.textContent = listening
    ? 'Listening… click here or elsewhere to stop'
    : preferences.inputFilter === '*'
      ? 'All inputs'
      : preferences.inputFilter || 'No inputs selected'
  filterState.textContent = listening ? 'Listening for keys, buttons, and wheel inputs.' : 'Input capture is off.'
  renderInputRows()
}

function filterTokens() {
  if (!preferences.inputFilter || preferences.inputFilter === '*') return []
  return [...new Set(preferences.inputFilter.split(/[,;\n]+/).map(token => token.trim()).filter(Boolean))]
}

function renderInputRows() {
  inputList.replaceChildren()
  const tokens = filterTokens()
  if (!tokens.length) {
    const empty = document.createElement('p')
    empty.className = 'n-hint'
    empty.textContent = preferences.inputFilter === '*' ? 'Choose specific inputs to create aliases.' : 'Add inputs with the field above to create aliases.'
    inputList.append(empty)
    return
  }
  const entries = []
  const groups = new Map()
  for (const name of tokens) {
    const alias = preferences.aliases[name] || ''
    if (!alias) {
      entries.push({ name })
      continue
    }
    const key = alias.trim().toLowerCase()
    let group = groups.get(key)
    if (!group) {
      group = { alias, names: [] }
      groups.set(key, group)
      entries.push({ group })
    }
    group.names.push(name)
  }
  for (const entry of entries) {
    if (entry.name) {
      inputList.append(createInputRow(entry.name, false))
      continue
    }
    const box = document.createElement('section')
    box.className = 'alias-group'
    const heading = document.createElement('div')
    heading.className = 'alias-group-title'
    heading.textContent = entry.group.alias
    const rows = document.createElement('div')
    rows.className = 'alias-group-inputs'
    for (const name of entry.group.names) rows.append(createInputRow(name, true))
    box.append(heading, rows)
    inputList.append(box)
  }
}

function createInputRow(name, grouped) {
    const row = document.createElement('div')
    row.className = `input-row${grouped ? ' grouped' : ''}`
    const label = document.createElement('span')
    label.className = 'input-name'
    label.textContent = name
    const alias = preferences.aliases[name] || ''
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'n-button'
    edit.textContent = alias ? 'Edit alias' : 'Add alias'
    edit.addEventListener('click', () => openAliasEditor(row, name, alias))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'n-button'
    remove.textContent = 'Remove'
    remove.title = `Remove ${name} from the input filter`
    remove.addEventListener('click', () => {
      preferences.inputFilter = filterTokens().filter(token => token !== name).join(', ')
      delete preferences.aliases[name]
      delete preferences.timers[name]
      renderFilter()
      void savePreferences()
    })
    const timer = document.createElement('label')
    timer.className = 'timer-control'
    const timerCheckbox = document.createElement('input')
    timerCheckbox.type = 'checkbox'
    timerCheckbox.checked = preferences.timers[name] === true
    timerCheckbox.addEventListener('change', () => {
      if (timerCheckbox.checked) preferences.timers[name] = true
      else delete preferences.timers[name]
      void savePreferences()
    })
    const timerText = document.createElement('span')
    timerText.textContent = 'Timer'
    timer.append(timerCheckbox, timerText)
    if (grouped) row.append(label, edit, remove, timer)
    else {
      const shownAlias = document.createElement('span')
      shownAlias.className = 'input-alias'
      shownAlias.textContent = alias ? `→ ${alias}` : ''
      row.append(label, shownAlias, edit, remove, timer)
    }
    return row
}

function openAliasEditor(row, name, current) {
  if (row.querySelector('.alias-editor')) return
  const editor = document.createElement('div')
  editor.className = 'alias-editor'
  const field = document.createElement('input')
  field.className = 'n-input'
  field.placeholder = `Alias for ${name}`
  field.maxLength = 48
  field.value = current
  const save = document.createElement('button')
  save.type = 'button'
  save.className = 'n-button primary'
  save.textContent = 'Save'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'n-button'
  cancel.textContent = 'Cancel'
  save.addEventListener('click', () => {
    const value = field.value.trim()
    if (value) preferences.aliases[name] = value
    else delete preferences.aliases[name]
    renderFilter()
    void savePreferences()
  })
  cancel.addEventListener('click', () => renderFilter())
  editor.append(field, save, cancel)
  row.append(editor)
  field.focus()
}

async function savePreferences() {
  await nyerk.storage.set('preferences', preferences)
  await nyerk.send('configure', preferences)
}

async function setListening(on) {
  if (on === listening) return
  if (on && preferences.inputFilter === '*') {
    preferences.inputFilter = ''
    await savePreferences()
  }
  listening = on
  listenReadyAt = on ? performance.now() + 300 : 0
  renderFilter()
  await nyerk.send('listen', { on })
}

function addCapturedInput(event) {
  if (!listening || performance.now() < listenReadyAt || event.state === 'up') return
  const source = String(event.source || event.label).trim()
  if (!source) return
  const tokens = preferences.inputFilter
    ? preferences.inputFilter.split(/[,;\n]+/).map(token => token.trim()).filter(Boolean)
    : []
  if (tokens.some(token => token.toLocaleLowerCase() === source.toLocaleLowerCase())) return
  tokens.push(source)
  preferences.inputFilter = tokens.join(', ')
  renderFilter()
  void savePreferences()
}

nyerk.ready.then(() => {
  paint({ shown: nyerk.hud.shown, detached: nyerk.hud.detached })
  Promise.resolve(nyerk.storage.get('preferences')).then(saved => {
    if (saved && typeof saved === 'object') {
      preferences = { ...preferences, ...saved, aliases: normalizeAliases(saved.aliases), timers: normalizeTimers(saved.timers) }
      if (Object.hasOwn(saved, 'rgb')) {
        delete preferences.rgb
        void nyerk.storage.set('preferences', preferences)
      }
    }
    renderFilter()
    return nyerk.send('configure', preferences)
  }).catch(error => {
    filterState.textContent = `Could not load saved filter: ${error.message || error}`
  })
  nyerk.on('hud', paint)
  nyerk.on('inputStatus', value => {
    hookStatus = value
    paint()
  })
  nyerk.on('input', value => {
    if (value && typeof value.label === 'string') {
      lastInput = { kind: value.kind, label: value.label, state: value.state }
      paint()
      addCapturedInput(value)
    }
  })
  nyerk.on('storage', event => {
    if (event && event.key === 'preferences' && event.value && typeof event.value === 'object') {
      preferences = { ...preferences, ...event.value }
      preferences.aliases = normalizeAliases(event.value.aliases)
      preferences.timers = normalizeTimers(event.value.timers)
      delete preferences.rgb
      renderFilter()
    }
  })
  filterCapture.addEventListener('click', () => {
    void setListening(!listening).catch(error => {
      filterState.textContent = `Could not change capture mode: ${error.message || error}`
    })
  })
  document.addEventListener('pointerdown', event => {
    if (listening && !filterCapture.contains(event.target)) void setListening(false)
  })
  clearFilter.addEventListener('click', () => {
    preferences.inputFilter = ''
    preferences.aliases = {}
    preferences.timers = {}
    renderFilter()
    void savePreferences()
  })
  allInputs.addEventListener('click', () => {
    preferences.inputFilter = '*'
    renderFilter()
    void savePreferences()
  })
  show.addEventListener('click', () => run(() => nyerk.hud.show(true), 'Show requested. Aion must be open and Nyerk’s HUD enabled.'))
  hide.addEventListener('click', () => run(() => nyerk.hud.show(false), 'Hide requested.'))
  detach.addEventListener('click', () => run(async () => {
    await nyerk.hud.show(true)
    await nyerk.hud.detach(true)
  }, 'Separate overlay requested. Open Nyerk’s panel to enter HUD move mode and drag it.'))
  dock.addEventListener('click', () => run(() => nyerk.hud.detach(false), 'Dock in HUD requested.'))
})

function normalizeAliases(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...value }
  const aliases = {}
  for (const entry of String(value || '').split(/[,;\n]+/)) {
    const [name, alias] = entry.split(/=(.*)/s)
    if (name && alias) aliases[name.trim()] = alias.trim()
  }
  return aliases
}

function normalizeTimers(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([name, enabled]) => name.trim() && enabled === true))
}


