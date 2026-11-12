import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { autoInstallStep } from '../src/shared/update.ts'

describe('autoInstallStep', () => {
  it('leaves an installer to the player while the game is closed', () => {
    assert.equal(autoInstallStep('installer', false), 'ask')
  })

  it('leaves an installer to the player while the game runs', () => {
    assert.equal(autoInstallStep('installer', true), 'ask')
  })

  it('holds a bundle until the game closes', () => {
    assert.equal(autoInstallStep('bundle', true), 'wait-for-game')
  })

  it('installs a bundle while the game is closed', () => {
    assert.equal(autoInstallStep('bundle', false), 'restart')
  })

  it('asks when it does not know what kind of update it has', () => {
    assert.equal(autoInstallStep(null, false), 'ask')
  })
})
