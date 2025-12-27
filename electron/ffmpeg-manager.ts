import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { app, BrowserWindow } from 'electron'
import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  AutoMixParams,
  JobProgressEvent,
  JobStatus,
  LoudnessAnalysis,
  QuietCandidate
} from '../shared/types'
import { LOUDNESS_CONFIG, QUIET_DETECTION_CONFIG } from '../shared/types'

/**
 * FFmpeg job tracking for lifecycle management.
 * Ensures all FFmpeg processes are tracked, cancellable, and cleaned up.
 */
export interface FFmpegJob {
  id: string
  process: ChildProcess
  startTime: number
  timeoutHandle: NodeJS.Timeout | null
  durationSeconds?: number   // Expected duration for progress calculation
  phase?: string             // Job context (e.g., "original-preview", "processed-preview")
  lastProgressEmit?: number  // Timestamp of last progress event (for throttling)
  tempDir?: string           // Per-job temp directory for intermediate files
}

/**
 * Registry of active FFmpeg jobs.
 * Every spawned FFmpeg process MUST be registered here.
 */
const activeFFmpegJobs = new Map<string, FFmpegJob>()

/**
 * Progress information parsed from FFmpeg stderr
 */
interface FFmpegProgress {
  positionSeconds: number
  rawLine: string
}

/**
 * Structured error types for FFmpeg operations
 */
export enum FFmpegErrorType {
  SPAWN_FAILED = 'spawn_failed',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled',
  NON_ZERO_EXIT = 'non_zero_exit'
}

export interface FFmpegError {
  type: FFmpegErrorType
  message: string
  stderr?: string
  exitCode?: number
}

export interface FFmpegResult {
  success: boolean
  stderr: string
  error?: FFmpegError
}

/**
 * Render attempt strategies (copy → re-encode → last resort)
 */
export type RenderAttemptType = 'COPY' | 'REENCODE' | 'LAST_RESORT'

export interface RenderAttempt {
  name: RenderAttemptType
  args: string[]
}

interface RenderAttemptFailure {
  attempt: RenderAttemptType
  error: FFmpegError
  stderrTail?: string
}

/**
 * FFprobe stream information
 */
interface FFprobeStream {
  codec_type: string
  codec_name?: string
  channels?: number
  sample_rate?: string
  [key: string]: any
}

interface FFprobeFormat {
  filename?: string
  duration?: string
  format_name?: string
  [key: string]: any
}

export interface FFprobeResult {
  streams: FFprobeStream[]
  format: FFprobeFormat
}

/**
 * Get the application's temporary directory root.
 * Uses Electron's temp path API to work correctly when packaged.
 * Creates the directory if it doesn't exist.
 *
 * @returns Absolute path to app-specific temp root directory
 */
function getTempRoot(): string {
  // Use Electron's temp directory API (works in dev and packaged app)
  // Create app-specific subdirectory to avoid conflicts
  const appTempRoot = path.join(app.getPath('temp'), 'audio-pro')

  if (!fs.existsSync(appTempRoot)) {
    fs.mkdirSync(appTempRoot, { recursive: true })
  }

  return appTempRoot
}

/**
 * Create a temporary directory for a specific job.
 * All intermediate files for this job should be written here.
 *
 * @param jobId Unique job identifier
 * @returns Absolute path to job-specific temp directory
 */
export function createJobTempDir(jobId: string): string {
  const tempRoot = getTempRoot()
  const jobTempDir = path.join(tempRoot, `job-${jobId}`)

  if (!fs.existsSync(jobTempDir)) {
    fs.mkdirSync(jobTempDir, { recursive: true })
  }

  console.log(`[temp] Created job temp directory: ${jobTempDir}`)
  return jobTempDir
}

/**
 * Clean up a job's temporary directory.
 * Safe to call multiple times; will not throw if directory doesn't exist.
 *
 * @param jobId Unique job identifier
 * @param tempDir Path to job temp directory (optional, will be derived from jobId if not provided)
 */
export function cleanupJobTempDir(jobId: string, tempDir?: string): void {
  // Check PRESERVE_TEMP_FILES environment variable
  if (process.env.PRESERVE_TEMP_FILES === 'true') {
    console.log(`[temp] Preserving temp directory for job ${jobId} (PRESERVE_TEMP_FILES=true)`)
    return
  }

  const jobTempDir = tempDir || path.join(getTempRoot(), `job-${jobId}`)

  if (!fs.existsSync(jobTempDir)) {
    return
  }

  try {
    // Remove directory recursively
    fs.rmSync(jobTempDir, { recursive: true, force: true })
    console.log(`[temp] Cleaned up job temp directory: ${jobTempDir}`)
  } catch (err) {
    // Don't throw - log and continue
    console.error(`[temp] Failed to clean up job temp directory ${jobTempDir}:`, err)
  }
}

/**
 * Clean up stale job directories on app startup.
 * Removes job directories older than the specified threshold.
 *
 * @param maxAgeMs Maximum age in milliseconds (default: 24 hours)
 */
