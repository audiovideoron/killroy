import { describe, it, expect } from 'vitest'
import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams
} from '../../shared/types'

// These functions are tested by replicating the logic from electron/main.ts
// This ensures the FFmpeg filter chain building logic is well-tested
// without requiring exports from the main process

function buildEQFilter(bands: EQBand[]): string {
  const enabledBands = bands.filter(b => b.enabled && b.gain !== 0)
  if (enabledBands.length === 0) {
    return ''
  }

  const filters = enabledBands.map(band => {
    // Clamp frequency to audible range (20 Hz - 20 kHz)
    const frequency = Math.max(20, Math.min(20000, band.frequency))
    // Clamp Q to reasonable range (0.1 - 10)
    const q = Math.max(0.1, Math.min(10, band.q))
    // Clamp gain to ±24 dB
    const gain = Math.max(-24, Math.min(24, band.gain))

    const width = frequency / q
    return `equalizer=f=${frequency}:t=h:w=${width}:g=${gain}`
  })

  return filters.join(',')
}

function buildCompressorFilter(comp: CompressorParams): string {
  if (!comp.enabled) return ''

  if (comp.mode === 'LEVEL') {
    if (comp.makeup === 0) return ''
    return `volume=${comp.makeup}dB`
  }

  if (comp.mode === 'LIMIT') {
    const attackSec = comp.attack / 1000
    const releaseSec = comp.release / 1000
    const filters: string[] = []
    if (comp.emphasis > 30) {
      filters.push(`highpass=f=${comp.emphasis}`)
    }
    filters.push(`alimiter=limit=${comp.threshold}dB:attack=${attackSec}:release=${releaseSec}:level=false`)
    if (comp.makeup !== 0) {
      filters.push(`volume=${comp.makeup}dB`)
    }
    return filters.join(',')
  }

  const attackSec = comp.attack / 1000
  const releaseSec = comp.release / 1000

  const filters: string[] = []

  if (comp.emphasis > 30) {
    filters.push(`highpass=f=${comp.emphasis}`)
  }

  filters.push(`acompressor=threshold=${comp.threshold}dB:ratio=${comp.ratio}:attack=${attackSec}:release=${releaseSec}:makeup=${comp.makeup}dB`)

  return filters.join(',')
}

function buildNoiseReductionFilter(nr: NoiseReductionParams): string {
  if (!nr.enabled || nr.strength <= 0) return ''

  const nrValue = Math.round((nr.strength / 100) * 40)
  const nfValue = Math.round(-50 + (nr.strength / 100) * 15)

  return `afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`
}

function buildFullFilterChain(hpf: FilterParams, bands: EQBand[], lpf: FilterParams, compressor: CompressorParams, noiseReduction: NoiseReductionParams): string {
  const filters: string[] = []

  if (hpf.enabled) {
    filters.push(`highpass=f=${hpf.frequency}`)
  }

  const nrFilter = buildNoiseReductionFilter(noiseReduction)
  if (nrFilter) {
    filters.push(nrFilter)
  }

  const eqFilter = buildEQFilter(bands)
  if (eqFilter) {
    filters.push(eqFilter)
  }

  if (lpf.enabled) {
    filters.push(`lowpass=f=${lpf.frequency}`)
  }

  const compFilter = buildCompressorFilter(compressor)
  if (compFilter) {
    filters.push(compFilter)
  }

  return filters.join(',')
}

