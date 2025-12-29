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

export interface NoiseSamplingParams {
  enabled: boolean
}

/**
 * AutoGain/Leveling - Input level normalization.
 * Applies gentle automatic gain before other processing.
 */
export interface AutoGainParams {
  targetLevel: number  // Target peak level in dB (-20 to 0)
  enabled: boolean
}

/**
 * AutoGain configuration defaults.
 */
export const AUTOGAIN_CONFIG = {
  DEFAULT_TARGET: -6,    // Target peak level (dB)
  MIN_TARGET: -20,
  MAX_TARGET: 0,
} as const

/**
 * Loudness normalization - EBU R128 loudness targeting.
 * Applied after input normalization, before frequency shaping.
 */
export interface LoudnessParams {
  targetLufs: number   // Target integrated loudness (-24 to -5 LUFS)
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
  autoGain: AutoGainParams
  loudness: LoudnessParams
  noiseSampling: NoiseSamplingParams
  hpf: FilterParams
  lpf: FilterParams
  bands: EQBand[]
  compressor: CompressorParams
  autoMix: AutoMixParams
  noiseSampleRegion: QuietCandidate | null
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

/**
 * Quiet region candidate for noise sampling.
 * Detected via FFmpeg silencedetect.
 */
export interface QuietCandidate {
  startMs: number
  endMs: number
}

/**
 * Result of quiet candidate detection.
 */
export interface QuietCandidatesResult {
  candidates: QuietCandidate[]
}

/**
 * Configuration for quiet region detection.
 * Threshold is dynamic: mean_volume - THRESHOLD_OFFSET_DB, clamped to [MIN, MAX].
 */
export const QUIET_DETECTION_CONFIG = {
  // Proof mode: maximally permissive settings to prove pipeline works
  PROOF_MODE: true,            // SET TO false FOR PRODUCTION
  PROOF_THRESHOLD_DB: -15,     // Permissive threshold for proof mode
  PROOF_MIN_DURATION_SEC: 0.05,// Very short duration for proof mode

  // Normal mode settings
  THRESHOLD_OFFSET_DB: 6,      // dB below mean volume to consider "quiet"
  THRESHOLD_MIN_DB: -45,       // Floor: never go below this
  THRESHOLD_MAX_DB: -15,       // Ceiling: never go above this
  MIN_DURATION_SEC: 0.5,       // Minimum quiet region duration in seconds
  MAX_CANDIDATES: 5,           // Maximum candidates to return
} as const

/**
 * Protocol error event emitted when file serving fails.
 */
export interface ProtocolErrorEvent {
  url: string
  statusCode: number
  message: string
}
