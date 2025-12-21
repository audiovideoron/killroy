import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'
import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  RenderOptions,
  JobProgressEvent,
  JobStatus
} from '../shared/types'

let mainWindow: BrowserWindow | null = null

/**
 * FFmpeg job tracking for lifecycle management.
 * Ensures all FFmpeg processes are tracked, cancellable, and cleaned up.
 */
interface FFmpegJob {
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
 * Path validation failure reasons
 */
type PathValidationFailure =
  | 'NOT_ABSOLUTE'
  | 'NOT_FOUND'
  | 'NOT_READABLE'
  | 'NOT_FILE'
  | 'UNSUPPORTED_TYPE'

type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; reason: PathValidationFailure; message: string }

/**
 * Supported media file extensions (video with audio tracks)
 */
const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm',
  '.m4v', '.flv', '.wmv', '.mpg', '.mpeg',
  '.3gp', '.ogv', '.ts', '.mts', '.m2ts'
])

/**
 * Progress information parsed from FFmpeg stderr
 */
interface FFmpegProgress {
  positionSeconds: number
  rawLine: string
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
 */
function emitProgress(job: FFmpegJob, positionSeconds: number, status: JobStatus = 'running'): void {
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
 */
function emitTerminalState(job: FFmpegJob, status: JobStatus, percent?: number): void {
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
 * Validate a user-supplied media file path before FFmpeg/ffprobe execution.
 * Checks: absolute path, existence, readability, is file, supported extension.
 *
 * @param filePath User-supplied path (must be absolute)
 * @returns Validation result with typed failure reasons
 */
function validateMediaPath(filePath: string): PathValidationResult {
  // Must be absolute path
  if (!path.isAbsolute(filePath)) {
    return {
      ok: false,
      reason: 'NOT_ABSOLUTE',
      message: `Path must be absolute: ${filePath}`
    }
  }

  // Check file exists and get stats
  let stats: fs.Stats
  try {
    stats = fs.statSync(filePath)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        reason: 'NOT_FOUND',
        message: `File not found: ${filePath}`
      }
    }
    if (err.code === 'EACCES') {
      return {
        ok: false,
        reason: 'NOT_READABLE',
        message: `Permission denied: ${filePath}`
      }
    }
    return {
      ok: false,
      reason: 'NOT_READABLE',
      message: `Cannot access file: ${err.message}`
    }
  }

  // Must be a regular file (not directory, symlink, etc)
  if (!stats.isFile()) {
    return {
      ok: false,
      reason: 'NOT_FILE',
      message: `Path is not a regular file: ${filePath}`
    }
  }

  // Check file is readable
  try {
    fs.accessSync(filePath, fs.constants.R_OK)
  } catch {
    return {
      ok: false,
      reason: 'NOT_READABLE',
      message: `File is not readable: ${filePath}`
    }
  }

  // Check extension is supported
  const ext = path.extname(filePath).toLowerCase()
  if (!SUPPORTED_MEDIA_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_TYPE',
      message: `Unsupported file type: ${ext}. Supported: ${Array.from(SUPPORTED_MEDIA_EXTENSIONS).join(', ')}`
    }
  }

