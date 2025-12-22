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
import type { TranscriptV1, EdlV1 } from '../shared/editor-types'
import { extractVideoMetadata } from './media-metadata'
import { extractAudioForASR, cleanupAudioFile } from './audio-extraction'
import { getTranscriber } from './asr-adapter'
import { renderFinal } from './final-render'

let mainWindow: BrowserWindow | null = null

// Ensure tmp directory exists
const tmpDir = path.join(process.cwd(), 'tmp')
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true })
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
  // Handle appfile:// protocol - proxy to file:// via net.fetch (supports Range requests)
  protocol.handle('appfile', (request) => {
    // appfile:///absolute/path -> /absolute/path
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    const absolutePath = path.resolve(filePath)

    // Use pathToFileURL + net.fetch to properly serve files with streaming support
    const fileUrl = pathToFileURL(absolutePath).href
    return net.fetch(fileUrl)
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
  return result.filePaths[0]
})

ipcMain.handle('save-dialog', async (_event, defaultPath: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath,
    filters: [
      { name: 'Video Files', extensions: ['mp4'] }
    ]
  })
  if (result.canceled || !result.filePath) {
    return null
  }
  return result.filePath
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

  // Generate unique filenames per render
  const baseName = path.basename(inputPath, path.extname(inputPath))
  const renderId = Date.now()
  const originalOutput = path.join(tmpDir, `${baseName}-original-${renderId}.mp4`)
  const processedOutput = path.join(tmpDir, `${baseName}-processed-${renderId}.mp4`)

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

// Transcript generation handler
ipcMain.handle('get-transcript', async (_event, filePath: string): Promise<{ transcript: TranscriptV1; edl: EdlV1 }> => {
  // 1. Extract video metadata to get video_id
  const videoAsset = await extractVideoMetadata(filePath)

  // 2. Extract audio for ASR
  const audioPath = await extractAudioForASR(filePath, tmpDir)

  try {
    // 3. Run ASR
    const transcriber = getTranscriber()
    const transcript = await transcriber.transcribe(audioPath, videoAsset.video_id)

    // 4. Create initial EDL for this media
    const edl: EdlV1 = {
      version: '1',
      video_id: videoAsset.video_id,
      edl_version_id: `edl-initial-${Date.now()}`,
      created_at: new Date().toISOString(),
      params: {
        merge_threshold_ms: 80,
        pre_roll_ms: 40,
        post_roll_ms: 40,
        audio_crossfade_ms: 12
      },
      remove_ranges: []
    }

    return { transcript, edl }
  } finally {
    // 5. Cleanup temp audio file
    cleanupAudioFile(audioPath)
  }
})

// Final render handler - exports edited video
ipcMain.handle('render-final', async (_event, filePath: string, edl: EdlV1, outputPath: string): Promise<{ success: boolean; outputPath?: string; error?: string }> => {
  try {
    // 1. Extract video metadata
    const videoAsset = await extractVideoMetadata(filePath)

    // 2. Render final video
    const report = await renderFinal({
      videoAsset,
      edl,
      outputPath
    })

    return {
      success: true,
      outputPath: report.output_path
    }
  } catch (err) {
    return {
      success: false,
      error: String(err)
    }
  }
})
