import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mayNavigate } from '../src/main/navigation.ts'

const PANEL = 'file:///C:/Users/Player/AppData/Local/Programs/aion2-drop-tracker/resources/app.asar/out/renderer/index.html#/panel'

describe('mayNavigate', () => {
  it('lets a window reload the page it shows, on any route', () => {
    assert.equal(mayNavigate(PANEL.replace('#/panel', '#/hud'), PANEL), true)
  })

  it('refuses an HTML file dropped on the window', () => {
    assert.equal(mayNavigate('file:///C:/Users/Player/Downloads/page.html', PANEL), false)
  })

  it('refuses another page beside the app’s own', () => {
    assert.equal(mayNavigate(PANEL.replace('index.html#/panel', 'other.html'), PANEL), false)
  })

  it('refuses a web page', () => {
    assert.equal(mayNavigate('https://example.com/', PANEL), false)
  })
})
