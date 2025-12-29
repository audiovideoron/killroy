import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import type { RenderOptions } from '../shared/types'
import type { TranscriptV1, EdlV1 } from '../shared/editor-types'
import { extractVideoMetadata } from './media-metadata'
import { extractAudioForASR, cleanupAudioFile } from './audio-extraction'
import { getTranscriber } from './asr-adapter'
import { renderFinal } from './final-render'
import { buildEffectiveRemoveRanges } from './edl-engine'
import { synthesizeVoiceTrack, synthesizeHybridTrack, renderDeleteOnlyPreview } from './tts/synthesis-pipeline'
import { cloneVoiceFromVideo, loadVoiceIdFromEnvrc } from './tts/voice-clone'
import {
  buildFullFilterChain,
  buildEQFilter,
  buildCompressorFilter,
  buildNoiseSamplingFilter,
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

// Cache for synthesized audio track (keyed by video file path)
// Stores the path to synthesized-track.wav for use during export
const synthesizedAudioCache: Map<string, string> = new Map()

// Cache for synthesized preview video (keyed by video file path)
// Stores the path to preview-synthesized.mp4 for Preview button
const synthesizedPreviewCache: Map<string, string> = new Map()

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 1300,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    // Security: Only allow localhost URLs in dev mode to prevent arbitrary URL loading
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL)
    if (devUrl.hostname !== 'localhost' && devUrl.hostname !== '127.0.0.1') {
      console.error('[security] DEV_SERVER_URL must be localhost, got:', devUrl.hostname)
      app.quit()
      return
    }
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

  // Load voice ID from .envrc (Electron doesn't source shell scripts)
  const projectRoot = app.isPackaged
    ? path.dirname(app.getPath('exe'))
    : path.resolve(__dirname, '..')
  loadVoiceIdFromEnvrc(projectRoot)

  // Voice ID diagnostic at startup
  const voiceId = process.env.ELEVENLABS_VOICE_ID
  console.log('[startup] ELEVENLABS_VOICE_ID:', voiceId || '(unset - will use default Sarah voice)')

  // ASR configuration diagnostic
  const asrBackend = process.env.ASR_BACKEND || 'elevenlabs'
  console.log(`[ASR] Backend: ${asrBackend}`)

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

  // Clean up synthesized audio/preview caches to prevent memory leaks
  synthesizedAudioCache.clear()
  synthesizedPreviewCache.clear()
  console.log('[cleanup] Cleared synthesized audio/preview caches')

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
  // Validate path before approving for protocol access
  const validation = validateMediaPath(selectedPath)
  if (!validation.ok) {
    console.error('[select-file] Validation failed:', validation.message)
    return null
  }
  // Approve user-selected file for appfile:// protocol access
  approveFilePath(selectedPath)
  return selectedPath
})