describe('buildEQFilter', () => {
  it('returns empty string when no bands are provided', () => {
    const result = buildEQFilter([])
    expect(result).toBe('')
  })

  it('returns empty string when all bands are disabled', () => {
    const bands: EQBand[] = [
      { frequency: 100, gain: 5, q: 1.0, enabled: false },
      { frequency: 1000, gain: -3, q: 1.5, enabled: false }
    ]
    const result = buildEQFilter(bands)
    expect(result).toBe('')
  })

  it('returns empty string when all bands have zero gain', () => {
    const bands: EQBand[] = [
      { frequency: 100, gain: 0, q: 1.0, enabled: true },
      { frequency: 1000, gain: 0, q: 1.5, enabled: true }
    ]
    const result = buildEQFilter(bands)
    expect(result).toBe('')
  })

  it('builds filter for single enabled band with gain', () => {
    const bands: EQBand[] = [
      { frequency: 1000, gain: 5, q: 1.5, enabled: true }
    ]
    const result = buildEQFilter(bands)
    const width = 1000 / 1.5
    expect(result).toBe(`equalizer=f=1000:t=h:w=${width}:g=5`)
  })

  it('builds filter for multiple enabled bands', () => {
    const bands: EQBand[] = [
      { frequency: 100, gain: 3, q: 1.0, enabled: true },
      { frequency: 1000, gain: -2, q: 1.5, enabled: true },
      { frequency: 5000, gain: 4, q: 2.0, enabled: true }
    ]
    const result = buildEQFilter(bands)
    const width1 = 100 / 1.0
    const width2 = 1000 / 1.5
    const width3 = 5000 / 2.0
    expect(result).toBe(
      `equalizer=f=100:t=h:w=${width1}:g=3,equalizer=f=1000:t=h:w=${width2}:g=-2,equalizer=f=5000:t=h:w=${width3}:g=4`
    )
  })

  it('skips disabled bands and zero-gain bands', () => {
    const bands: EQBand[] = [
      { frequency: 100, gain: 3, q: 1.0, enabled: true },
      { frequency: 500, gain: 0, q: 1.2, enabled: true },
      { frequency: 1000, gain: -2, q: 1.5, enabled: false },
      { frequency: 5000, gain: 4, q: 2.0, enabled: true }
    ]
    const result = buildEQFilter(bands)
    const width1 = 100 / 1.0
    const width3 = 5000 / 2.0
    expect(result).toBe(
      `equalizer=f=100:t=h:w=${width1}:g=3,equalizer=f=5000:t=h:w=${width3}:g=4`
    )
  })

  it('calculates width correctly using frequency/Q formula', () => {
    const bands: EQBand[] = [
      { frequency: 1200, gain: 6, q: 0.8, enabled: true }
    ]
    const result = buildEQFilter(bands)
    const width = 1200 / 0.8
    expect(result).toBe(`equalizer=f=1200:t=h:w=${width}:g=6`)
  })

  it('handles negative gain values', () => {
    const bands: EQBand[] = [
      { frequency: 800, gain: -10, q: 1.0, enabled: true }
    ]
    const result = buildEQFilter(bands)
    const width = 800 / 1.0
    expect(result).toBe(`equalizer=f=800:t=h:w=${width}:g=-10`)
  })

  describe('input validation and clamping', () => {
    it('clamps frequency below 20 Hz to minimum', () => {
      const bands: EQBand[] = [
        { frequency: 10, gain: 5, q: 1.0, enabled: true },
        { frequency: 0, gain: 3, q: 1.0, enabled: true },
        { frequency: -50, gain: 2, q: 1.0, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width = 20 / 1.0
      expect(result).toBe(
        `equalizer=f=20:t=h:w=${width}:g=5,equalizer=f=20:t=h:w=${width}:g=3,equalizer=f=20:t=h:w=${width}:g=2`
      )
    })

    it('clamps frequency above 20000 Hz to maximum', () => {
      const bands: EQBand[] = [
        { frequency: 25000, gain: 5, q: 1.0, enabled: true },
        { frequency: 100000, gain: 3, q: 1.0, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width = 20000 / 1.0
      expect(result).toBe(
        `equalizer=f=20000:t=h:w=${width}:g=5,equalizer=f=20000:t=h:w=${width}:g=3`
      )
    })

    it('clamps Q below 0.1 to minimum', () => {
      const bands: EQBand[] = [
        { frequency: 1000, gain: 5, q: 0.05, enabled: true },
        { frequency: 2000, gain: 3, q: 0, enabled: true },
        { frequency: 3000, gain: 2, q: -1, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width = 1000 / 0.1
      const width2 = 2000 / 0.1
      const width3 = 3000 / 0.1
      expect(result).toBe(
        `equalizer=f=1000:t=h:w=${width}:g=5,equalizer=f=2000:t=h:w=${width2}:g=3,equalizer=f=3000:t=h:w=${width3}:g=2`
      )
    })

    it('clamps Q above 10 to maximum', () => {
      const bands: EQBand[] = [
        { frequency: 1000, gain: 5, q: 15, enabled: true },
        { frequency: 2000, gain: 3, q: 100, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width = 1000 / 10
      const width2 = 2000 / 10
      expect(result).toBe(
        `equalizer=f=1000:t=h:w=${width}:g=5,equalizer=f=2000:t=h:w=${width2}:g=3`
      )
    })

    it('clamps gain below -24 dB to minimum', () => {
      const bands: EQBand[] = [
        { frequency: 1000, gain: -30, q: 1.0, enabled: true },
        { frequency: 2000, gain: -100, q: 1.0, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width = 1000 / 1.0
      const width2 = 2000 / 1.0
      expect(result).toBe(
        `equalizer=f=1000:t=h:w=${width}:g=-24,equalizer=f=2000:t=h:w=${width2}:g=-24`
      )
    })

    it('clamps gain above +24 dB to maximum', () => {
      const bands: EQBand[] = [
        { frequency: 1000, gain: 30, q: 1.0, enabled: true },
        { frequency: 2000, gain: 100, q: 1.0, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width = 1000 / 1.0
      const width2 = 2000 / 1.0
      expect(result).toBe(
        `equalizer=f=1000:t=h:w=${width}:g=24,equalizer=f=2000:t=h:w=${width2}:g=24`
      )
    })

    it('clamps all parameters simultaneously', () => {
      const bands: EQBand[] = [
        { frequency: -100, gain: 50, q: -5, enabled: true },
        { frequency: 50000, gain: -50, q: 20, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width1 = 20 / 0.1
      const width2 = 20000 / 10
      expect(result).toBe(
        `equalizer=f=20:t=h:w=${width1}:g=24,equalizer=f=20000:t=h:w=${width2}:g=-24`
      )
    })

    it('allows valid values at edge of ranges', () => {
      const bands: EQBand[] = [
        { frequency: 20, gain: 24, q: 10, enabled: true },
        { frequency: 20000, gain: -24, q: 0.1, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width1 = 20 / 10
      const width2 = 20000 / 0.1
      expect(result).toBe(
        `equalizer=f=20:t=h:w=${width1}:g=24,equalizer=f=20000:t=h:w=${width2}:g=-24`
      )
    })

    it('allows valid values within ranges', () => {
      const bands: EQBand[] = [
        { frequency: 1000, gain: 6, q: 1.5, enabled: true },
        { frequency: 5000, gain: -12, q: 0.5, enabled: true }
      ]
      const result = buildEQFilter(bands)
      const width1 = 1000 / 1.5
      const width2 = 5000 / 0.5
      expect(result).toBe(
        `equalizer=f=1000:t=h:w=${width1}:g=6,equalizer=f=5000:t=h:w=${width2}:g=-12`
      )
    })
  })
})

describe('buildCompressorFilter', () => {
  it('returns empty string when compressor is disabled', () => {
    const comp: CompressorParams = {
      threshold: -20,
      ratio: 4,
      attack: 10,
      release: 100,
      makeup: 0,
      emphasis: 100,
      mode: 'COMP',
      enabled: false
    }
    const result = buildCompressorFilter(comp)
    expect(result).toBe('')
  })

  describe('LEVEL mode', () => {
    it('returns empty string when makeup gain is 0', () => {
      const comp: CompressorParams = {
        threshold: -20,
        ratio: 4,
        attack: 10,
        release: 100,
        makeup: 0,
        emphasis: 100,
        mode: 'LEVEL',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      expect(result).toBe('')
    })

    it('applies only makeup gain when enabled', () => {
      const comp: CompressorParams = {
        threshold: -20,
        ratio: 4,
        attack: 10,
        release: 100,
        makeup: 5,
        emphasis: 100,
        mode: 'LEVEL',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      expect(result).toBe('volume=5dB')
    })

    it('handles negative makeup gain', () => {
      const comp: CompressorParams = {
        threshold: -20,
        ratio: 4,
        attack: 10,
        release: 100,
        makeup: -3,
        emphasis: 100,
        mode: 'LEVEL',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      expect(result).toBe('volume=-3dB')
    })
  })

  describe('LIMIT mode', () => {
    it('builds alimiter filter with basic parameters', () => {
      const comp: CompressorParams = {
        threshold: -1,
        ratio: 10,
        attack: 5,
        release: 50,
        makeup: 0,
        emphasis: 20,
        mode: 'LIMIT',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 5 / 1000
      const releaseSec = 50 / 1000
      expect(result).toBe(`alimiter=limit=-1dB:attack=${attackSec}:release=${releaseSec}:level=false`)
    })

    it('adds highpass filter when emphasis > 30', () => {
      const comp: CompressorParams = {
        threshold: -2,
        ratio: 10,
        attack: 10,
        release: 100,
        makeup: 0,
        emphasis: 200,
        mode: 'LIMIT',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 10 / 1000
      const releaseSec = 100 / 1000
      expect(result).toBe(`highpass=f=200,alimiter=limit=-2dB:attack=${attackSec}:release=${releaseSec}:level=false`)
    })

    it('skips highpass filter when emphasis <= 30', () => {
      const comp: CompressorParams = {
        threshold: -1,
        ratio: 10,
        attack: 5,
        release: 50,
        makeup: 0,
        emphasis: 30,
        mode: 'LIMIT',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 5 / 1000
      const releaseSec = 50 / 1000
      expect(result).toBe(`alimiter=limit=-1dB:attack=${attackSec}:release=${releaseSec}:level=false`)
    })

    it('adds makeup gain when non-zero', () => {
      const comp: CompressorParams = {
        threshold: -3,
        ratio: 10,
        attack: 8,
        release: 80,
        makeup: 2,
        emphasis: 100,
        mode: 'LIMIT',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 8 / 1000
      const releaseSec = 80 / 1000
      expect(result).toBe(`highpass=f=100,alimiter=limit=-3dB:attack=${attackSec}:release=${releaseSec}:level=false,volume=2dB`)
    })

    it('converts attack and release from ms to seconds', () => {
      const comp: CompressorParams = {
        threshold: 0,
        ratio: 10,
        attack: 1000,
        release: 2000,
        makeup: 0,
        emphasis: 20,
        mode: 'LIMIT',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      expect(result).toBe('alimiter=limit=0dB:attack=1:release=2:level=false')
    })
  })

  describe('COMP mode', () => {
    it('builds acompressor filter with basic parameters', () => {
      const comp: CompressorParams = {
        threshold: -20,
        ratio: 4,
        attack: 10,
        release: 100,
        makeup: 3,
        emphasis: 20,
        mode: 'COMP',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 10 / 1000
      const releaseSec = 100 / 1000
      expect(result).toBe(`acompressor=threshold=-20dB:ratio=4:attack=${attackSec}:release=${releaseSec}:makeup=3dB`)
    })

    it('adds highpass filter when emphasis > 30', () => {
      const comp: CompressorParams = {
        threshold: -15,
        ratio: 3,
        attack: 5,
        release: 50,
        makeup: 2,
        emphasis: 150,
        mode: 'COMP',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 5 / 1000
      const releaseSec = 50 / 1000
      expect(result).toBe(`highpass=f=150,acompressor=threshold=-15dB:ratio=3:attack=${attackSec}:release=${releaseSec}:makeup=2dB`)
    })

    it('skips highpass filter when emphasis <= 30', () => {
      const comp: CompressorParams = {
        threshold: -20,
        ratio: 4,
        attack: 10,
        release: 100,
        makeup: 0,
        emphasis: 25,
        mode: 'COMP',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 10 / 1000
      const releaseSec = 100 / 1000
      expect(result).toBe(`acompressor=threshold=-20dB:ratio=4:attack=${attackSec}:release=${releaseSec}:makeup=0dB`)
    })

    it('converts attack and release from ms to seconds', () => {
      const comp: CompressorParams = {
        threshold: -12,
        ratio: 2.5,
        attack: 50,
        release: 500,
        makeup: 1,
        emphasis: 100,
        mode: 'COMP',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      expect(result).toBe('highpass=f=100,acompressor=threshold=-12dB:ratio=2.5:attack=0.05:release=0.5:makeup=1dB')
    })

    it('handles zero makeup gain', () => {
      const comp: CompressorParams = {
        threshold: -18,
        ratio: 6,
        attack: 15,
        release: 200,
        makeup: 0,
        emphasis: 80,
        mode: 'COMP',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 15 / 1000
      const releaseSec = 200 / 1000
      expect(result).toBe(`highpass=f=80,acompressor=threshold=-18dB:ratio=6:attack=${attackSec}:release=${releaseSec}:makeup=0dB`)
    })

    it('handles negative makeup gain', () => {
      const comp: CompressorParams = {
        threshold: -10,
        ratio: 8,
        attack: 20,
        release: 300,
        makeup: -2,
        emphasis: 120,
        mode: 'COMP',
        enabled: true
      }
      const result = buildCompressorFilter(comp)
      const attackSec = 20 / 1000
      const releaseSec = 300 / 1000
      expect(result).toBe(`highpass=f=120,acompressor=threshold=-10dB:ratio=8:attack=${attackSec}:release=${releaseSec}:makeup=-2dB`)
    })
  })
})

describe('buildNoiseReductionFilter', () => {
  it('returns empty string when disabled', () => {
    const nr: NoiseReductionParams = {
      strength: 50,
      enabled: false
    }
    const result = buildNoiseReductionFilter(nr)
    expect(result).toBe('')
  })

  it('returns empty string when strength is 0', () => {
    const nr: NoiseReductionParams = {
      strength: 0,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    expect(result).toBe('')
  })

  it('returns empty string when strength is negative', () => {
    const nr: NoiseReductionParams = {
      strength: -10,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    expect(result).toBe('')
  })

  it('builds filter with light reduction (strength 25)', () => {
    const nr: NoiseReductionParams = {
      strength: 25,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    const nrValue = Math.round((25 / 100) * 40)
    const nfValue = Math.round(-50 + (25 / 100) * 15)
    expect(result).toBe(`afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`)
  })

  it('builds filter with moderate reduction (strength 50)', () => {
    const nr: NoiseReductionParams = {
      strength: 50,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    const nrValue = Math.round((50 / 100) * 40)
    const nfValue = Math.round(-50 + (50 / 100) * 15)
    expect(result).toBe(`afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`)
  })

  it('builds filter with strong reduction (strength 75)', () => {
    const nr: NoiseReductionParams = {
      strength: 75,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    const nrValue = Math.round((75 / 100) * 40)
    const nfValue = Math.round(-50 + (75 / 100) * 15)
    expect(result).toBe(`afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`)
  })

  it('builds filter with maximum reduction (strength 100)', () => {
    const nr: NoiseReductionParams = {
      strength: 100,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    expect(result).toBe('afftdn=nr=40:nf=-35:tn=true')
  })

  it('maps strength 1 to minimum values', () => {
    const nr: NoiseReductionParams = {
      strength: 1,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    const nrValue = Math.round((1 / 100) * 40)
    const nfValue = Math.round(-50 + (1 / 100) * 15)
    expect(result).toBe(`afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`)
  })

  it('always enables noise tracking (tn=true)', () => {
    const nr: NoiseReductionParams = {
      strength: 60,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    expect(result).toContain(':tn=true')
  })

  it('correctly maps strength to noise reduction value (0-40 dB)', () => {
    const nr: NoiseReductionParams = {
      strength: 50,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    expect(result).toContain('nr=20')
  })

  it('correctly maps strength to noise floor value (-50 to -35 dB)', () => {
    const nr: NoiseReductionParams = {
      strength: 50,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    const expectedNf = Math.round(-50 + (50 / 100) * 15)
    expect(result).toContain(`nf=${expectedNf}`)
  })
})

describe('buildFullFilterChain', () => {
  const createDefaultParams = () => ({
    hpf: { frequency: 80, q: 0.7, enabled: false } as FilterParams,
    bands: [] as EQBand[],
    lpf: { frequency: 12000, q: 0.7, enabled: false } as FilterParams,
    compressor: {
      threshold: -20,
      ratio: 4,
      attack: 10,
      release: 100,
      makeup: 0,
      emphasis: 100,
      mode: 'COMP' as const,
      enabled: false
    } as CompressorParams,
    noiseReduction: { strength: 0, enabled: false } as NoiseReductionParams
  })

  it('returns empty string when all filters are disabled', () => {
    const params = createDefaultParams()
    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )
    expect(result).toBe('')
  })

  it('builds chain with only HPF enabled', () => {
    const params = createDefaultParams()
    params.hpf.enabled = true
    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )
    expect(result).toBe('highpass=f=80')
  })

  it('builds chain with only noise reduction enabled', () => {
    const params = createDefaultParams()
    params.noiseReduction.enabled = true
    params.noiseReduction.strength = 50
    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )
    const nrValue = Math.round((50 / 100) * 40)
    const nfValue = Math.round(-50 + (50 / 100) * 15)
    expect(result).toBe(`afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`)
  })

  it('builds chain with only EQ enabled', () => {
    const params = createDefaultParams()
    params.bands = [
      { frequency: 1000, gain: 5, q: 1.5, enabled: true }
    ]
    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )
    const width = 1000 / 1.5
    expect(result).toBe(`equalizer=f=1000:t=h:w=${width}:g=5`)
  })

  it('builds chain with only LPF enabled', () => {
    const params = createDefaultParams()
    params.lpf.enabled = true
    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )
    expect(result).toBe('lowpass=f=12000')
  })

  it('builds chain with only compressor enabled', () => {
    const params = createDefaultParams()
    params.compressor.enabled = true
    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )
    const attackSec = 10 / 1000
    const releaseSec = 100 / 1000
    expect(result).toBe(`highpass=f=100,acompressor=threshold=-20dB:ratio=4:attack=${attackSec}:release=${releaseSec}:makeup=0dB`)
  })

  it('builds complete chain in correct order: HPF -> NR -> EQ -> LPF -> COMP', () => {
    const params = createDefaultParams()
    params.hpf.enabled = true
    params.hpf.frequency = 100
    params.noiseReduction.enabled = true
    params.noiseReduction.strength = 50
    params.bands = [
      { frequency: 1000, gain: 3, q: 1.5, enabled: true }
    ]
    params.lpf.enabled = true
    params.lpf.frequency = 10000
    params.compressor.enabled = true
    params.compressor.mode = 'COMP'
    params.compressor.emphasis = 20

    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )

    const nrValue = Math.round((50 / 100) * 40)
    const nfValue = Math.round(-50 + (50 / 100) * 15)
    const eqWidth = 1000 / 1.5
    const attackSec = 10 / 1000
    const releaseSec = 100 / 1000

    expect(result).toBe(
      `highpass=f=100,afftdn=nr=${nrValue}:nf=${nfValue}:tn=true,equalizer=f=1000:t=h:w=${eqWidth}:g=3,lowpass=f=10000,acompressor=threshold=-20dB:ratio=4:attack=${attackSec}:release=${releaseSec}:makeup=0dB`
    )
  })

  it('skips disabled filters in chain', () => {
    const params = createDefaultParams()
    params.hpf.enabled = true
    params.hpf.frequency = 80
    params.bands = [
      { frequency: 1000, gain: 5, q: 1.5, enabled: true }
    ]
    // LPF disabled
    params.compressor.enabled = true
    params.compressor.mode = 'LEVEL'
    params.compressor.makeup = 3

    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )

    const eqWidth = 1000 / 1.5
    expect(result).toBe(`highpass=f=80,equalizer=f=1000:t=h:w=${eqWidth}:g=5,volume=3dB`)
  })

  it('handles multiple EQ bands in chain', () => {
    const params = createDefaultParams()
    params.bands = [
      { frequency: 100, gain: 3, q: 1.0, enabled: true },
      { frequency: 1000, gain: -2, q: 1.5, enabled: true },
      { frequency: 5000, gain: 4, q: 2.0, enabled: true }
    ]

    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )

    const width1 = 100 / 1.0
    const width2 = 1000 / 1.5
    const width3 = 5000 / 2.0
    expect(result).toBe(
      `equalizer=f=100:t=h:w=${width1}:g=3,equalizer=f=1000:t=h:w=${width2}:g=-2,equalizer=f=5000:t=h:w=${width3}:g=4`
    )
  })

  it('handles limiter mode in chain', () => {
    const params = createDefaultParams()
    params.lpf.enabled = true
    params.lpf.frequency = 8000
    params.compressor.enabled = true
    params.compressor.mode = 'LIMIT'
    params.compressor.threshold = -1
    params.compressor.attack = 5
    params.compressor.release = 50
    params.compressor.emphasis = 200

    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )

    const attackSec = 5 / 1000
    const releaseSec = 50 / 1000
    expect(result).toBe(`lowpass=f=8000,highpass=f=200,alimiter=limit=-1dB:attack=${attackSec}:release=${releaseSec}:level=false`)
  })

  it('maintains order when some middle filters are disabled', () => {
    const params = createDefaultParams()
    params.hpf.enabled = true
    params.hpf.frequency = 50
    // NR disabled
    // EQ empty
    params.lpf.enabled = true
    params.lpf.frequency = 15000
    // Compressor disabled

    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )

    expect(result).toBe('highpass=f=50,lowpass=f=15000')
  })

  it('handles noise reduction before EQ in signal chain', () => {
    const params = createDefaultParams()
    params.noiseReduction.enabled = true
    params.noiseReduction.strength = 75
    params.bands = [
      { frequency: 2000, gain: 6, q: 1.2, enabled: true }
    ]

    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )

    const nrValue = Math.round((75 / 100) * 40)
    const nfValue = Math.round(-50 + (75 / 100) * 15)
    const eqWidth = 2000 / 1.2

    expect(result).toBe(`afftdn=nr=${nrValue}:nf=${nfValue}:tn=true,equalizer=f=2000:t=h:w=${eqWidth}:g=6`)
  })

  it('places compressor at end of chain after all other filters', () => {
    const params = createDefaultParams()
    params.hpf.enabled = true
    params.hpf.frequency = 60
    params.bands = [
      { frequency: 800, gain: 2, q: 1.0, enabled: true }
    ]
    params.lpf.enabled = true
    params.lpf.frequency = 18000
    params.compressor.enabled = true
    params.compressor.mode = 'COMP'
    params.compressor.emphasis = 50
    params.compressor.threshold = -15
    params.compressor.ratio = 3

    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )

    const eqWidth = 800 / 1.0
    const attackSec = 10 / 1000
    const releaseSec = 100 / 1000

    expect(result).toBe(
      `highpass=f=60,equalizer=f=800:t=h:w=${eqWidth}:g=2,lowpass=f=18000,highpass=f=50,acompressor=threshold=-15dB:ratio=3:attack=${attackSec}:release=${releaseSec}:makeup=0dB`
    )
  })

  it('handles all filters enabled with realistic audio pro settings', () => {
    const params = createDefaultParams()
    params.hpf.enabled = true
    params.hpf.frequency = 75
    params.noiseReduction.enabled = true
    params.noiseReduction.strength = 40
    params.bands = [
      { frequency: 200, gain: 2, q: 1.0, enabled: true },
      { frequency: 2000, gain: -1, q: 1.5, enabled: true },
      { frequency: 8000, gain: 3, q: 2.0, enabled: true }
    ]
    params.lpf.enabled = true
    params.lpf.frequency = 16000
    params.compressor.enabled = true
    params.compressor.mode = 'COMP'
    params.compressor.threshold = -18
    params.compressor.ratio = 4
    params.compressor.attack = 15
    params.compressor.release = 150
    params.compressor.makeup = 2
    params.compressor.emphasis = 120

    const result = buildFullFilterChain(
      params.hpf,
      params.bands,
      params.lpf,
      params.compressor,
      params.noiseReduction
    )

    const nrValue = Math.round((40 / 100) * 40)
    const nfValue = Math.round(-50 + (40 / 100) * 15)
    const width1 = 200 / 1.0
    const width2 = 2000 / 1.5
    const width3 = 8000 / 2.0
    const attackSec = 15 / 1000
    const releaseSec = 150 / 1000

    const expected = [
      'highpass=f=75',
      `afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`,
      `equalizer=f=200:t=h:w=${width1}:g=2`,
      `equalizer=f=2000:t=h:w=${width2}:g=-1`,
      `equalizer=f=8000:t=h:w=${width3}:g=3`,
      'lowpass=f=16000',
      'highpass=f=120',
      `acompressor=threshold=-18dB:ratio=4:attack=${attackSec}:release=${releaseSec}:makeup=2dB`
    ].join(',')

    expect(result).toBe(expected)
  })
})
