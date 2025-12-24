import { useState, useRef, useCallback, useEffect } from 'react'
import { AudioControls } from './components/AudioControls'
import { TranscriptPane } from './components/TranscriptPane'
import { JobProgressBanner } from './components/JobProgressBanner'
import { VideoPreview, type VideoPreviewHandle } from './components/VideoPreview'
import { SourceControls } from './components/SourceControls'
import { useJobProgress } from './hooks/useJobProgress'
import type { EQBand, FilterParams, CompressorParams, NoiseReductionParams, AutoMixParams, AutoMixPreset } from '../shared/types'
import type { TranscriptV1, EdlV1 } from '../shared/editor-types'
import './types/electron-api.d'

type Status = 'idle' | 'rendering' | 'done' | 'error'

function App() {
  const [filePath, setFilePath] = useState<string | null>(null)
  const [startTime, setStartTime] = useState(0)
  const [duration, setDuration] = useState(15)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  // Job progress tracking
  const { currentJob } = useJobProgress()

  const [bands, setBands] = useState<EQBand[]>([
    { frequency: 200, gain: 0, q: 1.0, enabled: true },
    { frequency: 1000, gain: 0, q: 1.0, enabled: true },
    { frequency: 5000, gain: 0, q: 1.0, enabled: true }
  ])

  const [hpf, setHpf] = useState<FilterParams>({ frequency: 80, q: 0.7, enabled: false })
  const [lpf, setLpf] = useState<FilterParams>({ frequency: 12000, q: 0.7, enabled: false })

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

  const [noiseReduction, setNoiseReduction] = useState<NoiseReductionParams>({
    strength: 50,
    enabled: false
  })

  const [autoMix, setAutoMix] = useState<AutoMixParams>({
    preset: 'MEDIUM',
    enabled: false
  })

  // Handle AutoMix preset selection - configures full processing chain
  const handleAutoMixPresetChange = useCallback((preset: AutoMixPreset) => {
    // Always enable AutoMix and set the preset
    setAutoMix({ preset, enabled: true })

    // Configure chain based on preset
    // All presets enable HPF at 120Hz for speech
    if (preset === 'LIGHT') {
      // LIGHT: AutoMix + HPF 120Hz only
      setNoiseReduction({ strength: 50, enabled: false })
      setCompressor(prev => ({ ...prev, enabled: false }))
      setHpf({ frequency: 120, q: 0.7, enabled: true })
      setLpf(prev => ({ ...prev, enabled: false }))
    } else if (preset === 'MEDIUM') {
      // MEDIUM: AutoMix + HPF 120Hz + NR 25% + Comp (-18dB, 3:1)
      setNoiseReduction({ strength: 25, enabled: true })
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
      // HEAVY: AutoMix + HPF 120Hz + NR 50% + Comp (-15dB, 4:1)
      setNoiseReduction({ strength: 50, enabled: true })
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
        firstTokens: result.transcript.tokens.slice(0, 3).map(t => t.text)
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
    setBands(prev => {
      const updated = [...prev]
      updated[index] = { ...updated[index], [field]: value }
      return updated
    })
  }

  const handleRender = useCallback(async () => {
    if (!filePath) return

    console.log('[handleRender] inputPath:', filePath)

    setStatus('rendering')
    setErrorMsg('')

    try {
      const result = await window.electronAPI.renderPreview({
        inputPath: filePath,
        startTime,
        duration,
        bands,
        hpf,
        lpf,
        compressor,
        noiseReduction,
        autoMix
      })

      if (result.success) {
        const origUrl = await window.electronAPI.getFileUrl(result.originalPath!)
        const procUrl = await window.electronAPI.getFileUrl(result.processedPath!)
        // Cache-bust with renderId to prevent stale video playback
        const cacheBuster = `?v=${result.renderId}`
        setOriginalUrl(origUrl + cacheBuster)
        setProcessedUrl(procUrl + cacheBuster)
        setStatus('done')
      } else {
        setStatus('error')
        setErrorMsg(result.error || 'Unknown error')
      }
    } catch (err) {
      setStatus('error')
      setErrorMsg(String(err))
    }
  }, [filePath, startTime, duration, bands, hpf, lpf, compressor, noiseReduction, autoMix])

  const playOriginal = () => videoPreviewRef.current?.playOriginal()
  const playProcessed = () => videoPreviewRef.current?.playProcessed()

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
            duration={duration}
            onSelectFile={handleSelectFile}
            onStartTimeChange={setStartTime}
            onDurationChange={setDuration}
          />
      {/* Channel Strips Container */}
      <AudioControls
        bands={bands}
        hpf={hpf}
        lpf={lpf}
        compressor={compressor}
        noiseReduction={noiseReduction}
        autoMix={autoMix}
        onBandUpdate={updateBand}
        onHpfChange={setHpf}
        onLpfChange={setLpf}
        onCompressorChange={setCompressor}
        onNoiseReductionChange={setNoiseReduction}
        onAutoMixChange={setAutoMix}
        onAutoMixPresetChange={handleAutoMixPresetChange}
      />
      {/* Render & Playback */}
      <div className="section">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={handleRender} disabled={!filePath || status === 'rendering'}>
            Render Preview
          </button>
          <button onClick={playOriginal} disabled={!originalUrl}>
            Play Original
          </button>
          <button onClick={playProcessed} disabled={!processedUrl}>
            Play Processed
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
