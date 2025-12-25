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

/**
 * Loudness analysis result from FFmpeg loudnorm filter (analysis mode).
 * All values in EBU R128 units.
 */
export interface LoudnessAnalysis {
  input_i: number      // Integrated LUFS
  input_tp: number     // True peak dBTP
  input_lra: number    // Loudness range LU
  input_thresh: number // Threshold
}

/**
 * Constants for loudness normalization.
 * Hidden from UI - always-on final mastering stage.
 */
export const LOUDNESS_CONFIG = {
  TARGET_LUFS: -14,        // YouTube/Spotify standard
  TRUE_PEAK_CEILING: -1,   // dBTP ceiling to prevent clipping
  MAX_GAIN_UP: 12,         // Maximum gain increase (dB)
  MAX_GAIN_DOWN: -6,       // Maximum gain decrease (dB)
  SILENCE_THRESHOLD: -70,  // Skip if quieter than this (LUFS)
  NEGLIGIBLE_GAIN: 0.5,    // Skip if gain is smaller than this (dB)
} as const