// Auto-load file for dev workflow - set DEV_AUTO_LOAD_FILE env var
ipcMain.handle('get-auto-load-file', () => {
  const autoLoadPath = process.env.DEV_AUTO_LOAD_FILE
  if (!autoLoadPath) return null

  // Resolve relative paths to app directory
  const resolvedPath = path.isAbsolute(autoLoadPath)
    ? autoLoadPath
    : path.resolve(app.getAppPath(), autoLoadPath)

  if (fs.existsSync(resolvedPath)) {
    console.log('[dev] Auto-loading file:', resolvedPath)
    approveFilePath(resolvedPath)
    return resolvedPath
  }
  console.log('[dev] Auto-load file not found:', resolvedPath)
  return null
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
  const { inputPath, startTime, duration, autoGain, loudness, noiseSampling, hpf, lpf, bands, compressor, autoMix, noiseSampleRegion } = options

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

    // Check for cached synthesized preview - if exists and on disk, use it
    const synthesizedPreviewPath = synthesizedPreviewCache.get(inputPath)
    if (synthesizedPreviewPath && fs.existsSync(synthesizedPreviewPath)) {
      console.log('[preview] mode=SYNTHESIZED filePath=' + inputPath + ' outPath=' + synthesizedPreviewPath)
      approveFilePath(synthesizedPreviewPath)
      return {
        success: true,
        originalPath: synthesizedPreviewPath,  // Both point to synth for unified playback
        processedPath: synthesizedPreviewPath,
        renderId: Date.now(),
        jobId: 'synth-cached'
      }
    }

    console.log('[preview] mode=DSP filePath=' + inputPath)

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

    // Check if source is HEVC - Chromium can't play HEVC, must re-encode
    const videoStream = metadata.streams.find(s => s.codec_type === 'video')
    const isHEVC = videoStream?.codec_name === 'hevc' || videoStream?.codec_name === 'h265'
    if (isHEVC) {
      console.log('[render-preview] Source is HEVC - will re-encode to H.264 for Chromium playback')
    }

    // Render original preview with automatic copy → re-encode fallback
    // Skip COPY for HEVC since Chromium can't play it
    const originalAttempts: RenderAttempt[] = isHEVC ? [
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
    ] : [
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

    // Build full filter chain with all 8 stages:
    // AutoGain → Loudness → Noise Sampling → HPF → LPF → EQ → Compressor → AutoMix
    const filterChain = buildFullFilterChain(
      autoGain,
      loudness,
      noiseSampling,
      hpf,
      lpf,
      bands,
      compressor,
      autoMix,
      noiseSampleRegion
    )

    // Build attempts with automatic copy → re-encode fallback
    // Skip COPY for HEVC since Chromium can't play it
    const processedAttempts: RenderAttempt[] = isHEVC ? [
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
    ] : [
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
  console.log('[get-file-url] filesystem path:', filePath)
  console.log('[get-file-url] generated URL:', url)
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
  const { inputPath, autoGain, loudness, noiseSampling, hpf, lpf, bands, compressor, autoMix, noiseSampleRegion } = options

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

    // Build full filter chain with all 8 stages (same as preview):
    // AutoGain → Loudness → Noise Sampling → HPF → LPF → EQ → Compressor → AutoMix
    const filterChain = buildFullFilterChain(
      autoGain,
      loudness,
      noiseSampling,
      hpf,
      lpf,
      bands,
      compressor,
      autoMix,
      noiseSampleRegion
    )

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

    // 2. Check for cached synthesized audio
    const synthesizedAudioPath = synthesizedAudioCache.get(filePath)
    console.log('[tts:export] filePath:', filePath)
    console.log('[tts:export] synthesizedAudioPath:', synthesizedAudioPath || '(none - using original audio)')
    console.log('[tts:export] mode:', synthesizedAudioPath ? 'MUXING_SYNTH_AUDIO' : 'ORIGINAL_AUDIO')

    // 3. Render final video
    const report = await renderFinal({
      videoAsset,
      edl,
      outputPath,
      synthesizedAudioPath
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

// Compute pending removal ranges - diagnostic only, no rendering
ipcMain.handle('compute-pending-removals', async (_event, filePath: string, edl: EdlV1) => {
  try {
    const videoAsset = await extractVideoMetadata(filePath)
    const effectiveRemoves = buildEffectiveRemoveRanges(edl, videoAsset.duration_ms)
    const total_removed_ms = effectiveRemoves.reduce((sum, r) => sum + (r.end_ms - r.start_ms), 0)
    return {
      ranges: effectiveRemoves,
      total_removed_ms,
      duration_ms: videoAsset.duration_ms
    }
  } catch (err) {
    console.error('[compute-pending-removals] Error:', err)
    return { ranges: [], total_removed_ms: 0, duration_ms: 0 }
  }
})

// Voice synthesis test - synthesize transcript and mux with video
ipcMain.handle('synthesize-voice-test', async (_event, filePath: string, transcript: TranscriptV1, edl: EdlV1) => {
  try {
    console.log('[synthesize-voice-test] Starting synthesis...')

    // 1. Extract video metadata
    const videoAsset = await extractVideoMetadata(filePath)

    // 2. Create work directory
    const workDir = path.join(app.getPath('temp'), `synth-${Date.now()}`)

    // 3. Choose mode based on edits
    const hasReplacements = edl.replacements && edl.replacements.length > 0
    const hasInsertions = edl.insertions && edl.insertions.length > 0
    const hasDeletions = edl.remove_ranges && edl.remove_ranges.length > 0

    let report
    let outputPath: string

    if (hasReplacements || hasInsertions) {
      // Hybrid mode: DSP audio + synth patches for replacements + insertions
      console.log('[synthesize-voice-test] Mode: HYBRID (DSP + synth patches)')
      console.log('[synthesize-voice-test] Replacements:', edl.replacements?.length ?? 0)
      console.log('[synthesize-voice-test] Insertions:', edl.insertions?.length ?? 0)
      console.log('[synthesize-voice-test] Remove ranges:', edl.remove_ranges.length)
      // Pass null for DSP filter chain - use original audio for non-replaced regions
      // TODO: Pass actual DSP settings from frontend for full DSP+synth hybrid
      const hybridReport = await synthesizeHybridTrack(videoAsset, edl, null, workDir, transcript)
      outputPath = hybridReport.outputPath
      report = hybridReport
    } else if (hasDeletions) {
      // Delete-only mode: cut video+audio, no TTS
      console.log('[synthesize-voice-test] Mode: DELETE-ONLY (no TTS)')
      console.log('[synthesize-voice-test] Remove ranges:', edl.remove_ranges.length)
      // Pass null for DSP filter chain - use original audio
      // TODO: Pass actual DSP settings from frontend
      const deleteReport = await renderDeleteOnlyPreview(videoAsset, edl, null, workDir)
      outputPath = deleteReport.outputPath
      report = {
        outputPath: deleteReport.outputPath,
        audioTrackPath: deleteReport.outputPath, // No separate audio track for delete-only
        chunks: deleteReport.segments,
        total_target_ms: deleteReport.edited_duration_ms,
        total_synth_ms: 0,
        tempo_adjustments: 0
      }
    } else {
      // Full synthesis mode: regenerate entire transcript (no edits)
      console.log('[synthesize-voice-test] Mode: FULL SYNTHESIS')
      const synthReport = await synthesizeVoiceTrack(videoAsset, transcript, edl, workDir)
      outputPath = synthReport.outputPath
      report = synthReport
    }

    console.log('[synthesize-voice-test] Complete:', report)

    // Cache synthesized audio track for export
    synthesizedAudioCache.set(filePath, report.audioTrackPath)
    console.log('[synthesize-voice-test] Cached audio track for export:', report.audioTrackPath)

    // Cache synthesized preview video for Preview button
    synthesizedPreviewCache.set(filePath, report.outputPath)
    console.log('[synthesize-voice-test] Cached preview video:', report.outputPath)

    // Approve synthesized output for appfile:// protocol access
    approveFilePath(report.outputPath)
    console.log('[synthesize-voice-test] Approved path for appfile://', report.outputPath)

    return {
      success: true,
      outputPath: report.outputPath,
      report: {
        chunks: report.chunks,
        total_target_ms: report.total_target_ms,
        total_synth_ms: report.total_synth_ms,
        tempo_adjustments: report.tempo_adjustments
      }
    }
  } catch (err) {
    console.error('[synthesize-voice-test] Error:', err)
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

// Clone voice from loaded video
ipcMain.handle('clone-voice', async (_event, filePath: string) => {
  try {
    // Validate input path
    const validation = validateMediaPath(filePath)
    if (!validation.ok) {
      return { success: false, error: validation.message }
    }

    // Get project root (where .envrc lives)
    const projectRoot = app.isPackaged
      ? path.dirname(app.getPath('exe'))
      : path.resolve(__dirname, '..')

    const result = await cloneVoiceFromVideo(filePath, projectRoot)
    return result
  } catch (err) {
    console.error('[clone-voice] Error:', err)
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
})
