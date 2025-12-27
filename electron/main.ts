import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import type {
  RenderOptions,
  EdlV1
} from '../shared/types'
import type { TranscriptV1 } from '../shared/editor-types'
import { extractVideoMetadata } from './media-metadata'
import { extractAudioForASR, cleanupAudioFile } from './audio-extraction'
import { getTranscriber } from './asr-adapter'
import { renderFinal } from './final-render'
import {
  buildFullFilterChain,
  buildEQFilter,
  buildCompressorFilter,
  buildNoiseReductionFilter,
  probeMediaMetadata,
  createJobTempDir,
  cleanupJobTempDir,
  cleanupStaleJobDirs,
  tryRenderStrategies,
  cleanupFFmpegJob,
  cancelFFmpegJob,
  getActiveFFmpegJobs,
  FFmpegErrorType,
  analyzeLoudness,
  calculateLoudnessGain,
  buildLoudnessGainFilter,
  detectQuietCandidates,
  type RenderAttempt
} from './ffmpeg-manager'
import {
  validateMediaPath,
  approveFilePath
} from './path-validation'
import {
  registerAppfileScheme,
  setupAppfileProtocolHandler
} from './protocol-handler'

let mainWindow: BrowserWindow | null = null


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
registerAppfileScheme()

app.whenReady().then(() => {
  // Clean up stale job directories from previous runs
  cleanupStaleJobDirs()

  // ASR configuration diagnostic
  const asrBackend = process.env.ASR_BACKEND || 'mock'
  console.log(`[ASR] Backend: ${asrBackend}`)
  if (asrBackend === 'whispercpp') {
    const modelPath = process.env.WHISPER_MODEL || ''
    const binPath = process.env.WHISPER_CPP_BIN || '/opt/homebrew/bin/whisper-cli'
    const modelExists = modelPath && fs.existsSync(modelPath)
    const binExists = fs.existsSync(binPath)
    console.log(`[ASR] Model configured: ${modelExists ? 'YES' : 'NO'}`)
    console.log(`[ASR] Binary configured: ${binExists ? 'YES' : 'NO'}`)
    if (!modelExists || !binExists) {
      console.warn('[ASR] ⚠️  Whisper configuration incomplete — transcription will fail')
      console.warn('[ASR] Run: npm run asr:check')
    }
  }

  // Handle appfile:// protocol with Range request support for video playback
  // Security: Only serves files that have been explicitly approved via the allowlist
  setupAppfileProtocolHandler()

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
    const activeFFmpegJobs = getActiveFFmpegJobs()
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

  // Note: Temp directories are now cleaned up via cleanupStaleJobDirs() on startup
  // and cleanupJobTempDir() after each job completes
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

ipcMain.handle('render-preview', async (_event, options: RenderOptions) => {
  const { inputPath, startTime, duration, bands, hpf, lpf, compressor, noiseReduction, autoMix } = options

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
    let metadata
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

    await tryRenderStrategies(originalAttempts, 'original-preview', duration, 'original-preview', jobId, mainWindow)

    // Build base filter chain (NR -> HPF -> LPF -> EQ -> Compressor -> AutoMix)
    const baseFilterChain = buildFullFilterChain(hpf, bands, lpf, compressor, noiseReduction, autoMix)

    // === PASS 1: Loudness Analysis ===
    // Analyze loudness of the processed audio to determine gain adjustment
    let loudnessGain: number | null = null
    try {
      const analysis = await analyzeLoudness(inputPath, baseFilterChain, startTime, duration)
      if (analysis) {
        loudnessGain = calculateLoudnessGain(analysis)
        console.log('[render-preview] Loudness analysis:', analysis)
        console.log('[render-preview] Calculated gain:', loudnessGain, 'dB')
      }
    } catch (err) {
      console.warn('[render-preview] Loudness analysis failed, skipping normalization:', err)
    }

    // === Build final filter chain (base + loudness gain) ===
    const loudnessFilter = buildLoudnessGainFilter(loudnessGain)
    const filterChain = loudnessFilter
      ? (baseFilterChain ? `${baseFilterChain},${loudnessFilter}` : loudnessFilter)
      : baseFilterChain

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

    await tryRenderStrategies(processedAttempts, 'processed-preview', duration, 'processed-preview', jobId, mainWindow)

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
  const url = `appfile://${filePath}`
  console.log('[get-file-url] Returning URL:', url)
  return url
})

/**
 * Cancel an in-progress FFmpeg render.
 * Returns status of the cancellation attempt.
 */
ipcMain.handle('cancel-render', (_event, jobId: string) => {
  return cancelFFmpegJob(jobId, mainWindow)
})

/**
 * Render full audio - processes entire file with filter chain
 * Non-accumulative: always starts from original source
 */
ipcMain.handle('render-full-audio', async (_event, options: RenderOptions) => {
  const { inputPath, bands, hpf, lpf, compressor, noiseReduction, autoMix } = options

  try {
    // Validate input path
    const validation = validateMediaPath(inputPath)
    if (!validation.ok) {
      return { success: false, error: `Invalid input file: ${validation.message}` }
    }

    approveFilePath(inputPath)

    // Generate job ID and output path
    const jobId = `ffmpeg-full-${Date.now()}-${Math.random().toString(36).substring(7)}`
    const jobTempDir = createJobTempDir(jobId)
    const baseName = path.basename(inputPath, path.extname(inputPath))
    const renderId = Date.now()
    const processedOutput = path.join(jobTempDir, `${baseName}-full-processed-${renderId}.mp4`)

    approveFilePath(processedOutput)

    if (fs.existsSync(processedOutput)) {
      fs.unlinkSync(processedOutput)
    }

    // Probe metadata
    let metadata
    try {
      metadata = await probeMediaMetadata(inputPath)
    } catch (err: any) {
      return { success: false, error: `Failed to probe media file: ${err.message}` }
    }

    const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio')
    if (!hasAudio) {
      return { success: false, error: 'Input file has no audio stream' }
    }

    // Get duration for progress reporting
    const durationSec = parseFloat(metadata.format.duration || '0')

    // Build filter chain (same as preview)
    const baseFilterChain = buildFullFilterChain(hpf, bands, lpf, compressor, noiseReduction, autoMix)

    // Loudness analysis on entire file (no time range)
    let loudnessGain: number | null = null
    try {
      const analysis = await analyzeLoudness(inputPath, baseFilterChain, 0, durationSec)
      if (analysis) {
        loudnessGain = calculateLoudnessGain(analysis)
      }
    } catch (err) {
      console.warn('[render-full-audio] Loudness analysis failed, skipping normalization:', err)
    }

    const loudnessFilter = buildLoudnessGainFilter(loudnessGain)
    const filterChain = loudnessFilter
      ? (baseFilterChain ? `${baseFilterChain},${loudnessFilter}` : loudnessFilter)
      : baseFilterChain

    // Render entire file
    const attempts: RenderAttempt[] = [
      {
        name: 'COPY',
        args: filterChain ? [
          '-y',
          '-i', inputPath,
          '-c:v', 'copy',
          '-af', filterChain,
          '-c:a', 'aac',
          '-b:a', '192k',
          processedOutput
        ] : [
          '-y',
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
          '-i', inputPath,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-af', filterChain,
          '-c:a', 'aac',
          '-b:a', '192k',
          processedOutput
        ] : [
          '-y',
          '-i', inputPath,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-c:a', 'aac',
          '-b:a', '192k',
          processedOutput
        ]
      }
    ]

    await tryRenderStrategies(attempts, 'full-audio-render', durationSec, 'full-audio-render', jobId, mainWindow)

    return {
      success: true,
      processedPath: processedOutput,
      renderId
    }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err)
    }
  }
})

