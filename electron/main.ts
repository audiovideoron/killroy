import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'
import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  RenderOptions
} from '../shared/types'

let mainWindow: BrowserWindow | null = null

/**
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
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'appfile',
    privileges: {
      bypassCSP: true,
      stream: true,
      supportFetchAPI: true
    }
  }
])

app.whenReady().then(() => {
  // Initialize temp directory using Electron's path API
  tmpDir = getTempDir()

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

// Cleanup temp directory on app quit
app.on('will-quit', () => {
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

function runFFmpeg(args: string[]): Promise<{ success: boolean; stderr: string }> {
  return new Promise((resolve) => {
    console.log('Running FFmpeg:', 'ffmpeg', args.join(' '))

    const proc = spawn('ffmpeg', args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        stderr
      })
    })

    proc.on('error', (err) => {
      resolve({
        success: false,
        stderr: `Failed to start FFmpeg: ${err.message}`
      })
    })
  })
}

ipcMain.handle('render-preview', async (_event, options: RenderOptions) => {
  const { inputPath, startTime, duration, bands, hpf, lpf, compressor, noiseReduction } = options

  // Approve input file for appfile:// protocol access
  // (Should already be approved from select-file, but ensure it here for defense in depth)
  approveFilePath(inputPath)

  // Generate unique filenames per render
  const baseName = path.basename(inputPath, path.extname(inputPath))
  const renderId = Date.now()
  const originalOutput = path.join(tmpDir, `${baseName}-original-${renderId}.mp4`)
  const processedOutput = path.join(tmpDir, `${baseName}-processed-${renderId}.mp4`)

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

  // Check if input has audio
  const probeResult = await runFFmpeg([
    '-i', inputPath,
    '-hide_banner'
  ])

  if (!probeResult.stderr.includes('Audio:')) {
    return {
      success: false,
      error: 'Input file has no audio stream. Cannot apply EQ.'
    }
  }

  // Render original preview (copy streams where possible)
  const originalArgs = [
    '-y',
    '-ss', startTime.toString(),
    '-t', duration.toString(),
    '-i', inputPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    originalOutput
  ]

  const origResult = await runFFmpeg(originalArgs)
  if (!origResult.success) {
    // Try re-encoding video if copy fails
    const fallbackArgs = [
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
    const fallbackResult = await runFFmpeg(fallbackArgs)
    if (!fallbackResult.success) {
      return {
        success: false,
        error: `Failed to render original preview:\n${fallbackResult.stderr}`
      }
    }
  }

  // Render processed preview with full filter chain (HPF -> EQ -> LPF -> Compressor)
  const filterChain = buildFullFilterChain(hpf, bands, lpf, compressor, noiseReduction)

  let processedArgs: string[]
  if (filterChain) {
    processedArgs = [
      '-y',
      '-ss', startTime.toString(),
      '-t', duration.toString(),
      '-i', inputPath,
      '-c:v', 'copy',
      '-af', filterChain,
      '-c:a', 'aac',
      '-b:a', '192k',
      processedOutput
    ]
  } else {
    // No filters applied, just copy
    processedArgs = [
      '-y',
      '-ss', startTime.toString(),
      '-t', duration.toString(),
      '-i', inputPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      processedOutput
    ]
  }

  const procResult = await runFFmpeg(processedArgs)
  if (!procResult.success) {
    // Try re-encoding video if copy fails
    const fallbackArgs = filterChain ? [
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

    const fallbackResult = await runFFmpeg(fallbackArgs)
    if (!fallbackResult.success) {
      return {
        success: false,
        error: `Failed to render processed preview:\n${fallbackResult.stderr}`
      }
    }
  }

  console.log('[render-preview] complete:', originalOutput, processedOutput)

  return {
    success: true,
    originalPath: originalOutput,
    processedPath: processedOutput,
    renderId
  }
})

ipcMain.handle('get-file-url', (_event, filePath: string) => {
  // Use custom appfile:// protocol to bypass file:// restrictions in dev mode
  return `appfile://${filePath}`
})
