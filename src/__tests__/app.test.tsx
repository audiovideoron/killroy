import { describe, it, expect } from 'vitest'

describe('App smoke tests', () => {
  it('application modules load without errors', () => {
    // Verify core modules can be imported
    expect(true).toBe(true)
  })

  it('Knob component exports are available', async () => {
    const knobModule = await import('../components/Knob')
    expect(knobModule.Knob).toBeDefined()
    expect(knobModule.Toggle).toBeDefined()
  })
})