export function cleanupStaleJobDirs(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  // Check PRESERVE_TEMP_FILES environment variable
  if (process.env.PRESERVE_TEMP_FILES === 'true') {
    console.log('[temp] Skipping stale directory cleanup (PRESERVE_TEMP_FILES=true)')
    return
  }

  const tempRoot = getTempRoot()

  if (!fs.existsSync(tempRoot)) {
    return
  }

  try {
    const entries = fs.readdirSync(tempRoot, { withFileTypes: true })
    const now = Date.now()
    let removedCount = 0

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) {
        continue
      }

      const dirPath = path.join(tempRoot, entry.name)

      try {
        const stats = fs.statSync(dirPath)
        const ageMs = now - stats.mtimeMs

        if (ageMs >= maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true, force: true })
          console.log(`[temp] Removed stale job directory: ${entry.name} (age: ${Math.round(ageMs / 1000 / 60)}min)`)
          removedCount++
        }
      } catch (err) {
        console.error(`[temp] Failed to check/remove directory ${entry.name}:`, err)
      }
    }

    if (removedCount > 0) {
      console.log(`[temp] Cleaned up ${removedCount} stale job directories`)
    }
  } catch (err) {
    console.error('[temp] Failed to scan temp root for stale directories:', err)
  }
}

/**
 * Parse FFmpeg stderr line for progress information.
 * Looks for patterns like: time=00:01:23.45 or time=83.45
 *
 * @param line Single line from FFmpeg stderr
 * @returns Progress info if found, null otherwise
 */
function parseFFmpegProgress(line: string): FFmpegProgress | null {
  // Pattern 1: time=HH:MM:SS.ms (e.g., time=00:01:23.45)
  const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/)
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10)
    const minutes = parseInt(timeMatch[2], 10)
    const seconds = parseInt(timeMatch[3], 10)
    const milliseconds = parseInt(timeMatch[4], 10)

    const positionSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 100
    return { positionSeconds, rawLine: line }
  }

  // Pattern 2: time=seconds (e.g., time=83.45)
  const simpleTimeMatch = line.match(/time=(\d+\.?\d*)/)
  if (simpleTimeMatch) {
    const positionSeconds = parseFloat(simpleTimeMatch[1])
    return { positionSeconds, rawLine: line }
  }

  // Pattern 3: out_time_ms=milliseconds (ffmpeg -progress pipe:2 format)
  const outTimeMsMatch = line.match(/out_time_ms=(\d+)/)
  if (outTimeMsMatch) {
    const positionMs = parseInt(outTimeMsMatch[1], 10)
    const positionSeconds = positionMs / 1_000_000  // FFmpeg uses microseconds
    return { positionSeconds, rawLine: line }
  }

  return null
}

/**
 * Emit progress event to renderer process.
 * Throttled to max 10 updates/sec per job.
 *
 * @param job FFmpeg job
 * @param positionSeconds Current time position in seconds
 * @param status Job status (default: 'running')
 * @param mainWindow Main browser window to send events to
 */
function emitProgress(job: FFmpegJob, positionSeconds: number, status: JobStatus = 'running', mainWindow: BrowserWindow | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  // Throttle: max 100ms between updates (10 updates/sec)
  const now = Date.now()
  if (job.lastProgressEmit && now - job.lastProgressEmit < 100) {
    return
  }
  job.lastProgressEmit = now

  const event: JobProgressEvent = {
    jobId: job.id,
    status,
    positionSeconds,
    phase: job.phase
  }

  // Add percent if duration is known
  if (job.durationSeconds && job.durationSeconds > 0) {
    event.durationSeconds = job.durationSeconds
    event.percent = Math.min(1, Math.max(0, positionSeconds / job.durationSeconds))
    event.indeterminate = false
  } else {
    event.indeterminate = true
  }

  mainWindow.webContents.send('job:progress', event)
}

/**
 * Emit terminal state event (completed, failed, cancelled, timed_out).
 * Always emits, bypassing throttle.
 *
 * @param job FFmpeg job
 * @param status Terminal status
 * @param percent Final percent (default: last known position)
 * @param mainWindow Main browser window to send events to
 */
function emitTerminalState(job: FFmpegJob, status: JobStatus, percent: number | undefined, mainWindow: BrowserWindow | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }

  const event: JobProgressEvent = {
    jobId: job.id,
    status,
    phase: job.phase
  }

  if (percent !== undefined) {
    event.percent = percent
    event.indeterminate = false
  } else if (job.durationSeconds) {
    event.durationSeconds = job.durationSeconds
    event.indeterminate = false
  } else {
    event.indeterminate = true
  }

  mainWindow.webContents.send('job:progress', event)
}

/**
 * Probe media file metadata using ffprobe with structured JSON output.
 * Much faster and more reliable than parsing ffmpeg stderr.
 * Includes timeout protection (30s default) to prevent hung processes.
 *
 * @param filePath Absolute path to media file (must be validated first)
 * @param timeoutMs Timeout in milliseconds (default: 30 seconds)
 * @returns Promise resolving to parsed ffprobe JSON data
 */
