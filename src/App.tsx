import { useState, useRef, useCallback, useEffect } from 'react'
import { AudioControls } from './components/AudioControls'
import { TranscriptPane } from './components/TranscriptPane'
import { JobProgressBanner } from './components/JobProgressBanner'
import { VideoPreview, type VideoPreviewHandle } from './components/VideoPreview'
import { SourceControls } from './components/SourceControls'
import { useJobProgress } from './hooks/useJobProgress'
import type { EQBand, FilterParams, CompressorParams, NoiseSamplingParams, AutoGainParams, LoudnessParams, AutoMixParams, AutoMixPreset, QuietCandidate } from '../shared/types'
import { AUTOGAIN_CONFIG, LOUDNESS_CONFIG } from '../shared/types'
import type { TranscriptV1, EdlV1 } from '../shared/editor-types'

type Status = 'idle' | 'rendering' | 'done' | 'error'

/**
 * Fixed preview duration in seconds.
 * Per investigation doc: "Preview renders a fixed default duration (~10 seconds)"
 * See: docs/noise-sample-auto-selection-investigation.md
 */
const PREVIEW_DURATION_SEC = 10

function App() {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [startTime, setStartTime] = useState(0)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  // Dirty flag: true = processed audio is stale, needs re-render before playback
  // Initial: true (no processed audio yet)
  const [processedDirty, setProcessedDirty] = useState(true)

  // Job progress tracking
  const { currentJob } = useJobProgress()

  const [bands, setBands] = useState<EQBand[]>([
    { frequency: 200, gain: 0, q: 1.0, enabled: true },
    { frequency: 1000, gain: 0, q: 1.0, enabled: true },
    { frequency: 5000, gain: 0, q: 1.0, enabled: true }
  ])

  // === Filter state (canonical order) ===
  // 1. AutoGain/Leveling
  const [autoGain, setAutoGain] = useState<AutoGainParams>({
    targetLevel: AUTOGAIN_CONFIG.DEFAULT_TARGET,
    enabled: false
  })

  // 2. Loudness normalization
  const [loudness, setLoudness] = useState<LoudnessParams>({
    targetLufs: LOUDNESS_CONFIG.TARGET_LUFS,
    enabled: false
  })

  // 3. Noise Sampling DSP
  const [noiseSampling, setNoiseSampling] = useState<NoiseSamplingParams>({
    enabled: false
  })

  // 4. High-pass filter
  const [hpf, setHpf] = useState<FilterParams>({ frequency: 80, q: 0.7, enabled: false })

  // 5. Low-pass filter
  const [lpf, setLpf] = useState<FilterParams>({ frequency: 12000, q: 0.7, enabled: false })

  // 7. Compressor
  const [compressor, setCompressor] = useState<CompressorParams>({
    threshold: -20,
    ratio: 4,
    attack: 10,
    release: 100,
    makeup: 0,
    emphasis: 20,
    mode: 'COMP',
    enabled: false
  })

  const [autoMix, setAutoMix] = useState<AutoMixParams>({
    preset: 'MEDIUM',
    enabled: false
  })

  // Noise sampling region (from quiet candidate detection)
  const [noiseSampleRegion, setNoiseSampleRegion] = useState<QuietCandidate | null>(null)

  // Dirty-marking wrappers for all audio parameters
  // Any change to render configuration marks processed audio as stale
  const markDirtyAndSetStartTime = useCallback((v: number) => { setProcessedDirty(true); setStartTime(v) }, [])
  const markDirtyAndSetBands = useCallback((updater: (prev: EQBand[]) => EQBand[]) => { setProcessedDirty(true); setBands(updater) }, [])
  const markDirtyAndSetAutoGain = useCallback((v: AutoGainParams) => { setProcessedDirty(true); setAutoGain(v) }, [])
  const markDirtyAndSetLoudness = useCallback((v: LoudnessParams) => { setProcessedDirty(true); setLoudness(v) }, [])
  const markDirtyAndSetHpf = useCallback((v: FilterParams) => { setProcessedDirty(true); setHpf(v) }, [])
  const markDirtyAndSetLpf = useCallback((v: FilterParams) => { setProcessedDirty(true); setLpf(v) }, [])
  const markDirtyAndSetCompressor = useCallback((v: CompressorParams | ((prev: CompressorParams) => CompressorParams)) => { setProcessedDirty(true); setCompressor(v) }, [])
  const markDirtyAndSetNoiseSampling = useCallback((v: NoiseSamplingParams) => { setProcessedDirty(true); setNoiseSampling(v) }, [])
  const markDirtyAndSetAutoMix = useCallback((v: AutoMixParams) => { setProcessedDirty(true); setAutoMix(v) }, [])

  // Global Preview pipeline - single path for all auditioning
  const requestPreview = useCallback(async (params: { startSec: number; durationSec: number }) => {
    if (!filePath) return

    const { startSec, durationSec } = params
    console.log('[requestPreview] ========== START ==========')
    console.log('[requestPreview] timing:', { startSec, durationSec })
    console.log('[requestPreview] inputPath:', filePath)

    setStatus('rendering')
    setErrorMsg('')

    try {
      const result = await window.electronAPI.renderPreview({
        inputPath: filePath,
        startTime: startSec,
        duration: durationSec,
        autoGain,
        loudness,
        noiseSampling,
        hpf,
        lpf,
        bands,
        compressor,
        autoMix,
        noiseSampleRegion
      })

      if (result.success) {
        const origUrl = await window.electronAPI.getFileUrl(result.originalPath!)
        const procUrl = await window.electronAPI.getFileUrl(result.processedPath!)
        // Cache-bust with renderId to prevent stale video playback
        const cacheBuster = `?v=${result.renderId}`
        const finalProcUrl = procUrl + cacheBuster
        setOriginalUrl(origUrl + cacheBuster)
        setProcessedUrl(finalProcUrl)
        setProcessedDirty(false)  // Render complete - processed audio is current
        setStatus('done')

        console.log('[requestPreview] ========== COMPLETE ==========')
        console.log('[requestPreview] playing URL directly:', finalProcUrl)

        // Play the URL directly (bypasses stale props from React async state)
        videoPreviewRef.current?.playUrl(finalProcUrl)
      } else {
        // Keep processedDirty = true on failure
        setStatus('error')
        setErrorMsg(result.error || 'Unknown error')
        console.log('[requestPreview] ========== FAILED ==========')
        console.log('[requestPreview] error:', result.error)
      }
    } catch (err) {
      // Keep processedDirty = true on failure
      setStatus('error')
      setErrorMsg(String(err))
      console.log('[requestPreview] ========== ERROR ==========')
      console.log('[requestPreview] exception:', err)
    }
  }, [filePath, autoGain, loudness, noiseSampling, hpf, lpf, bands, compressor, autoMix, noiseSampleRegion])

  // "Preview" button handler - delegates to global preview pipeline
  // Uses fixed PREVIEW_DURATION_SEC per investigation doc
  const handleRender = useCallback(async () => {
    await requestPreview({ startSec: startTime, durationSec: PREVIEW_DURATION_SEC })
  }, [requestPreview, startTime])

  // "Render" button handler - processes entire file with full chain
  // Non-accumulative: always starts from original source
  const handleRenderFull = useCallback(async () => {
    if (!filePath) return

    setStatus('rendering')
    setErrorMsg('')

    try {
      const result = await window.electronAPI.renderFullAudio({
        inputPath: filePath,
        startTime: 0,
        duration: 0, // Full file - duration determined by main process
        autoGain,
        loudness,
        noiseSampling,
        hpf,
        lpf,
        bands,
        compressor,
        autoMix,
        noiseSampleRegion
      })

      if (result.success) {
        const procUrl = await window.electronAPI.getFileUrl(result.processedPath!)
        const cacheBuster = `?v=${result.renderId}`
        setFullProcessedUrl(procUrl + cacheBuster)
        setProcessedDirty(false)  // Full render complete - processed audio is current
        setStatus('done')
      } else {
        setStatus('error')
        setErrorMsg(result.error || 'Unknown error')
      }
    } catch (err) {
      setStatus('error')
      setErrorMsg(String(err))
    }
  }, [filePath, autoGain, loudness, noiseSampling, hpf, lpf, bands, compressor, autoMix, noiseSampleRegion])

  // Handle AutoMix preset selection - configures full processing chain
  const handleAutoMixPresetChange = useCallback((preset: AutoMixPreset) => {
    // Mark dirty - configuration is changing
    setProcessedDirty(true)

    // Always enable AutoMix and set the preset
    setAutoMix({ preset, enabled: true })

    // Configure chain based on preset
    // All presets enable HPF at 120Hz for speech
    if (preset === 'LIGHT') {
      // LIGHT: AutoMix + HPF 120Hz only
      setNoiseSampling({ enabled: false })
      setCompressor(prev => ({ ...prev, enabled: false }))
      setHpf({ frequency: 120, q: 0.7, enabled: true })
      setLpf(prev => ({ ...prev, enabled: false }))
    } else if (preset === 'MEDIUM') {
      // MEDIUM: AutoMix + HPF 120Hz + Noise Sampling + Comp (-18dB, 3:1)
      setNoiseSampling({ enabled: true })
      setCompressor({
        threshold: -18,
        ratio: 3,
        attack: 10,
        release: 100,
        makeup: 0,
        emphasis: 20,
        mode: 'COMP',
        enabled: true
      })
      setHpf({ frequency: 120, q: 0.7, enabled: true })
      setLpf(prev => ({ ...prev, enabled: false }))
    } else if (preset === 'HEAVY') {
      // HEAVY: AutoMix + HPF 120Hz + Noise Sampling + Comp (-15dB, 4:1)
      setNoiseSampling({ enabled: true })
      setCompressor({
        threshold: -15,
        ratio: 4,
        attack: 10,
        release: 100,
        makeup: 3,
        emphasis: 20,
        mode: 'COMP',
        enabled: true
      })
      setHpf({ frequency: 120, q: 0.7, enabled: true })
      setLpf(prev => ({ ...prev, enabled: false }))
    }
  }, [])

  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [processedUrl, setProcessedUrl] = useState<string | null>(null)
  const [fullProcessedUrl, setFullProcessedUrl] = useState<string | null>(null)

  const videoPreviewRef = useRef<VideoPreviewHandle>(null)

  // Transcript state - cached by file path
  const [transcriptCache, setTranscriptCache] = useState<Map<string, { transcript: TranscriptV1; edl: EdlV1; asrBackend: string }>>(new Map())
  const [isTranscriptLoading, setIsTranscriptLoading] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)

  // Export state
  const [isExporting, setIsExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exportSuccess, setExportSuccess] = useState<string | null>(null)

  // Current transcript/edl for active media
  const currentTranscriptData = filePath ? transcriptCache.get(filePath) : null
  const transcript = currentTranscriptData?.transcript
  const edl = currentTranscriptData?.edl
  const asrBackend = currentTranscriptData?.asrBackend

  const handleSelectFile = async () => {
    const path = await window.electronAPI.selectFile()
    if (path) {
      setFilePath(path)
      setStatus('idle')
      setErrorMsg('')
      setOriginalUrl(null)
      setProcessedUrl(null)
      setFullProcessedUrl(null)  // Clear full processed artifact
      setProcessedDirty(true)  // New file = no processed audio
      setNoiseSampleRegion(null)  // Clear noise sample for new file
      // Clear transcript error when new file is selected
      setTranscriptError(null)
    }
  }

  // Load transcript for current file
  const loadTranscript = useCallback(async () => {
    if (!filePath) return
    if (transcriptCache.has(filePath)) return // Already cached

    setIsTranscriptLoading(true)
    setTranscriptError(null)

    try {
      const result = await window.electronAPI.getTranscript(filePath)

      // Log ASR backend and token count for verification
      console.log('[Transcript Loaded]', {
        backend: result.asrBackend,
        tokens: result.transcript.tokens.length,
        firstTokens: result.transcript.tokens.slice(0, 3).map((t: any) => t.text)
      })

      setTranscriptCache(prev => new Map(prev).set(filePath, result))
    } catch (err) {
      setTranscriptError(String(err))
    } finally {
      setIsTranscriptLoading(false)
    }
  }, [filePath, transcriptCache])

  // Update EDL in cache
  const handleEdlChange = useCallback((newEdl: EdlV1) => {
    if (!filePath || !transcript || !asrBackend) return

    setTranscriptCache(prev => {
      const newCache = new Map(prev)
      newCache.set(filePath, { transcript, edl: newEdl, asrBackend })
      return newCache
    })
  }, [filePath, transcript, asrBackend])

  // Handle export edited video
  const handleExport = useCallback(async () => {
    if (!filePath || !edl) return

    // Clear previous export state
    setExportError(null)
    setExportSuccess(null)

    // Generate default output path
    // Handle both Unix (/) and Windows (\) path separators
    const baseName = filePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') || 'video'
    const defaultPath = `${baseName}-edited.mp4`

    // Show save dialog
    const outputPath = await window.electronAPI.saveDialog(defaultPath)
    if (!outputPath) return // User cancelled

    setIsExporting(true)

    try {
      const result = await window.electronAPI.renderFinal(filePath, edl, outputPath)

      if (result.success) {
        setExportSuccess(result.outputPath || outputPath)
      } else {
        setExportError(result.error || 'Export failed')
      }
    } catch (err) {
      setExportError(String(err))
    } finally {
      setIsExporting(false)
    }
  }, [filePath, edl])

  // Auto-load transcript when file is selected
  useEffect(() => {
    if (filePath && !transcriptCache.has(filePath) && !isTranscriptLoading) {
      loadTranscript()
    }
  }, [filePath, transcriptCache, isTranscriptLoading, loadTranscript])

  const updateBand = (index: number, field: keyof EQBand, value: number | boolean) => {
    markDirtyAndSetBands(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      return updated
    })
  }

  // Play button: intelligently selects best available artifact
  // Priority: full processed > preview processed > original
  // Never triggers FFmpeg - playback only
  const playOriginal = () => {
    if (fullProcessedUrl) {
      videoPreviewRef.current?.playUrl(fullProcessedUrl)
    } else if (processedUrl) {
      videoPreviewRef.current?.playUrl(processedUrl)
    } else {
      videoPreviewRef.current?.playOriginal()
    }
  }

  // Build status text for App-level status (non-job-progress states)
  const statusText = !currentJob ? {
    idle: 'Idle - Select a file and render preview',
    rendering: 'Rendering...',
    done: 'Done - Ready to play A/B',
    error: `Error: ${errorMsg}`
  }[status] || 'Idle' : ''

  return (
    <div>
      <div style={{ textAlign: 'center', fontSize: '2rem', color: '#888', padding: '8px 0' }}>
        Kilroy was here
      </div>

      {/* Split View Layout */}
      <div style={{ display: 'flex', height: 'calc(100vh - 80px)', overflow: 'hidden' }}>
        {/* Left Pane: Audio Processing */}
        <div style={{ flex: '0 0 50%', overflowY: 'auto', borderRight: '1px solid #333' }}>
          {/* Source & Preview Range - Compact Row */}
          <SourceControls
            filePath={filePath}
            startTime={startTime}
            onSelectFile={handleSelectFile}
            onStartTimeChange={markDirtyAndSetStartTime}
          />
      {/* Channel Strips Container */}
      <AudioControls
        bands={bands}
        hpf={hpf}
        lpf={lpf}
        compressor={compressor}
        noiseSampling={noiseSampling}
        autoMix={autoMix}
        onBandUpdate={updateBand}
        onHpfChange={markDirtyAndSetHpf}
        onLpfChange={markDirtyAndSetLpf}
        onCompressorChange={markDirtyAndSetCompressor}
        onNoiseSamplingChange={markDirtyAndSetNoiseSampling}
        onAutoMixChange={markDirtyAndSetAutoMix}
        onAutoMixPresetChange={handleAutoMixPresetChange}
      />

      {/* Transport: Play / Preview / Render */}
      <div className="section">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={playOriginal} disabled={!originalUrl}>
            Play
          </button>
          <button onClick={handleRender} disabled={!filePath || status === 'rendering'}>
            Preview
          </button>
          <button onClick={handleRenderFull} disabled={!filePath || status === 'rendering'}>
            Render
          </button>
          {!currentJob && statusText && (
            <div className={`status ${status}`} style={{ marginLeft: 12 }}>
              {statusText}
            </div>
          )}
          <JobProgressBanner currentJob={currentJob} />
        </div>
      </div>

      {/* Video Preview */}
      <VideoPreview ref={videoPreviewRef} originalUrl={originalUrl} processedUrl={processedUrl} />
        </div>

        {/* Right Pane: Transcript Editor */}
        <div style={{ flex: '0 0 50%', overflowY: 'auto', padding: 20 }}>
          <TranscriptPane
            filePath={filePath}
            transcript={transcript}
            edl={edl}
            asrBackend={asrBackend}
            isTranscriptLoading={isTranscriptLoading}
            transcriptError={transcriptError}
            isExporting={isExporting}
            exportError={exportError}
            exportSuccess={exportSuccess}
            onEdlChange={handleEdlChange}
            onExport={handleExport}
            onLoadTranscript={loadTranscript}
          />
        </div>
      </div>
    </div>
  )
}

export default App
