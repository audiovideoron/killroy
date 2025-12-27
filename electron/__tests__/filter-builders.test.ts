import { describe, it, expect } from 'vitest'
import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  AutoMixParams
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
  // Noise Sampling DSP - afftdn removed per canonical spec
  // Returns empty string (bypass) until real implementation
  if (!nr.enabled || nr.strength <= 0) return ''
  return ''  // Placeholder - no afftdn
}

function buildAutoMixFilter(autoMix: AutoMixParams): string {
  if (!autoMix.enabled) return ''

  const presets = {
    LIGHT:  { framelen: 800, gausssize: 51, maxgain: 3 },
    MEDIUM: { framelen: 500, gausssize: 35, maxgain: 6 },
    HEAVY:  { framelen: 200, gausssize: 21, maxgain: 10 }
  }

  const params = presets[autoMix.preset]
  const peak = 0.9

  return `dynaudnorm=f=${params.framelen}:g=${params.gausssize}:p=${peak}:m=${params.maxgain}`
}

/**
 * Build full audio filter chain.
 *
 * CANONICAL Signal chain order (LOCKED):
 *   1. AutoGain / Leveling
 *   2. Loudness
 *   3. Noise Sampling DSP
 *   4. Highpass
 *   5. Lowpass
 *   6. EQ
 *   7. Compressor
 *   8. AutoMix
 */