  return { ok: true, path: filePath }
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

interface FFprobeResult {
  streams: FFprobeStream[]
  format: FFprobeFormat
}

/**
 * Probe media file metadata using ffprobe with structured JSON output.
 * Much faster and more reliable than parsing ffmpeg stderr.
 *
 * @param filePath Absolute path to media file (must be validated first)
 * @returns Promise resolving to parsed ffprobe JSON data
 */
async function probeMediaMetadata(filePath: string): Promise<FFprobeResult> {
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
 * DEPRECATED: Use createJobTempDir() instead for per-job isolation.
 * Get the application's temporary directory for preview files.
 * Uses Electron's temp path API to work correctly when packaged.
 * Creates the directory if it doesn't exist.
 *
 * @returns Absolute path to app-specific temp directory
 */
function getTempDir(): string {
  // Use Electron's temp directory API (works in dev and packaged app)
  // Create app-specific subdirectory to avoid conflicts
  const appTempDir = path.join(app.getPath('temp'), 'audio-pro-previews')

  if (!fs.existsSync(appTempDir)) {
    fs.mkdirSync(appTempDir, { recursive: true })
  }

  return appTempDir
}

/**
 * Create a temporary directory for a specific job.
 * All intermediate files for this job should be written here.
 *
 * @param jobId Unique job identifier
 * @returns Absolute path to job-specific temp directory
 */
function createJobTempDir(jobId: string): string {
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
function cleanupJobTempDir(jobId: string, tempDir?: string): void {
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
function cleanupStaleJobDirs(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
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

// Initialize temp directory (will be created on first access)
let tmpDir: string

// Security: Allowlist of approved file paths for appfile:// protocol
// Only files explicitly approved (user-selected or app-generated) can be served
const approvedFilePaths = new Set<string>()

/**
 * Safely resolve and normalize a file path for comparison.
 * Handles platform-specific path separators and case sensitivity.
 */
function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath)
  // Normalize to lowercase on Windows for case-insensitive comparison
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Add a file path to the approved list for appfile:// protocol access.
 * Path is normalized to prevent bypasses via different representations.
 */
function approveFilePath(filePath: string): void {
  const normalized = normalizePath(filePath)
  approvedFilePaths.add(normalized)
  console.log('[security] Approved file path:', normalized)
}

/**
 * Check if a file path is approved for appfile:// protocol access.
 * Returns the normalized path if approved, null otherwise.
 */
function validateFilePath(requestedPath: string): string | null {
  try {
    const normalized = normalizePath(requestedPath)
    if (approvedFilePaths.has(normalized)) {
      return normalized
    }
    console.warn('[security] Rejected unapproved file path:', requestedPath)
    return null
  } catch (err) {
    console.error('[security] Path validation error:', err)
    return null
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 1300,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// Register custom protocol for serving local files to renderer
// Note: bypassCSP is NOT needed for media playback via <video> src
// stream + supportFetchAPI are sufficient for video streaming with range requests
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appfile',
    privileges: {
      stream: true,
      supportFetchAPI: true
    }
  }
])

app.whenReady().then(() => {
  // Initialize temp directory using Electron's path API
  tmpDir = getTempDir()

  // Clean up stale job directories from previous runs
  cleanupStaleJobDirs()

  // Handle appfile:// protocol - proxy to file:// via net.fetch (supports Range requests)
  // Security: Only serves files that have been explicitly approved via the allowlist
  protocol.handle('appfile', (request) => {
    try {
      // appfile:///absolute/path -> /absolute/path
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname)

      // Validate against allowlist
      const validatedPath = validateFilePath(filePath)
      if (!validatedPath) {
        console.error('[security] Blocked appfile request for unapproved path:', filePath)
        return new Response('Forbidden: File not approved for access', { status: 403 })
      }

      // Use pathToFileURL + net.fetch to properly serve files with streaming support
      const fileUrl = pathToFileURL(validatedPath).href
      return net.fetch(fileUrl)
    } catch (err) {
      console.error('[security] appfile protocol error:', err)
      return new Response('Bad Request', { status: 400 })
    }
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// Cleanup on app quit: kill all FFmpeg processes, remove temp directory
app.on('will-quit', () => {
  // Clean up all active FFmpeg jobs
  try {
    if (activeFFmpegJobs.size > 0) {
      console.log(`[cleanup] Killing ${activeFFmpegJobs.size} active FFmpeg jobs`)
      const jobIds = Array.from(activeFFmpegJobs.keys())
      for (const jobId of jobIds) {
        cleanupFFmpegJob(jobId)
      }
      console.log('[cleanup] All FFmpeg jobs terminated')
    }
  } catch (err) {
    console.error('[cleanup] Failed to clean FFmpeg jobs:', err)
  }

  // Clean up temp directory
  try {
    if (tmpDir && fs.existsSync(tmpDir)) {
      // Remove all preview files from temp directory
      const files = fs.readdirSync(tmpDir)
      for (const file of files) {
        const filePath = path.join(tmpDir, file)
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
        }
      }
      // Remove the directory itself
      fs.rmdirSync(tmpDir)
      console.log('[cleanup] Removed temp directory:', tmpDir)
    }
  } catch (err) {
    console.error('[cleanup] Failed to clean temp directory:', err)
  }
})

// IPC Handlers

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: 'Video Files', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  const selectedPath = result.filePaths[0]
  // Approve user-selected file for appfile:// protocol access
  approveFilePath(selectedPath)
  return selectedPath
})

function buildEQFilter(bands: EQBand[]): string {
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

function buildCompressorFilter(comp: CompressorParams): string {
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
function buildNoiseReductionFilter(nr: NoiseReductionParams): string {
  if (!nr.enabled || nr.strength <= 0) return ''

  // Map strength 0-100 to nr (noise reduction) 0-40 dB
  const nrValue = Math.round((nr.strength / 100) * 40)

  // Map strength to noise floor: -50 at 0% to -35 at 100%
  // Higher floor = less aggressive (avoids eating wanted audio)
  const nfValue = Math.round(-50 + (nr.strength / 100) * 15)

  // Enable noise tracking for adaptive behavior
  return `afftdn=nr=${nrValue}:nf=${nfValue}:tn=true`
}

function buildFullFilterChain(hpf: FilterParams, bands: EQBand[], lpf: FilterParams, compressor: CompressorParams, noiseReduction: NoiseReductionParams): string {
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
 * Structured error types for FFmpeg operations
 */
enum FFmpegErrorType {
  SPAWN_FAILED = 'spawn_failed',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled',
  NON_ZERO_EXIT = 'non_zero_exit'
}

interface FFmpegError {
  type: FFmpegErrorType
  message: string
  stderr?: string
  exitCode?: number
}

interface FFmpegResult {
  success: boolean
  stderr: string
  error?: FFmpegError
}

/**
 * Render attempt strategies (copy → re-encode → last resort)
 */
type RenderAttemptType = 'COPY' | 'REENCODE' | 'LAST_RESORT'

interface RenderAttempt {
  name: RenderAttemptType
  args: string[]
}

interface RenderAttemptFailure {
  attempt: RenderAttemptType
  error: FFmpegError
  stderrTail?: string
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
 * Try multiple render strategies (copy → re-encode) and collect failures
 * Returns success result or throws with all attempt failures
 */
async function tryRenderStrategies(
  attempts: RenderAttempt[],
  context: string,
  durationSeconds?: number,
  phase?: string,
  jobId?: string
): Promise<FFmpegResult> {
  const failures: RenderAttemptFailure[] = []

  for (const attempt of attempts) {
    try {
      console.log(`[${context}] Trying ${attempt.name}:`, attempt.args.join(' '))
      const result = await runFFmpeg(attempt.args, 5 * 60 * 1000, durationSeconds, phase, jobId)
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
 * Clean up an FFmpeg job: kill process, clear timeout, remove from registry.
 * Idempotent and safe to call multiple times.
 */
function cleanupFFmpegJob(jobId: string): void {
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

  // Clean up job temp directory
  if (job.tempDir) {
    cleanupJobTempDir(jobId, job.tempDir)
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
 * @returns Promise that resolves with FFmpeg result or rejects with structured error
 */
function runFFmpeg(
  args: string[],
  timeoutMs: number = 5 * 60 * 1000,
  durationSeconds?: number,
  phase?: string,
  providedJobId?: string
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
        emitTerminalState(job, 'timed_out')
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
          emitProgress(job, progress.positionSeconds)
        }
      }
    })

    // Handle process exit
    proc.on('close', (code) => {
      const duration = Date.now() - job.startTime
      console.log(`[ffmpeg] Job ${jobId} exited with code ${code} after ${duration}ms`)

      if (code === 0) {
        emitTerminalState(job, 'completed', 1.0)
        resolveOnce({ success: true, stderr })
      } else {
        emitTerminalState(job, 'failed')
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
      emitTerminalState(job, 'failed')
      rejectOnce({
        type: FFmpegErrorType.SPAWN_FAILED,
        message: `Failed to start FFmpeg: ${err.message}`,
        stderr
      })
    })
  })
}

ipcMain.handle('render-preview', async (_event, options: RenderOptions) => {
  const { inputPath, startTime, duration, bands, hpf, lpf, compressor, noiseReduction } = options

  try {
    // VALIDATION: Verify input path before any FFmpeg/ffprobe execution
    const validation = validateMediaPath(inputPath)
    if (!validation.ok) {
      console.error('[render-preview] Validation failed:', validation.message)
      return {
        success: false,
        error: `Invalid input file: ${validation.message}`
      }
    }

    // Approve input file for appfile:// protocol access
    // (Should already be approved from select-file, but ensure it here for defense in depth)
    approveFilePath(inputPath)

    // Generate job ID and create temp directory for this render
    const jobId = `ffmpeg-${Date.now()}-${Math.random().toString(36).substring(7)}`
    const jobTempDir = createJobTempDir(jobId)

    // Generate unique filenames in job temp directory
    const baseName = path.basename(inputPath, path.extname(inputPath))
    const renderId = Date.now()
    const originalOutput = path.join(jobTempDir, `${baseName}-original-${renderId}.mp4`)
    const processedOutput = path.join(jobTempDir, `${baseName}-processed-${renderId}.mp4`)

    // Approve output files for appfile:// protocol access
    approveFilePath(originalOutput)
    approveFilePath(processedOutput)

    console.log('[render-preview] inputPath:', inputPath)
    console.log('[render-preview] outputs:', originalOutput, processedOutput)

    // Remove existing files (belt + suspenders)
    for (const f of [originalOutput, processedOutput]) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f)
      }
    }

    // PROBE: Check if input has audio using ffprobe (structured JSON output)
    let metadata: FFprobeResult
    try {
      metadata = await probeMediaMetadata(inputPath)
    } catch (err: any) {
      console.error('[render-preview] Probe failed:', err)
      return {
        success: false,
        error: `Failed to probe media file: ${err.message}`
      }
    }

    // Check for audio streams
    const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio')
    if (!hasAudio) {
      return {
        success: false,
        error: 'Input file has no audio stream. Cannot apply EQ.'
      }
    }

    // Render original preview with automatic copy → re-encode fallback
    const originalAttempts: RenderAttempt[] = [
      {
        name: 'COPY',
        args: [
          '-y',
          '-ss', startTime.toString(),
          '-t', duration.toString(),
          '-i', inputPath,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          originalOutput
        ]
      },
      {
        name: 'REENCODE',
        args: [
          '-y',
          '-ss', startTime.toString(),
          '-t', duration.toString(),
          '-i', inputPath,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-c:a', 'aac',
          '-b:a', '192k',
          originalOutput
        ]
      }
    ]

    await tryRenderStrategies(originalAttempts, 'original-preview', duration, 'original-preview', jobId)

    // Render processed preview with full filter chain (HPF -> EQ -> LPF -> Compressor)
    const filterChain = buildFullFilterChain(hpf, bands, lpf, compressor, noiseReduction)

    // Build attempts with automatic copy → re-encode fallback
    const processedAttempts: RenderAttempt[] = [
      {
        name: 'COPY',
        args: filterChain ? [
          '-y',
          '-ss', startTime.toString(),
          '-t', duration.toString(),
          '-i', inputPath,
          '-c:v', 'copy',
          '-af', filterChain,
          '-c:a', 'aac',
          '-b:a', '192k',
          processedOutput
        ] : [
          '-y',
          '-ss', startTime.toString(),
          '-t', duration.toString(),
          '-i', inputPath,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          processedOutput
        ]
      },
      {
        name: 'REENCODE',
        args: filterChain ? [
          '-y',
          '-ss', startTime.toString(),
          '-t', duration.toString(),
          '-i', inputPath,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-af', filterChain,
          '-c:a', 'aac',
          '-b:a', '192k',
          processedOutput
        ] : [
          '-y',
          '-ss', startTime.toString(),
          '-t', duration.toString(),
          '-i', inputPath,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-c:a', 'aac',
          '-b:a', '192k',
          processedOutput
        ]
      }
    ]

    await tryRenderStrategies(processedAttempts, 'processed-preview', duration, 'processed-preview', jobId)

    console.log('[render-preview] complete:', originalOutput, processedOutput)

    return {
      success: true,
      originalPath: originalOutput,
      processedPath: processedOutput,
      renderId,
      jobId
    }
  } catch (error: any) {
    console.error('[render-preview] FFmpeg error:', error)

    // Handle different error types
    let errorMessage: string
    if (error.type === FFmpegErrorType.TIMEOUT) {
      errorMessage = 'Render operation timed out. Try a shorter clip or simpler filters.'
    } else if (error.type === FFmpegErrorType.CANCELLED) {
      errorMessage = 'Render operation was cancelled.'
    } else if (error.type === FFmpegErrorType.SPAWN_FAILED) {
      errorMessage = `Failed to start FFmpeg: ${error.message}`
    } else if (error.type === FFmpegErrorType.NON_ZERO_EXIT) {
      errorMessage = `FFmpeg failed: ${error.message}\n${error.stderr || ''}`
    } else {
      errorMessage = `Unexpected error: ${error.message || error}`
    }

    return {
      success: false,
      error: errorMessage
    }
  }
})

ipcMain.handle('get-file-url', (_event, filePath: string) => {
  // Use custom appfile:// protocol to bypass file:// restrictions in dev mode
  return `appfile://${filePath}`
})

/**
 * Cancel an in-progress FFmpeg render.
 * Returns status of the cancellation attempt.
 */
ipcMain.handle('cancel-render', (_event, jobId: string) => {
  const job = activeFFmpegJobs.get(jobId)

  if (!job) {
    return {
      success: false,
      message: `Job ${jobId} not found or already completed`
    }
  }

  console.log(`[ffmpeg] Cancelling job ${jobId}`)

  // Emit cancelled state before cleanup
  emitTerminalState(job, 'cancelled')

  // Clean up will kill the process
  cleanupFFmpegJob(jobId)

  return {
    success: true,
    message: `Job ${jobId} cancelled successfully`
  }
})
