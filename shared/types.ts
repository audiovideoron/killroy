/**
 * Shared type definitions for audio processing.
 * Single source of truth - imported by electron/main.ts, electron/preload.ts, and src/App.tsx.
 */

export interface EQBand {
  frequency: number
  gain: number
  q: number
  enabled: boolean
}

export interface FilterParams {
  frequency: number
  q: number
  enabled: boolean
}

export interface CompressorParams {
  threshold: number    // -60 to 0 dB
  ratio: number        // 1 to 20
  attack: number       // 0.01 to 200 ms
  release: number      // 10 to 2000 ms
  makeup: number       // -20 to 20 dB
  emphasis: number     // 20 to 2000 Hz (HPF on detector)
  mode: 'LEVEL' | 'COMP' | 'LIMIT'
  enabled: boolean
}

export interface NoiseReductionParams {
  strength: number     // 0-100, maps to afftdn parameters
  enabled: boolean
}

export type AutoMixPreset = 'LIGHT' | 'MEDIUM' | 'HEAVY'

export interface AutoMixParams {
  preset: AutoMixPreset
  enabled: boolean
}

export interface RenderOptions {
  inputPath: string
  startTime: number
  duration: number
  bands: EQBand[]
  hpf: FilterParams
  lpf: FilterParams
  compressor: CompressorParams
  noiseReduction: NoiseReductionParams
  autoMix: AutoMixParams
}

export interface RenderResult {
  success: boolean
  error?: string
  originalPath?: string
  processedPath?: string
  renderId?: number
  jobId?: string  // For progress tracking
}

/**
 * Job progress state
 */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

/**
 * Progress event emitted during FFmpeg job execution
 */
export interface JobProgressEvent {
  jobId: string
  status: JobStatus
  percent?: number           // 0..1 when duration is known
  indeterminate?: boolean    // true when duration is unknown
  positionSeconds?: number   // Current time position
  durationSeconds?: number   // Total duration (if known)
  phase?: string             // e.g., "original-preview", "processed-preview"
}