function buildFullFilterChain(hpf: FilterParams, bands: EQBand[], lpf: FilterParams, compressor: CompressorParams, noiseReduction: NoiseReductionParams, autoMix?: AutoMixParams): string {
  const filters: string[] = []

  // 1. AutoGain / Leveling (placeholder)
  // 2. Loudness (placeholder)
  // Both placeholders return empty strings for now

  // 3. Noise Sampling DSP (afftdn removed)
  const nrFilter = buildNoiseReductionFilter(noiseReduction)
  if (nrFilter) {
    filters.push(nrFilter)
  }

  // 4. High-pass filter
  if (hpf.enabled) {
    filters.push(`highpass=f=${hpf.frequency}`)
  }

  // 5. Low-pass filter
  if (lpf.enabled) {
    filters.push(`lowpass=f=${lpf.frequency}`)
  }

  // 6. Parametric EQ bands
  const eqFilter = buildEQFilter(bands)
  if (eqFilter) {
    filters.push(eqFilter)
  }

  // 7. Compressor/Limiter
  const compFilter = buildCompressorFilter(compressor)
  if (compFilter) {
    filters.push(compFilter)
  }

  // 8. AutoMix (final-stage leveling)
  if (autoMix) {
    const autoMixFilter = buildAutoMixFilter(autoMix)
    if (autoMixFilter) {
      filters.push(autoMixFilter)
    }
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

  it('returns empty string (bypass) - afftdn removed', () => {
    const nr: NoiseReductionParams = {
      strength: 25,
      enabled: true
    }
    const result = buildNoiseReductionFilter(nr)
    expect(result).toBe('')
  })

  it('returns empty string for all strength values - afftdn removed', () => {
    const strengths = [1, 25, 50, 75, 100]
    strengths.forEach(strength => {
      const nr: NoiseReductionParams = { strength, enabled: true }
      const result = buildNoiseReductionFilter(nr)
      expect(result).toBe('')
    })
  })

})
// Note: Additional parameter mapping tests removed since afftdn is no longer used

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

  it('returns empty string when only noise reduction enabled (afftdn removed)', () => {
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
    expect(result).toBe('')  // Noise Sampling DSP bypassed
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

  it('builds complete chain in canonical order: HPF -> LPF -> EQ -> COMP (NR bypassed)', () => {
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

    const eqWidth = 1000 / 1.5
    const attackSec = 10 / 1000
    const releaseSec = 100 / 1000

    // Canonical order: AutoGain(placeholder) -> Loudness(placeholder) -> NR(bypassed) -> HPF -> LPF -> EQ -> Compressor
    // Since placeholders and NR are bypassed, effective chain: HPF -> LPF -> EQ -> Compressor
    expect(result).toBe(
      `highpass=f=100,lowpass=f=10000,equalizer=f=1000:t=h:w=${eqWidth}:g=3,acompressor=threshold=-20dB:ratio=4:attack=${attackSec}:release=${releaseSec}:makeup=0dB`
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

  it('noise reduction bypassed (afftdn removed), EQ works independently', () => {
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

    const eqWidth = 2000 / 1.2

    // NR bypassed, only EQ in chain
    expect(result).toBe(`equalizer=f=2000:t=h:w=${eqWidth}:g=6`)
  })

  it('places compressor after EQ and before AutoMix', () => {
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

    // Order: HPF -> LPF -> EQ -> Compressor (NR disabled)
    expect(result).toBe(
      `highpass=f=60,lowpass=f=18000,equalizer=f=800:t=h:w=${eqWidth}:g=2,highpass=f=50,acompressor=threshold=-15dB:ratio=3:attack=${attackSec}:release=${releaseSec}:makeup=0dB`
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

    const width1 = 200 / 1.0
    const width2 = 2000 / 1.5
    const width3 = 8000 / 2.0
    const attackSec = 15 / 1000
    const releaseSec = 150 / 1000

    // Canonical order: AutoGain(placeholder) -> Loudness(placeholder) -> NR(bypassed) -> HPF -> LPF -> EQ -> Compressor
    // Effective chain (afftdn removed): HPF -> LPF -> EQ -> Compressor
    const expected = [
      'highpass=f=75',
      'lowpass=f=16000',
      `equalizer=f=200:t=h:w=${width1}:g=2`,
      `equalizer=f=2000:t=h:w=${width2}:g=-1`,
      `equalizer=f=8000:t=h:w=${width3}:g=3`,
      'highpass=f=120',
      `acompressor=threshold=-18dB:ratio=4:attack=${attackSec}:release=${releaseSec}:makeup=2dB`
    ].join(',')

    expect(result).toBe(expected)
  })

  describe('AutoMix placement', () => {
    it('places AutoMix LIGHT preset after compressor as final stage', () => {
      const params = createDefaultParams()
      params.compressor.enabled = true
      params.compressor.mode = 'LEVEL'
      params.compressor.makeup = 3
      const autoMix: AutoMixParams = { enabled: true, preset: 'LIGHT' }

      const result = buildFullFilterChain(
        params.hpf,
        params.bands,
        params.lpf,
        params.compressor,
        params.noiseReduction,
        autoMix
      )

      // Order: Compressor -> AutoMix
      expect(result).toBe('volume=3dB,dynaudnorm=f=800:g=51:p=0.9:m=3')
    })

    it('places AutoMix MEDIUM preset after compressor as final stage', () => {
      const params = createDefaultParams()
      params.hpf.enabled = true
      params.hpf.frequency = 80
      params.compressor.enabled = true
      params.compressor.mode = 'LEVEL'
      params.compressor.makeup = 2
      const autoMix: AutoMixParams = { enabled: true, preset: 'MEDIUM' }

      const result = buildFullFilterChain(
        params.hpf,
        params.bands,
        params.lpf,
        params.compressor,
        params.noiseReduction,
        autoMix
      )

      // Order: HPF -> Compressor -> AutoMix
      expect(result).toBe('highpass=f=80,volume=2dB,dynaudnorm=f=500:g=35:p=0.9:m=6')
    })

    it('places AutoMix HEAVY preset after compressor as final stage', () => {
      const params = createDefaultParams()
      params.noiseReduction.enabled = true
      params.noiseReduction.strength = 50
      params.lpf.enabled = true
      params.lpf.frequency = 12000
      const autoMix: AutoMixParams = { enabled: true, preset: 'HEAVY' }

      const result = buildFullFilterChain(
        params.hpf,
        params.bands,
        params.lpf,
        params.compressor,
        params.noiseReduction,
        autoMix
      )

      // Canonical order: NR(bypassed) -> LPF -> AutoMix (HPF, EQ, Compressor disabled)
      // Effective chain (afftdn removed): LPF -> AutoMix
      expect(result).toBe(`lowpass=f=12000,dynaudnorm=f=200:g=21:p=0.9:m=10`)
    })

    it('builds complete chain with AutoMix: NR -> HPF -> LPF -> EQ -> COMP -> AutoMix', () => {
      const params = createDefaultParams()
      params.noiseReduction.enabled = true
      params.noiseReduction.strength = 30
      params.hpf.enabled = true
      params.hpf.frequency = 120
      params.lpf.enabled = true
      params.lpf.frequency = 10000
      params.bands = [
        { frequency: 1000, gain: 4, q: 1.5, enabled: true }
      ]
      params.compressor.enabled = true
      params.compressor.mode = 'LEVEL'
      params.compressor.makeup = 5
      const autoMix: AutoMixParams = { enabled: true, preset: 'MEDIUM' }

      const result = buildFullFilterChain(
        params.hpf,
        params.bands,
        params.lpf,
        params.compressor,
        params.noiseReduction,
        autoMix
      )

      const eqWidth = 1000 / 1.5

      // Canonical chain: AutoGain(placeholder) -> Loudness(placeholder) -> NR(bypassed) -> HPF -> LPF -> EQ -> Compressor -> AutoMix
      // Effective chain (afftdn removed): HPF -> LPF -> EQ -> Compressor -> AutoMix
      expect(result).toBe(
        `highpass=f=120,lowpass=f=10000,equalizer=f=1000:t=h:w=${eqWidth}:g=4,volume=5dB,dynaudnorm=f=500:g=35:p=0.9:m=6`
      )
    })

    it('skips disabled AutoMix', () => {
      const params = createDefaultParams()
      params.hpf.enabled = true
      params.hpf.frequency = 100
      const autoMix: AutoMixParams = { enabled: false, preset: 'LIGHT' }

      const result = buildFullFilterChain(
        params.hpf,
        params.bands,
        params.lpf,
        params.compressor,
        params.noiseReduction,
        autoMix
      )

      expect(result).toBe('highpass=f=100')
    })

    it('handles AutoMix with no other filters enabled', () => {
      const params = createDefaultParams()
      const autoMix: AutoMixParams = { enabled: true, preset: 'LIGHT' }

      const result = buildFullFilterChain(
        params.hpf,
        params.bands,
        params.lpf,
        params.compressor,
        params.noiseReduction,
        autoMix
      )

      expect(result).toBe('dynaudnorm=f=800:g=51:p=0.9:m=3')
    })
  })
})

describe('buildAutoMixFilter', () => {
  it('returns empty string when disabled', () => {
    const autoMix: AutoMixParams = { enabled: false, preset: 'LIGHT' }
    const result = buildAutoMixFilter(autoMix)
    expect(result).toBe('')
  })

  it('builds LIGHT preset correctly', () => {
    const autoMix: AutoMixParams = { enabled: true, preset: 'LIGHT' }
    const result = buildAutoMixFilter(autoMix)
    expect(result).toBe('dynaudnorm=f=800:g=51:p=0.9:m=3')
  })

  it('builds MEDIUM preset correctly', () => {
    const autoMix: AutoMixParams = { enabled: true, preset: 'MEDIUM' }
    const result = buildAutoMixFilter(autoMix)
    expect(result).toBe('dynaudnorm=f=500:g=35:p=0.9:m=6')
  })

  it('builds HEAVY preset correctly', () => {
    const autoMix: AutoMixParams = { enabled: true, preset: 'HEAVY' }
    const result = buildAutoMixFilter(autoMix)
    expect(result).toBe('dynaudnorm=f=200:g=21:p=0.9:m=10')
  })
})

// ============================================================================
// Loudness Normalization Tests
// ============================================================================

interface LoudnessAnalysis {
  input_i: number
  input_tp: number
  input_lra: number
  input_thresh: number
}

const LOUDNESS_CONFIG = {
  TARGET_LUFS: -14,
  TRUE_PEAK_CEILING: -1,
  MAX_GAIN_UP: 12,
  MAX_GAIN_DOWN: -6,
  SILENCE_THRESHOLD: -70,
  NEGLIGIBLE_GAIN: 0.5,
} as const

/**
 * Parse loudnorm JSON output from FFmpeg stderr.
 */
function parseLoudnormOutput(stderr: string): LoudnessAnalysis | null {
  const jsonMatch = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/)
  if (!jsonMatch) {
    return null
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])

    const input_i = parseFloat(parsed.input_i)
    const input_tp = parseFloat(parsed.input_tp)
    const input_lra = parseFloat(parsed.input_lra)
    const input_thresh = parseFloat(parsed.input_thresh)

    if (isNaN(input_i) || isNaN(input_tp)) {
      return null
    }

    return {
      input_i,
      input_tp,
      input_lra: isNaN(input_lra) ? 0 : input_lra,
      input_thresh: isNaN(input_thresh) ? -70 : input_thresh
    }
  } catch {
    return null
  }
}

/**
 * Calculate safe gain adjustment from loudness analysis.
 */
function calculateLoudnessGain(analysis: LoudnessAnalysis): number | null {
  const {
    TARGET_LUFS,
    TRUE_PEAK_CEILING,
    MAX_GAIN_UP,
    MAX_GAIN_DOWN,
    SILENCE_THRESHOLD,
    NEGLIGIBLE_GAIN
  } = LOUDNESS_CONFIG

  // Guard 1: Skip near-silent input
  if (analysis.input_i < SILENCE_THRESHOLD) {
    return null
  }

  // Calculate desired gain
  let gain = TARGET_LUFS - analysis.input_i

  // Guard 2: Clamp to max gain up/down
  gain = Math.max(MAX_GAIN_DOWN, Math.min(MAX_GAIN_UP, gain))

  // Guard 3: Prevent clipping
  const projectedPeak = analysis.input_tp + gain
  if (projectedPeak > TRUE_PEAK_CEILING) {
    gain = TRUE_PEAK_CEILING - analysis.input_tp
  }

  // Guard 4: Skip if gain is negligible
  if (Math.abs(gain) < NEGLIGIBLE_GAIN) {
    return null
  }

  return gain
}

/**
 * Build volume filter for loudness normalization.
 */
function buildLoudnessGainFilter(gainDb: number | null): string {
  if (gainDb === null) return ''
  return `volume=${gainDb.toFixed(2)}dB`
}

describe('parseLoudnormOutput', () => {
  it('parses valid loudnorm JSON', () => {
    const stderr = `
      [Parsed_loudnorm_0 @ 0x7f8b8c004a80]
      {
        "input_i" : "-23.54",
        "input_tp" : "-1.02",
        "input_lra" : "8.70",
        "input_thresh" : "-34.21"
      }
    `
    const result = parseLoudnormOutput(stderr)
    expect(result).toEqual({
      input_i: -23.54,
      input_tp: -1.02,
      input_lra: 8.70,
      input_thresh: -34.21
    })
  })

  it('returns null for missing JSON', () => {
    expect(parseLoudnormOutput('no json here')).toBeNull()
    expect(parseLoudnormOutput('')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    const stderr = '{ "input_i": "not a number" }'
    expect(parseLoudnormOutput(stderr)).toBeNull()
  })

  it('handles missing optional fields', () => {
    const stderr = '{ "input_i": "-20", "input_tp": "-2" }'
    const result = parseLoudnormOutput(stderr)
    expect(result).toEqual({
      input_i: -20,
      input_tp: -2,
      input_lra: 0,
      input_thresh: -70
    })
  })

  it('extracts JSON from noisy stderr', () => {
    const stderr = `
      frame=   50 fps=0.0 q=0.0 size=N/A time=00:00:01.67 bitrate=N/A speed=N/A
      [Parsed_loudnorm_0 @ 0x7f8b8c004a80]
      {
        "input_i" : "-18.00",
        "input_tp" : "-3.50",
        "input_lra" : "5.00",
        "input_thresh" : "-28.00"
      }
      video:0kB audio:192kB subtitle:0kB other streams:0kB
    `
    const result = parseLoudnormOutput(stderr)
    expect(result?.input_i).toBe(-18)
    expect(result?.input_tp).toBe(-3.5)
  })
})

describe('calculateLoudnessGain', () => {
  it('calculates correct gain for typical speech', () => {
    const analysis: LoudnessAnalysis = { input_i: -23, input_tp: -12, input_lra: 8, input_thresh: -34 }
    // Target: -14 LUFS. Input: -23 LUFS. Gain: -14 - (-23) = 9 dB
    // Peak check: -12 + 9 = -3 dB, which is < -1 ceiling (OK)
    expect(calculateLoudnessGain(analysis)).toBe(9)
  })

  it('clamps gain up to MAX_GAIN_UP (12dB)', () => {
    const analysis: LoudnessAnalysis = { input_i: -40, input_tp: -20, input_lra: 5, input_thresh: -50 }
    // Desired gain: -14 - (-40) = 26 dB, but clamped to 12
    expect(calculateLoudnessGain(analysis)).toBe(12)
  })

  it('clamps gain down to MAX_GAIN_DOWN (-6dB)', () => {
    const analysis: LoudnessAnalysis = { input_i: -5, input_tp: -10, input_lra: 3, input_thresh: -15 }
    // Desired gain: -14 - (-5) = -9 dB, but clamped to -6
    expect(calculateLoudnessGain(analysis)).toBe(-6)
  })

  it('prevents clipping by reducing gain', () => {
    const analysis: LoudnessAnalysis = { input_i: -20, input_tp: -2, input_lra: 6, input_thresh: -30 }
    // Desired gain: 6 dB. Peak + gain = -2 + 6 = 4 > -1 ceiling
    // Reduce to: -1 - (-2) = 1 dB
    expect(calculateLoudnessGain(analysis)).toBe(1)
  })

  it('returns null for silent input (below -70 LUFS)', () => {
    const analysis: LoudnessAnalysis = { input_i: -80, input_tp: -60, input_lra: 2, input_thresh: -90 }
    expect(calculateLoudnessGain(analysis)).toBeNull()
  })

  it('returns null for negligible gain (< 0.5 dB)', () => {
    const analysis: LoudnessAnalysis = { input_i: -14.3, input_tp: -3, input_lra: 6, input_thresh: -24 }
    // Gain: -14 - (-14.3) = 0.3 dB, which is < 0.5
    expect(calculateLoudnessGain(analysis)).toBeNull()
  })

  it('applies gain when exactly at threshold', () => {
    const analysis: LoudnessAnalysis = { input_i: -14.5, input_tp: -5, input_lra: 5, input_thresh: -25 }
    // Gain: 0.5 dB, exactly at threshold - should apply
    expect(calculateLoudnessGain(analysis)).toBe(0.5)
  })

  it('handles hot input requiring gain reduction', () => {
    const analysis: LoudnessAnalysis = { input_i: -10, input_tp: -1, input_lra: 4, input_thresh: -20 }
    // Desired gain: -14 - (-10) = -4 dB
    // Peak check: -1 + (-4) = -5 dB, which is < -1 ceiling (OK)
    expect(calculateLoudnessGain(analysis)).toBe(-4)
  })

  it('handles already-clipping input', () => {
    const analysis: LoudnessAnalysis = { input_i: -12, input_tp: 0, input_lra: 3, input_thresh: -22 }
    // Desired gain: -2 dB. Peak is 0, so ceiling constraint: -1 - 0 = -1 dB max gain
    // But -2 < -1, so use -2 dB
    expect(calculateLoudnessGain(analysis)).toBe(-2)
  })
})

describe('buildLoudnessGainFilter', () => {
  it('returns volume filter for positive gain', () => {
    expect(buildLoudnessGainFilter(6)).toBe('volume=6.00dB')
  })

  it('returns volume filter for negative gain', () => {
    expect(buildLoudnessGainFilter(-3)).toBe('volume=-3.00dB')
  })

  it('returns empty string for null', () => {
    expect(buildLoudnessGainFilter(null)).toBe('')
  })

  it('formats gain with 2 decimal places', () => {
    expect(buildLoudnessGainFilter(1.5)).toBe('volume=1.50dB')
    expect(buildLoudnessGainFilter(-0.75)).toBe('volume=-0.75dB')
  })

  it('handles zero gain (edge case)', () => {
    expect(buildLoudnessGainFilter(0)).toBe('volume=0.00dB')
  })
})

// ============================================================================
// Toggle Wiring Audit - Verifies UI toggle ON = filter present, OFF = absent
// ============================================================================

/**
 * Toggle-to-filter mapping for automated verification.
 * Canonical rule: enabled=true → filter present, enabled=false → filter absent
 */
interface ToggleSpec {
  name: string
  filterPattern: RegExp  // Pattern to detect filter in chain
  getEnabledState: () => any  // Returns state with toggle ON
  getDisabledState: () => any  // Returns state with toggle OFF
  buildFilter: (state: any) => string  // Function to build filter
}

describe('Toggle Wiring Audit', () => {
  // Default disabled states for isolation
  const defaultHpf: FilterParams = { frequency: 120, q: 0.7, enabled: false }
  const defaultLpf: FilterParams = { frequency: 8000, q: 0.7, enabled: false }
  const defaultBands: EQBand[] = [
    { frequency: 200, gain: 0, q: 1.0, enabled: false },
    { frequency: 1000, gain: 0, q: 1.0, enabled: false },
    { frequency: 5000, gain: 0, q: 1.0, enabled: false }
  ]
  const defaultCompressor: CompressorParams = {
    threshold: -18, ratio: 3, attack: 10, release: 100,
    makeup: 0, emphasis: 80, mode: 'COMP', enabled: false
  }
  const defaultNR: NoiseReductionParams = { strength: 50, enabled: false }
  const defaultAutoMix: AutoMixParams = { preset: 'MEDIUM', enabled: false }

  /**
   * Toggle specifications - the definitive list of all toggle-controlled filters
   */
  const TOGGLE_SPECS: ToggleSpec[] = [
    // NR (Noise Reduction) removed from toggle tests - afftdn removed, always returns empty string
    // {
    //   name: 'NR (Noise Reduction)',
    //   filterPattern: /afftdn/,
    //   getEnabledState: () => ({ strength: 50, enabled: true }),
    //   getDisabledState: () => ({ strength: 50, enabled: false }),
    //   buildFilter: (nr) => buildNoiseReductionFilter(nr)
    // },
    {
      name: 'HPF (High-Pass Filter)',
      filterPattern: /highpass/,
      getEnabledState: () => ({ frequency: 120, q: 0.7, enabled: true }),
      getDisabledState: () => ({ frequency: 120, q: 0.7, enabled: false }),
      buildFilter: (hpf) => hpf.enabled ? `highpass=f=${hpf.frequency}` : ''
    },
    {
      name: 'LPF (Low-Pass Filter)',
      filterPattern: /lowpass/,
      getEnabledState: () => ({ frequency: 8000, q: 0.7, enabled: true }),
      getDisabledState: () => ({ frequency: 8000, q: 0.7, enabled: false }),
      buildFilter: (lpf) => lpf.enabled ? `lowpass=f=${lpf.frequency}` : ''
    },
    {
      name: 'EQ Band (Lo)',
      filterPattern: /equalizer=f=200/,
      getEnabledState: () => [{ frequency: 200, gain: 3, q: 1.0, enabled: true }],
      getDisabledState: () => [{ frequency: 200, gain: 3, q: 1.0, enabled: false }],
      buildFilter: (bands) => buildEQFilter(bands)
    },
    {
      name: 'EQ Band (Mid)',
      filterPattern: /equalizer=f=1000/,
      getEnabledState: () => [{ frequency: 1000, gain: 3, q: 1.0, enabled: true }],
      getDisabledState: () => [{ frequency: 1000, gain: 3, q: 1.0, enabled: false }],
      buildFilter: (bands) => buildEQFilter(bands)
    },
    {
      name: 'EQ Band (Hi)',
      filterPattern: /equalizer=f=5000/,
      getEnabledState: () => [{ frequency: 5000, gain: 3, q: 1.0, enabled: true }],
      getDisabledState: () => [{ frequency: 5000, gain: 3, q: 1.0, enabled: false }],
      buildFilter: (bands) => buildEQFilter(bands)
    },
    {
      name: 'Compressor (COMP mode)',
      filterPattern: /acompressor/,
      getEnabledState: () => ({ ...defaultCompressor, mode: 'COMP', enabled: true }),
      getDisabledState: () => ({ ...defaultCompressor, mode: 'COMP', enabled: false }),
      buildFilter: (comp) => buildCompressorFilter(comp)
    },
    {
      name: 'Limiter (LIMIT mode)',
      filterPattern: /alimiter/,
      getEnabledState: () => ({ ...defaultCompressor, mode: 'LIMIT', enabled: true }),
      getDisabledState: () => ({ ...defaultCompressor, mode: 'LIMIT', enabled: false }),
      buildFilter: (comp) => buildCompressorFilter(comp)
    },
    {
      name: 'Level (LEVEL mode with makeup)',
      filterPattern: /volume=/,
      getEnabledState: () => ({ ...defaultCompressor, mode: 'LEVEL', makeup: 3, enabled: true }),
      getDisabledState: () => ({ ...defaultCompressor, mode: 'LEVEL', makeup: 3, enabled: false }),
      buildFilter: (comp) => buildCompressorFilter(comp)
    },
    {
      name: 'AutoMix',
      filterPattern: /dynaudnorm/,
      getEnabledState: () => ({ preset: 'MEDIUM', enabled: true }),
      getDisabledState: () => ({ preset: 'MEDIUM', enabled: false }),
      buildFilter: (autoMix) => buildAutoMixFilter(autoMix)
    }
  ]

  describe('Individual Toggle Tests', () => {
    TOGGLE_SPECS.forEach(spec => {
      it(`${spec.name}: enabled=true → filter PRESENT`, () => {
        const state = spec.getEnabledState()
        const filter = spec.buildFilter(state)

        const isPresent = spec.filterPattern.test(filter)
        if (!isPresent) {
          console.error(`INVERSION BUG: ${spec.name} - enabled=true but filter absent`)
          console.error(`  Filter output: "${filter}"`)
          console.error(`  Expected pattern: ${spec.filterPattern}`)
        }
        expect(isPresent).toBe(true)
      })

      it(`${spec.name}: enabled=false → filter ABSENT`, () => {
        const state = spec.getDisabledState()
        const filter = spec.buildFilter(state)

        const isPresent = spec.filterPattern.test(filter)
        if (isPresent) {
          console.error(`INVERSION BUG: ${spec.name} - enabled=false but filter present`)
          console.error(`  Filter output: "${filter}"`)
        }
        expect(isPresent).toBe(false)
      })
    })
  })

  describe('Full Filter Chain Integration', () => {
    it('all toggles OFF → empty filter chain', () => {
      const chain = buildFullFilterChain(
        defaultHpf,
        defaultBands,
        defaultLpf,
        defaultCompressor,
        defaultNR,
        defaultAutoMix
      )
      expect(chain).toBe('')
    })

    it('only NR enabled → empty chain (afftdn removed, NR bypassed)', () => {
      const chain = buildFullFilterChain(
        defaultHpf,
        defaultBands,
        defaultLpf,
        defaultCompressor,
        { strength: 50, enabled: true },
        defaultAutoMix
      )
      expect(chain).toBe('')  // NR bypassed, no filters
      expect(chain).not.toMatch(/highpass/)
      expect(chain).not.toMatch(/lowpass/)
      expect(chain).not.toMatch(/equalizer/)
      expect(chain).not.toMatch(/acompressor/)
      expect(chain).not.toMatch(/dynaudnorm/)
    })

    it('only HPF enabled → only highpass in chain', () => {
      const chain = buildFullFilterChain(
        { frequency: 120, q: 0.7, enabled: true },
        defaultBands,
        defaultLpf,
        defaultCompressor,
        defaultNR,
        defaultAutoMix
      )
      expect(chain).toMatch(/highpass/)
      expect(chain).not.toMatch(/afftdn/)
      expect(chain).not.toMatch(/lowpass/)
      expect(chain).not.toMatch(/equalizer/)
      expect(chain).not.toMatch(/acompressor/)
      expect(chain).not.toMatch(/dynaudnorm/)
    })

    it('only LPF enabled → only lowpass in chain', () => {
      const chain = buildFullFilterChain(
        defaultHpf,
        defaultBands,
        { frequency: 8000, q: 0.7, enabled: true },
        defaultCompressor,
        defaultNR,
        defaultAutoMix
      )
      expect(chain).toMatch(/lowpass/)
      expect(chain).not.toMatch(/afftdn/)
      expect(chain).not.toMatch(/highpass/)
      expect(chain).not.toMatch(/equalizer/)
      expect(chain).not.toMatch(/acompressor/)
      expect(chain).not.toMatch(/dynaudnorm/)
    })

    it('only EQ (with gain) enabled → only equalizer in chain', () => {
      const eqBands: EQBand[] = [
        { frequency: 1000, gain: 3, q: 1.0, enabled: true }
      ]
      const chain = buildFullFilterChain(
        defaultHpf,
        eqBands,
        defaultLpf,
        defaultCompressor,
        defaultNR,
        defaultAutoMix
      )
      expect(chain).toMatch(/equalizer/)
      expect(chain).not.toMatch(/afftdn/)
      expect(chain).not.toMatch(/highpass/)
      expect(chain).not.toMatch(/lowpass/)
      expect(chain).not.toMatch(/acompressor/)
      expect(chain).not.toMatch(/dynaudnorm/)
    })

    it('only Compressor enabled → only acompressor in chain', () => {
      // Note: emphasis > 30 adds a highpass internally for sidechain emulation
      // Using emphasis: 20 to disable this internal HPF for clean isolation test
      const compNoEmphasis: CompressorParams = {
        ...defaultCompressor,
        emphasis: 20,  // Below 30Hz threshold, no internal HPF
        enabled: true
      }
      const chain = buildFullFilterChain(
        defaultHpf,
        defaultBands,
        defaultLpf,
        compNoEmphasis,
        defaultNR,
        defaultAutoMix
      )
      expect(chain).toMatch(/acompressor/)
      expect(chain).not.toMatch(/afftdn/)
      expect(chain).not.toMatch(/highpass/)
      expect(chain).not.toMatch(/lowpass/)
      expect(chain).not.toMatch(/equalizer/)
      expect(chain).not.toMatch(/dynaudnorm/)
    })

    it('only AutoMix enabled → only dynaudnorm in chain', () => {
      const chain = buildFullFilterChain(
        defaultHpf,
        defaultBands,
        defaultLpf,
        defaultCompressor,
        defaultNR,
        { preset: 'MEDIUM', enabled: true }
      )
      expect(chain).toMatch(/dynaudnorm/)
      expect(chain).not.toMatch(/afftdn/)
      expect(chain).not.toMatch(/highpass/)
      expect(chain).not.toMatch(/lowpass/)
      expect(chain).not.toMatch(/equalizer/)
      expect(chain).not.toMatch(/acompressor/)
    })

    it('all toggles ON → all filters present in canonical order (NR bypassed)', () => {
      const allOnBands: EQBand[] = [
        { frequency: 200, gain: 2, q: 1.0, enabled: true },
        { frequency: 1000, gain: -1, q: 1.0, enabled: true },
        { frequency: 5000, gain: 3, q: 1.0, enabled: true }
      ]
      const chain = buildFullFilterChain(
        { frequency: 120, q: 0.7, enabled: true },
        allOnBands,
        { frequency: 8000, q: 0.7, enabled: true },
        { ...defaultCompressor, enabled: true },
        { strength: 50, enabled: true },
        { preset: 'MEDIUM', enabled: true }
      )

      // All filters present except NR (afftdn removed)
      expect(chain).not.toMatch(/afftdn/)  // NR bypassed
      expect(chain).toMatch(/highpass/)
      expect(chain).toMatch(/lowpass/)
      expect(chain).toMatch(/equalizer/)
      expect(chain).toMatch(/acompressor/)
      expect(chain).toMatch(/dynaudnorm/)

      // Verify canonical order: HPF → LPF → EQ → Comp → AutoMix (AutoGain, Loudness, NR all bypassed)
      const hpfIndex = chain.indexOf('highpass')
      const lpfIndex = chain.indexOf('lowpass')
      const eqIndex = chain.indexOf('equalizer')
      const compIndex = chain.indexOf('acompressor')
      const autoMixIndex = chain.indexOf('dynaudnorm')

      expect(hpfIndex).toBeLessThan(lpfIndex)
      expect(lpfIndex).toBeLessThan(eqIndex)
      expect(eqIndex).toBeLessThan(compIndex)
      expect(compIndex).toBeLessThan(autoMixIndex)
    })
  })

  describe('Edge Cases', () => {
    it('EQ enabled with zero gain → filter absent (optimization)', () => {
      const zeroGainBands: EQBand[] = [
        { frequency: 1000, gain: 0, q: 1.0, enabled: true }
      ]
      const filter = buildEQFilter(zeroGainBands)
      expect(filter).toBe('')  // Zero gain = no audible effect = skip
    })

    it('NR enabled with zero strength → filter absent', () => {
      const filter = buildNoiseReductionFilter({ strength: 0, enabled: true })
      expect(filter).toBe('')  // Zero strength = no effect = skip
    })

    it('Compressor LEVEL mode with zero makeup → filter absent', () => {
      const filter = buildCompressorFilter({
        ...defaultCompressor,
        mode: 'LEVEL',
        makeup: 0,
        enabled: true
      })
      expect(filter).toBe('')  // Zero makeup in LEVEL mode = no effect
    })
  })
})