export async function probeMediaMetadata(filePath: string, timeoutMs: number = 30000): Promise<FFprobeResult> {
  const probePromise = new Promise<FFprobeResult>((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath
    ]

    console.log('[ffprobe] Probing:', filePath)
    const proc = spawn('ffprobe', args)

    let stdout = ''
    let stderr = ''
    let resolved = false

    const cleanup = () => {
      if (proc && !proc.killed) {
        try {
          proc.kill('SIGTERM')
          setTimeout(() => {
            if (proc && !proc.killed) {
              proc.kill('SIGKILL')
            }
          }, 1000)
        } catch (err) {
          console.error('[ffprobe] Failed to kill process:', err)
        }
      }
    }

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (resolved) return
      resolved = true

      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`))
        return
      }

      try {
        const result = JSON.parse(stdout) as FFprobeResult
        console.log('[ffprobe] Found streams:', result.streams.map(s => s.codec_type).join(', '))
        resolve(result)
      } catch (err) {
        reject(new Error(`Failed to parse ffprobe JSON: ${err}`))
      }
    })

    proc.on('error', (err) => {
      if (resolved) return
      resolved = true
      cleanup()
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`))
    })
  })

  const timeoutPromise = new Promise<FFprobeResult>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`ffprobe operation timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
  })

  return Promise.race([probePromise, timeoutPromise])
}

/**
 * Build EQ filter chain from enabled bands
 */
export function buildEQFilter(bands: EQBand[]): string {
  const enabledBands = bands.filter(b => b.enabled && b.gain !== 0)
  if (enabledBands.length === 0) {
    return ''
  }

  // FFmpeg equalizer filter format: equalizer=f=<freq>:t=h:w=<width>:g=<gain>
  // width = frequency / Q for peaking filter
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

/**
 * Build compressor/limiter filter
 */
export function buildCompressorFilter(comp: CompressorParams): string {
  if (!comp.enabled) return ''

  // LEVEL mode: just apply makeup gain, no compression
  if (comp.mode === 'LEVEL') {
    if (comp.makeup === 0) return ''
    return `volume=${comp.makeup}dB`
  }

  // LIMIT mode: use alimiter
  if (comp.mode === 'LIMIT') {
    // alimiter: limit is the ceiling (use threshold as ceiling)
    // attack in seconds, release in seconds
    const attackSec = comp.attack / 1000
    const releaseSec = comp.release / 1000
    // Ceiling is typically 0dB or threshold, level is makeup gain
    const filters: string[] = []
    // Apply emphasis as HPF before limiting (sidechain-like effect)
    if (comp.emphasis > 30) {
      filters.push(`highpass=f=${comp.emphasis}`)
    }
    filters.push(`alimiter=limit=${comp.threshold}dB:attack=${attackSec}:release=${releaseSec}:level=false`)
    if (comp.makeup !== 0) {
      filters.push(`volume=${comp.makeup}dB`)
    }
    return filters.join(',')
  }

  // COMP mode: use acompressor
  // attack and release in seconds for FFmpeg
  const attackSec = comp.attack / 1000
  const releaseSec = comp.release / 1000

  const filters: string[] = []

  // Emphasis: apply HPF to sidechain-like behavior
  // FFmpeg acompressor doesn't have true sidechain EQ, but we can approximate
  // by using a parallel path or just applying HPF before detection
  // For simplicity, we'll note this is a detector-weighting approximation
  if (comp.emphasis > 30) {
    // Use asplit to create sidechain path with HPF for detection weighting
    // This is an approximation - true sidechain compression would need sidechaincompress
    filters.push(`highpass=f=${comp.emphasis}`)
  }

  // acompressor parameters:
  // threshold: in dB
  // ratio: compression ratio
  // attack: in seconds
  // release: in seconds
  // makeup: in dB
  filters.push(`acompressor=threshold=${comp.threshold}dB:ratio=${comp.ratio}:attack=${attackSec}:release=${releaseSec}:makeup=${comp.makeup}dB`)

  return filters.join(',')
}

/**
 * Build Noise Sampling DSP filter (placeholder for bead audio_pro-5a3).
 *
 * IMPLEMENTATION PENDING:
 * This stage is reserved for profile-based noise reduction using noiseSampleRegion.
 * Will replace the previous afftdn implementation with deterministic noise sampling.
 *
 * For now, returns empty string (bypass) until Noise Sampling DSP is wired end-to-end.
 *
 * @param nr - Noise reduction parameters (currently unused, reserved for future)
 * @returns Empty string (bypass) until audio_pro-5a3 is implemented
 */
export function buildNoiseReductionFilter(nr: NoiseReductionParams): string {
  // PLACEHOLDER: Noise Sampling DSP will be implemented in bead audio_pro-5a3
  // This stage is reserved for profile-based noise reduction using noiseSampleRegion
  // For now, bypass (return empty string) until Noise Sampling DSP is wired
  return ''
}

/**
 * Build AutoMix filter using FFmpeg's dynaudnorm for speech-focused level management.
 *
 * Tailored for speech/dialogue: meetings, interviews, podcasts.
 *
 * dynaudnorm parameters:
 * - f (framelen): Frame length in ms. Larger = slower response, smoother.
 * - g (gausssize): Gaussian window size. Larger = slower response.
 * - p (peak): Target peak level (0.0-1.0). Fixed at 0.9 for headroom.
 * - m (maxgain): Maximum amplification factor.
 *
 * Presets:
 * - LIGHT: Gentle leveling, preserves natural dynamics (f=800, g=51, m=3)
 * - MEDIUM: Balanced leveling for typical speech (f=500, g=35, m=6)
 * - HEAVY: Aggressive leveling for difficult recordings (f=200, g=21, m=10)
 */
export function buildAutoMixFilter(autoMix: AutoMixParams): string {
  if (!autoMix.enabled) return ''

  // Preset parameters for speech-focused leveling
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
 * Parse loudnorm JSON output from FFmpeg stderr.
 * Looks for JSON block with input_i field.
 *
 * FFmpeg loudnorm outputs JSON like:
 * {
 *   "input_i" : "-23.54",
 *   "input_tp" : "-1.02",
 *   "input_lra" : "8.70",
 *   "input_thresh" : "-34.21",
 *   ...
 * }
 */
export function parseLoudnormOutput(stderr: string): LoudnessAnalysis | null {
  // Find JSON block (starts with { containing "input_i")
  // Using [\s\S]* instead of .* with 's' flag for cross-line matching
  const jsonMatch = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/)
  if (!jsonMatch) {
    return null
  }

  try {
    const parsed = JSON.parse(jsonMatch[0])

    // Validate required fields exist and are parseable
    const input_i = parseFloat(parsed.input_i)
    const input_tp = parseFloat(parsed.input_tp)
    const input_lra = parseFloat(parsed.input_lra)
    const input_thresh = parseFloat(parsed.input_thresh)

    if (isNaN(input_i) || isNaN(input_tp)) {
      console.warn('[loudness] Invalid loudnorm values: input_i or input_tp is NaN')
      return null
    }

    return {
      input_i,
      input_tp,
      input_lra: isNaN(input_lra) ? 0 : input_lra,
      input_thresh: isNaN(input_thresh) ? -70 : input_thresh
    }
  } catch (err) {
    console.error('[loudness] JSON parse error:', err)
    return null
  }
}

/**
 * Calculate safe gain adjustment from loudness analysis.
 * Applies safety guardrails: clamping, peak limiting, silence detection.
 *
 * @param analysis Loudness analysis from Pass 1
 * @returns Gain in dB to apply, or null to skip normalization
 */
export function calculateLoudnessGain(analysis: LoudnessAnalysis): number | null {
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
    console.log('[loudness] Skipping silent input:', analysis.input_i, 'LUFS')
    return null
  }

  // Calculate desired gain
  let gain = TARGET_LUFS - analysis.input_i

  // Guard 2: Clamp to max gain up/down
  gain = Math.max(MAX_GAIN_DOWN, Math.min(MAX_GAIN_UP, gain))

  // Guard 3: Prevent clipping (true peak + gain must not exceed ceiling)
  const projectedPeak = analysis.input_tp + gain
  if (projectedPeak > TRUE_PEAK_CEILING) {
    const reducedGain = TRUE_PEAK_CEILING - analysis.input_tp
    console.log('[loudness] Reduced gain to prevent clipping:', gain.toFixed(2), '->', reducedGain.toFixed(2), 'dB')
    gain = reducedGain
  }

  // Guard 4: Skip if gain is negligible
  if (Math.abs(gain) < NEGLIGIBLE_GAIN) {
    console.log('[loudness] Skipping negligible gain:', gain.toFixed(2), 'dB')
    return null
  }

  return gain
}

/**
 * Build volume filter for loudness normalization.
 * Returns empty string if gain is null (passthrough).
 */
export function buildLoudnessGainFilter(gainDb: number | null): string {
  if (gainDb === null) return ''
  return `volume=${gainDb.toFixed(2)}dB`
}

/**
 * Analyze audio loudness using FFmpeg loudnorm filter.
 * Runs FFmpeg in "analysis only" mode - no output file.
 *
 * @param inputPath Path to input file
 * @param filterChain Existing filter chain to apply before analysis
 * @param startTime Start time in seconds
 * @param duration Duration in seconds
 * @param timeoutMs Timeout in milliseconds (default: 30s)
 * @returns LoudnessAnalysis or null if analysis failed
 */
export async function analyzeLoudness(
  inputPath: string,
  filterChain: string,
  startTime: number,
  duration: number,
  timeoutMs: number = 30000
): Promise<LoudnessAnalysis | null> {
  // Build analysis filter chain: existing filters + loudnorm in analysis mode
  const analysisFilter = filterChain
    ? `${filterChain},loudnorm=I=${LOUDNESS_CONFIG.TARGET_LUFS}:TP=${LOUDNESS_CONFIG.TRUE_PEAK_CEILING}:print_format=json`
    : `loudnorm=I=${LOUDNESS_CONFIG.TARGET_LUFS}:TP=${LOUDNESS_CONFIG.TRUE_PEAK_CEILING}:print_format=json`

  const args = [
    '-y',
    '-ss', startTime.toString(),
    '-t', duration.toString(),
    '-i', inputPath,
    '-af', analysisFilter,
    '-f', 'null',
    '-'
  ]

  console.log('[loudness] Analyzing:', 'ffmpeg', args.join(' '))

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args)
    let stderr = ''
    let resolved = false

    const cleanup = () => {
      if (!resolved) {
        resolved = true
        if (proc && !proc.killed) {
          try {
            proc.kill('SIGTERM')
          } catch (err) {
            // Ignore kill errors
          }
        }
      }
    }

    // Timeout protection
    const timeoutHandle = setTimeout(() => {
      console.warn('[loudness] Analysis timed out after', timeoutMs, 'ms')
      cleanup()
      resolve(null)
    }, timeoutMs)

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeoutHandle)

      if (code !== 0) {
        console.warn('[loudness] Analysis exited with code:', code)
        resolve(null)
        return
      }

      // Parse loudnorm JSON from stderr
      const analysis = parseLoudnormOutput(stderr)
      if (!analysis) {
        console.warn('[loudness] Failed to parse loudnorm output')
        resolve(null)
        return
      }

      console.log('[loudness] Analysis result:', analysis)
      resolve(analysis)
    })

    proc.on('error', (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeoutHandle)
      console.error('[loudness] Analysis spawn error:', err)
      resolve(null)
    })
  })
}

/**
 * Build full audio filter chain.
 *
 * Signal chain order (when enabled):
 *   NR → HPF → LPF → EQ → Compressor → AutoMix
 *
 * Rationale:
 * - NR first: removes noise before any frequency shaping
 * - HPF/LPF next: bandwidth limiting before tonal adjustment
 * - EQ: tonal shaping on clean, bandwidth-limited signal
 * - Compressor: dynamics control on shaped signal
 * - AutoMix last: final-stage leveling as output processor
 */
export function buildFullFilterChain(hpf: FilterParams, bands: EQBand[], lpf: FilterParams, compressor: CompressorParams, noiseReduction: NoiseReductionParams, autoMix?: AutoMixParams): string {
  const filters: string[] = []

  // 1. Noise reduction (first - remove noise before any processing)
  const nrFilter = buildNoiseReductionFilter(noiseReduction)
  if (nrFilter) {
    filters.push(nrFilter)
  }

  // 2. High-pass filter (bandwidth limiting)
  if (hpf.enabled) {
    filters.push(`highpass=f=${hpf.frequency}`)
  }

  // 3. Low-pass filter (bandwidth limiting)
  if (lpf.enabled) {
    filters.push(`lowpass=f=${lpf.frequency}`)
  }

  // 4. Parametric EQ bands (tonal shaping)
  const eqFilter = buildEQFilter(bands)
  if (eqFilter) {
    filters.push(eqFilter)
  }

  // 5. Compressor/Limiter (dynamics control)
  const compFilter = buildCompressorFilter(compressor)
  if (compFilter) {
    filters.push(compFilter)
  }

  // 6. AutoMix (final-stage leveling - always last)
  if (autoMix) {
    const autoMixFilter = buildAutoMixFilter(autoMix)
    if (autoMixFilter) {
      filters.push(autoMixFilter)
    }
  }

  return filters.join(',')
}

/**
 * Get last N lines of stderr for diagnostics (keep small to avoid bloat)
 */
function getStderrTail(stderr: string, lines: number = 20): string {
  const allLines = stderr.split('\n')
  return allLines.slice(-lines).join('\n')
}

/**
 * Map common FFmpeg stderr patterns to user-actionable guidance
 */
function diagnoseFFmpegFailure(stderr: string): string | null {
  const stderrLower = stderr.toLowerCase()

  if (stderrLower.includes('unknown encoder') || stderrLower.includes('encoder not found')) {
    return 'Missing video codec. FFmpeg may not be built with required encoders.'
  }
  if (stderrLower.includes('invalid data found') || stderrLower.includes('moov atom not found')) {
    return 'File may be corrupt or incomplete.'
  }
  if (stderrLower.includes('permission denied') || stderrLower.includes('operation not permitted')) {
    return 'Permission denied. Check file/directory permissions.'
  }
  if (stderrLower.includes('no space left on device') || stderrLower.includes('disk full')) {
    return 'Disk space full. Free up space and try again.'
  }
  if (stderrLower.includes('unsupported codec') || stderrLower.includes('codec not currently supported')) {
    return 'Input file uses unsupported codec. Try a different file or update FFmpeg.'
  }
  if (stderrLower.includes('invalid argument')) {
    return 'Invalid FFmpeg parameters. This may be a bug.'
  }

  return null
}

/**
 * Clean up an FFmpeg job: kill process, clear timeout, remove from registry.
 * Idempotent and safe to call multiple times.
 */
export function cleanupFFmpegJob(jobId: string): void {
  const job = activeFFmpegJobs.get(jobId)
  if (!job) return

  // Clear timeout if exists
  if (job.timeoutHandle) {
    clearTimeout(job.timeoutHandle)
  }

  // Kill process if still running
  if (job.process && !job.process.killed) {
    try {
      job.process.kill('SIGTERM')
      // Give it a moment, then force kill if needed
      setTimeout(() => {
        if (job.process && !job.process.killed) {
          job.process.kill('SIGKILL')
        }
      }, 1000)
    } catch (err) {
      console.error('[ffmpeg] Failed to kill process:', err)
    }
  }

  // Remove from registry
  activeFFmpegJobs.delete(jobId)
  console.log(`[ffmpeg] Cleaned up job ${jobId}, ${activeFFmpegJobs.size} jobs remaining`)

  // Clean up job temp directory (but NOT for preview renders - those need to persist)
  // Preview files are cleaned by:
  // 1. Next preview render (creates new temp dir)
  // 2. App quit
  // 3. Stale cleanup (24h old files)
  const isPreviewJob = job.phase?.includes('preview')
  if (job.tempDir && !isPreviewJob) {
    cleanupJobTempDir(jobId, job.tempDir)
  } else if (isPreviewJob) {
    console.log(`[temp] Preserving preview temp directory for playback: ${job.tempDir}`)
  }
}

/**
 * Run FFmpeg with job tracking, timeout enforcement, progress reporting, and guaranteed cleanup.
 *
 * @param args FFmpeg command-line arguments
 * @param timeoutMs Timeout in milliseconds (default: 5 minutes)
 * @param durationSeconds Expected duration in seconds for progress calculation (optional)
 * @param phase Job context/phase name for progress events (optional)
 * @param providedJobId Optional pre-generated job ID (for coordinating with caller)
 * @param mainWindow Main browser window to send events to
 * @returns Promise that resolves with FFmpeg result or rejects with structured error
 */
export function runFFmpeg(
  args: string[],
  timeoutMs: number = 5 * 60 * 1000,
  durationSeconds?: number,
  phase?: string,
  providedJobId?: string,
  mainWindow?: BrowserWindow | null
): Promise<FFmpegResult> {
  return new Promise((resolve, reject) => {
    // Use provided job ID or generate unique one
    const jobId = providedJobId || `ffmpeg-${Date.now()}-${Math.random().toString(36).substring(7)}`

    // Create job temp directory (safe to call even if already created)
    const jobTempDir = createJobTempDir(jobId)

    console.log(`[ffmpeg] Starting job ${jobId}:`, 'ffmpeg', args.join(' '))

    // Spawn FFmpeg process
    const proc = spawn('ffmpeg', args)
    let stderr = ''
    let resolved = false

    // Helper to resolve/reject only once
    const resolveOnce = (result: FFmpegResult) => {
      if (resolved) return
      resolved = true
      cleanupFFmpegJob(jobId)
      resolve(result)
    }

    const rejectOnce = (error: FFmpegError) => {
      if (resolved) return
      resolved = true
      cleanupFFmpegJob(jobId)
      reject(error)
    }

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      console.error(`[ffmpeg] Job ${jobId} timed out after ${timeoutMs}ms`)
      const job = activeFFmpegJobs.get(jobId)
      if (job) {
        emitTerminalState(job, 'timed_out', undefined, mainWindow || null)
      }
      rejectOnce({
        type: FFmpegErrorType.TIMEOUT,
        message: `FFmpeg operation timed out after ${timeoutMs / 1000}s`,
        stderr
      })
    }, timeoutMs)

    // Register job
    const job: FFmpegJob = {
      id: jobId,
      process: proc,
      startTime: Date.now(),
      timeoutHandle,
      durationSeconds,
      phase,
      tempDir: jobTempDir
    }
    activeFFmpegJobs.set(jobId, job)
    console.log(`[ffmpeg] Registered job ${jobId}, ${activeFFmpegJobs.size} jobs active`)

    // Emit initial queued state
    if (mainWindow && !mainWindow.isDestroyed()) {
      const event: JobProgressEvent = {
        jobId,
        status: 'queued',
        phase,
        durationSeconds,
        indeterminate: !durationSeconds
      }
      mainWindow.webContents.send('job:progress', event)
    }

    // Capture stderr and parse for progress
    let stderrBuffer = ''
    proc.stderr.on('data', (data) => {
      const chunk = data.toString()
      stderr += chunk
      stderrBuffer += chunk

      // Process complete lines
      const lines = stderrBuffer.split('\n')
      stderrBuffer = lines.pop() || ''  // Keep incomplete line in buffer

      for (const line of lines) {
        const progress = parseFFmpegProgress(line)
        if (progress) {
          emitProgress(job, progress.positionSeconds, 'running', mainWindow || null)
        }
      }
    })

    // Handle process exit
    proc.on('close', (code) => {
      const duration = Date.now() - job.startTime
      console.log(`[ffmpeg] Job ${jobId} exited with code ${code} after ${duration}ms`)

      if (code === 0) {
        emitTerminalState(job, 'completed', 1.0, mainWindow || null)
        resolveOnce({ success: true, stderr })
      } else {
        emitTerminalState(job, 'failed', undefined, mainWindow || null)
        rejectOnce({
          type: FFmpegErrorType.NON_ZERO_EXIT,
          message: `FFmpeg exited with code ${code}`,
          stderr,
          exitCode: code
        })
      }
    })

    // Handle spawn errors
    proc.on('error', (err) => {
      console.error(`[ffmpeg] Job ${jobId} spawn error:`, err)
      emitTerminalState(job, 'failed', undefined, mainWindow || null)
      rejectOnce({
        type: FFmpegErrorType.SPAWN_FAILED,
        message: `Failed to start FFmpeg: ${err.message}`,
        stderr
      })
    })
  })
}

/**
 * Try multiple render strategies (copy → re-encode) and collect failures
 * Returns success result or throws with all attempt failures
 */
export async function tryRenderStrategies(
  attempts: RenderAttempt[],
  context: string,
  durationSeconds?: number,
  phase?: string,
  jobId?: string,
  mainWindow?: BrowserWindow | null
): Promise<FFmpegResult> {
  const failures: RenderAttemptFailure[] = []

  for (const attempt of attempts) {
    try {
      console.log(`[${context}] Trying ${attempt.name}:`, attempt.args.join(' '))
      const result = await runFFmpeg(attempt.args, 5 * 60 * 1000, durationSeconds, phase, jobId, mainWindow)
      console.log(`[${context}] ${attempt.name} succeeded`)
      return result
    } catch (error: any) {
      console.error(`[${context}] ${attempt.name} failed:`, error.type, error.message)

      // Only retry on NON_ZERO_EXIT (codec/encoding failures)
      // For TIMEOUT, CANCELLED, SPAWN_FAILED - fail immediately
      if (error.type !== FFmpegErrorType.NON_ZERO_EXIT) {
        throw error
      }

      // Record failure for diagnostics
      failures.push({
        attempt: attempt.name,
        error: error as FFmpegError,
        stderrTail: error.stderr ? getStderrTail(error.stderr) : undefined
      })

      // If this was the last attempt, throw comprehensive error
      if (attempt === attempts[attempts.length - 1]) {
        const diagnosis = error.stderr ? diagnoseFFmpegFailure(error.stderr) : null
        const failureList = failures.map(f => `${f.attempt}: ${f.error.message}`).join('; ')

        throw {
          type: FFmpegErrorType.NON_ZERO_EXIT,
          message: diagnosis
            ? `All render attempts failed. ${diagnosis}\nAttempts: ${failureList}`
            : `All render attempts failed: ${failureList}`,
          stderr: error.stderr,
          exitCode: error.exitCode,
          attempts: failures
        }
      }

      // Continue to next attempt
    }
  }

  // Should never reach here (loop always returns or throws)
  throw new Error('No render attempts provided')
}

/**
 * Get all active FFmpeg jobs
 */
export function getActiveFFmpegJobs(): Map<string, FFmpegJob> {
  return activeFFmpegJobs
}

/**
 * Cancel an FFmpeg job by ID
 */
export function cancelFFmpegJob(jobId: string, mainWindow: BrowserWindow | null): { success: boolean; message: string } {
  const job = activeFFmpegJobs.get(jobId)

  if (!job) {
    return {
      success: false,
      message: `Job ${jobId} not found or already completed`
    }
  }

  console.log(`[ffmpeg] Cancelling job ${jobId}`)

  // Emit cancelled state before cleanup
  emitTerminalState(job, 'cancelled', undefined, mainWindow)

  // Clean up will kill the process
  cleanupFFmpegJob(jobId)

  return {
    success: true,
    message: `Job ${jobId} cancelled successfully`
  }
}

/**
 * Parse FFmpeg silencedetect output into quiet region segments.
 *
 * silencedetect outputs lines like:
 *   [silencedetect @ 0x...] silence_start: 1.234
 *   [silencedetect @ 0x...] silence_end: 2.567 | silence_duration: 1.333
 *
 * @param stderr FFmpeg stderr output containing silencedetect results
 * @returns Array of { startMs, endMs } segments
 */
export function parseSilenceDetectOutput(stderr: string): QuietCandidate[] {
  const candidates: QuietCandidate[] = []
  const lines = stderr.split('\n')

  let currentStart: number | null = null

  for (const line of lines) {
    // Match silence_start: <seconds>
    const startMatch = line.match(/silence_start:\s*([\d.]+)/)
    if (startMatch) {
      currentStart = parseFloat(startMatch[1])
      continue
    }

    // Match silence_end: <seconds>
    const endMatch = line.match(/silence_end:\s*([\d.]+)/)
    if (endMatch && currentStart !== null) {
      const endSec = parseFloat(endMatch[1])
      candidates.push({
        startMs: Math.round(currentStart * 1000),
        endMs: Math.round(endSec * 1000)
      })
      currentStart = null
    }
  }

  return candidates
}

/**
 * Sort quiet candidates by duration (DESC), then by start time (ASC).
 *
 * @param candidates Array of quiet candidates
 * @returns Sorted array (new array, original unchanged)
 */
export function sortQuietCandidates(candidates: QuietCandidate[]): QuietCandidate[] {
  return [...candidates].sort((a, b) => {
    const durationA = a.endMs - a.startMs
    const durationB = b.endMs - b.startMs

    // Primary: duration DESC
    if (durationB !== durationA) {
      return durationB - durationA
    }

    // Tie-break: start ASC
    return a.startMs - b.startMs
  })
}

/**
 * Run volumedetect analysis on audio file for diagnostic purposes.
 * Returns mean and max volume levels.
 */
async function analyzeVolumeLevels(inputPath: string): Promise<{ mean_volume: string; max_volume: string } | null> {
  return new Promise((resolve) => {
    const args = [
      '-i', inputPath,
      '-af', 'volumedetect',
      '-f', 'null',
      '-'
    ]

    const proc = spawn('ffmpeg', args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', () => {
      // Parse volumedetect output
      const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/)
      const maxMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/)

      if (meanMatch && maxMatch) {
        resolve({
          mean_volume: meanMatch[1],
          max_volume: maxMatch[1]
        })
      } else {
        resolve(null)
      }
    })

    proc.on('error', () => resolve(null))

    // Timeout after 30s
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM')
      }
      resolve(null)
    }, 30000)
  })
}

/**
 * Detect quiet regions in audio using FFmpeg silencedetect filter.
 *
 * @param inputPath Path to input media file
 * @param timeoutMs Timeout in milliseconds (default: 60s)
 * @returns Promise resolving to sorted, capped array of quiet candidates
 */
export async function detectQuietCandidates(
  inputPath: string,
  timeoutMs: number = 60000
): Promise<QuietCandidate[]> {
  const {
    PROOF_MODE,
    PROOF_THRESHOLD_DB,
    PROOF_MIN_DURATION_SEC,
    THRESHOLD_OFFSET_DB,
    THRESHOLD_MIN_DB,
    THRESHOLD_MAX_DB,
    MIN_DURATION_SEC,
    MAX_CANDIDATES
  } = QUIET_DETECTION_CONFIG

  console.log('[silencedetect] ========== DETECTION START ==========')
  console.log('[silencedetect] Input:', inputPath)

  let silenceThreshold: number
  let minDuration: number

  if (PROOF_MODE) {
    // === PROOF MODE: Maximally permissive settings ===
    console.log('[silencedetect] *** PROOF MODE ENABLED ***')
    silenceThreshold = PROOF_THRESHOLD_DB
    minDuration = PROOF_MIN_DURATION_SEC
    console.log('[silencedetect] Using proof mode settings:')
    console.log('[silencedetect]   threshold:', silenceThreshold, 'dB')
    console.log('[silencedetect]   min_duration:', minDuration, 's')
  } else {
    // === Normal mode: Dynamic threshold based on content ===
    console.log('[silencedetect] Running volumedetect analysis...')

    const volumeInfo = await analyzeVolumeLevels(inputPath)
    if (!volumeInfo) {
      console.log('[silencedetect] volumedetect failed - cannot compute dynamic threshold')
      console.log('[silencedetect] ========== DETECTION END ==========')
      return []
    }

    const meanVolume = parseFloat(volumeInfo.mean_volume)
    console.log('[silencedetect] Volume analysis:')
    console.log('[silencedetect]   mean_volume:', volumeInfo.mean_volume, 'dB')
    console.log('[silencedetect]   max_volume:', volumeInfo.max_volume, 'dB')

    // threshold = mean_volume - offset, clamped to [min, max]
    const rawThreshold = meanVolume - THRESHOLD_OFFSET_DB
    silenceThreshold = Math.max(THRESHOLD_MIN_DB, Math.min(THRESHOLD_MAX_DB, rawThreshold))
    minDuration = MIN_DURATION_SEC

    console.log('[silencedetect] Dynamic threshold:')
    console.log('[silencedetect]   formula: mean_volume - offset =', meanVolume, '-', THRESHOLD_OFFSET_DB, '=', rawThreshold, 'dB')
    console.log('[silencedetect]   clamped to [', THRESHOLD_MIN_DB, ',', THRESHOLD_MAX_DB, ']:', silenceThreshold, 'dB')
    console.log('[silencedetect]   min_duration:', minDuration, 's')
  }

  // === Run silencedetect ===
  const args = [
    '-i', inputPath,
    '-af', `silencedetect=noise=${silenceThreshold}dB:d=${minDuration}`,
    '-f', 'null',
    '-'
  ]

  const fullCommand = 'ffmpeg ' + args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')
  console.log('[silencedetect] Command:', fullCommand)

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args)
    let stderr = ''
    let resolved = false

    const cleanup = () => {
      if (!resolved) {
        resolved = true
        if (proc && !proc.killed) {
          try {
            proc.kill('SIGTERM')
          } catch (err) {
            // Ignore kill errors
          }
        }
      }
    }

    // Timeout protection
    const timeoutHandle = setTimeout(() => {
      console.warn('[silencedetect] Detection timed out after', timeoutMs, 'ms')
      cleanup()
      resolve([])  // Return empty on timeout
    }, timeoutMs)

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeoutHandle)

      console.log('[silencedetect] FFmpeg exit code:', code)

      if (code !== 0) {
        console.warn('[silencedetect] Detection exited with code:', code)
        // Don't reject - return empty array on failure
        resolve([])
        return
      }

      // Parse silencedetect output
      const rawCandidates = parseSilenceDetectOutput(stderr)

      // Sort by duration DESC, start ASC
      const sorted = sortQuietCandidates(rawCandidates)

      // Cap to MAX_CANDIDATES
      const capped = sorted.slice(0, MAX_CANDIDATES)

      console.log('[silencedetect] Found', rawCandidates.length, 'quiet regions, returning top', capped.length)
      if (capped.length > 0) {
        console.log('[silencedetect] Top candidates (ms):', capped.map(c => `${c.startMs}-${c.endMs}`).join(', '))
      } else if (PROOF_MODE) {
        console.log('[silencedetect] *** PROOF MODE FAILED - 0 candidates ***')
        console.log('[silencedetect] STDERR (last 30 lines):')
        const stderrLines = stderr.split('\n')
        stderrLines.slice(-30).forEach(l => console.log('[silencedetect]  ', l))
      }
      console.log('[silencedetect] ========== DETECTION END ==========')

      resolve(capped)
    })

    proc.on('error', (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeoutHandle)
      console.error('[silencedetect] Spawn error:', err)
      resolve([])  // Return empty on spawn error
    })
  })
}