// Transcript generation handler
ipcMain.handle('get-transcript', async (_event, filePath: string): Promise<{ transcript: TranscriptV1; edl: EdlV1; asrBackend: string }> => {
  // 1. Extract video metadata to get video_id
  const videoAsset = await extractVideoMetadata(filePath)

  // 2. Create temp directory for ASR audio extraction
  const asrJobId = `asr-${Date.now()}-${Math.random().toString(36).substring(7)}`
  const asrTempDir = createJobTempDir(asrJobId)

  // 3. Extract audio for ASR
  const audioPath = await extractAudioForASR(filePath, asrTempDir)

  try {
    // 4. Run ASR
    const transcriber = getTranscriber()
    const transcript = await transcriber.transcribe(audioPath, videoAsset.video_id)

    // 5. Create initial EDL for this media
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

    // 6. Include ASR backend info for UI warning
    const asrBackend = process.env.ASR_BACKEND || 'mock'

    return { transcript, edl, asrBackend }
  } finally {
    // 7. Cleanup temp audio file and job directory
    cleanupAudioFile(audioPath)
    cleanupJobTempDir(asrJobId)
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

// Detect quiet region candidates for noise sampling
ipcMain.handle('detect-quiet-candidates', async (_event, filePath: string) => {
  try {
    // Validate input path
    const validation = validateMediaPath(filePath)
    if (!validation.ok) {
      console.error('[detect-quiet-candidates] Validation failed:', validation.message)
      return { candidates: [] }
    }

    const candidates = await detectQuietCandidates(filePath)
    return { candidates }
  } catch (err) {
    console.error('[detect-quiet-candidates] Error:', err)
    return { candidates: [] }
  }
})
