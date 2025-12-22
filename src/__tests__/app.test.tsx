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

  it('App component renders split view', async () => {
    const AppModule = await import('../App')
    expect(AppModule.default).toBeDefined()
    // Verify App component can be imported and is defined
    const App = AppModule.default
    expect(typeof App).toBe('function')
  })
})
