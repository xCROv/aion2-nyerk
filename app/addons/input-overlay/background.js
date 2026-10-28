// Make enabling the addon enough to show its HUD. The Inputs tab can still hide or dock it.
nyerk.ready.then(() => {
  if (nyerk.hud.shown !== true) void nyerk.hud.show(true)
  const sync = value => {
    if (value && typeof value === 'object') void nyerk.send('configure', value)
  }
  nyerk.storage.get('preferences').then(value => sync(value || { inputFilter: '*', aliases: '' }))
  nyerk.on('storage', event => {
    if (event && event.key === 'preferences') sync(event.value)
  })
})
