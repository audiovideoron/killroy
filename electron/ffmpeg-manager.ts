import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { app, BrowserWindow } from 'electron'
import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  JobProgressEvent,
  JobStatus
} from '../shared/types'

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
 *
 * @param filePath Absolute path to media file (must be validated first)
 * @returns Promise resolving to parsed ffprobe JSON data
 */
export async function probeMediaMetadata(filePath: string): Promise<FFprobeResult> {
  return new Promise((resolve, reject) => {
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

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
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
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`))
    })
  })
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
    const width = band.frequency / band.q
    return `equalizer=f=${band.frequency}:t=h:w=${width}:g=${band.gain}`
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
 * Build afftdn noise reduction filter from user-facing Strength (0-100).
 *
 * afftdn parameters used:
 * - nr: noise reduction in dB (0.01-97, default 12). Higher = more reduction.
 * - nf: noise floor in dB (-80 to -20, default -50). Higher = less aggressive detection.
 * - tn: track noise (boolean). Adapts to changing noise characteristics.
 *
 * Mapping strategy (conservative to avoid metallic artifacts):
 * - Strength 0: bypass (not in chain)
 * - Strength 25: light (nr=10, nf=-50) - subtle cleanup
 * - Strength 50: moderate (nr=20, nf=-45) - noticeable reduction
 * - Strength 75: strong (nr=30, nf=-40) - significant reduction
 * - Strength 100: maximum safe (nr=40, nf=-35) - aggressive but avoids artifacts
 *
 * Capped at 40dB to prevent metallic artifacts common at higher values.
 */
export function buildNoiseReductionFilter(nr: NoiseReductionParams): string {
  if (!nr.enabled || nr.strength <= 0) return ''

  // Map strength 0-100 to nr (noise reduction) 0-40 dB
  const nrValue = Math.round((nr.strength / 100) * 40)

  // Map strength to noise floor: -50 at 0% to -35 at 100%
  // Higher floor = less aggressive (avoids eating wanted audio)
  const nfValue = Math.round(-50 + (nr.strength / 100) * 15)

  // Enable noise tracking for adaptive behavior
  return `afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`
}

/**
 * Build full audio filter chain
 */
export function buildFullFilterChain(hpf: FilterParams, bands: EQBand[], lpf: FilterParams, compressor: CompressorParams, noiseReduction: NoiseReductionParams): string {
  const filters: string[] = []

  // 1. High-pass filter (if enabled)
  if (hpf.enabled) {
    filters.push(`highpass=f=${hpf.frequency}`)
  }

  // 2. Noise reduction (early in chain, before EQ)
  const nrFilter = buildNoiseReductionFilter(noiseReduction)
  if (nrFilter) {
    filters.push(nrFilter)
  }

  // 3. Parametric EQ bands
  const eqFilter = buildEQFilter(bands)
  if (eqFilter) {
    filters.push(eqFilter)
  }

  // 4. Low-pass filter (if enabled)
  if (lpf.enabled) {
    filters.push(`lowpass=f=${lpf.frequency}`)
  }

  // 5. Compressor/Limiter (after EQ, before final output)
  const compFilter = buildCompressorFilter(compressor)
  if (compFilter) {
    filters.push(compFilter)
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
