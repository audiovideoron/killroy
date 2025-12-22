import { useState, useRef, useCallback } from 'react'
import { Knob, Toggle } from './components/Knob'
import { TranscriptEditor } from './components/TranscriptEditor'
import type {
  EQBand,
  FilterParams,
  CompressorParams,
  NoiseReductionParams,
  RenderResult
} from '../shared/types'
import type { TranscriptV1, EdlV1 } from '../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'

declare global {
  interface Window {
    electronAPI: {
      selectFile: () => Promise<string | null>
      renderPreview: (options: {
        inputPath: string
        startTime: number
        duration: number
        bands: EQBand[]
        hpf: FilterParams
        lpf: FilterParams
        compressor: CompressorParams
        noiseReduction: NoiseReductionParams
      }) => Promise<RenderResult>
      getFileUrl: (filePath: string) => Promise<string>
      getTranscript: (filePath: string) => Promise<{ transcript: TranscriptV1; edl: EdlV1 }>
    }
  }
}

type Status = 'idle' | 'rendering' | 'done' | 'error'
type Mode = 'audio' | 'transcript'

function App() {
  const [mode, setMode] = useState<Mode>('audio')
  const [filePath, setFilePath] = useState<string | null>(null)
  const [startTime, setStartTime] = useState(0)
  const [duration, setDuration] = useState(15)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')

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

  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [processedUrl, setProcessedUrl] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)

  // Transcript state - cached by file path
  const [transcriptCache, setTranscriptCache] = useState<Map<string, { transcript: TranscriptV1; edl: EdlV1 }>>(new Map())
  const [isTranscriptLoading, setIsTranscriptLoading] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)

  // Current transcript/edl for active media
  const currentTranscriptData = filePath ? transcriptCache.get(filePath) : null
  const transcript = currentTranscriptData?.transcript
  const edl = currentTranscriptData?.edl

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
      setTranscriptCache(prev => new Map(prev).set(filePath, result))
    } catch (err) {
      setTranscriptError(String(err))
    } finally {
      setIsTranscriptLoading(false)
    }
  }, [filePath, transcriptCache])

  // Update EDL in cache
  const handleEdlChange = useCallback((newEdl: EdlV1) => {
    if (!filePath || !transcript) return

    setTranscriptCache(prev => {
      const newCache = new Map(prev)
      newCache.set(filePath, { transcript, edl: newEdl })
      return newCache
    })
  }, [filePath, transcript])

  // Load transcript when switching to transcript mode
  const [, startTransition] = useState(0)
  const loadTranscriptRef = useRef(loadTranscript)
  loadTranscriptRef.current = loadTranscript

  const [prevMode, setPrevMode] = useState<Mode>('audio')
  if (mode !== prevMode) {
    setPrevMode(mode)
    if (mode === 'transcript' && filePath && !transcriptCache.has(filePath) && !isTranscriptLoading) {
      // Trigger load on next render
      startTransition(Date.now())
      setTimeout(() => loadTranscriptRef.current(), 0)
    }
  }

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
        noiseReduction
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
  }, [filePath, startTime, duration, bands, hpf, lpf, compressor, noiseReduction])

  const playOriginal = () => {
    if (videoRef.current && originalUrl) {
      videoRef.current.src = originalUrl
      videoRef.current.play()
    }
  }

  const playProcessed = () => {
    if (videoRef.current && processedUrl) {
      videoRef.current.src = processedUrl
      videoRef.current.play()
    }
  }

  const statusClass = status
  const statusText = {
    idle: 'Idle - Select a file and render preview',
    rendering: 'Rendering preview...',
    done: 'Done - Ready to play A/B',
    error: `Error: ${errorMsg}`
  }[status]

  return (
    <div>
      <div style={{ textAlign: 'center', fontSize: '2rem', color: '#888', padding: '8px 0' }}>
        Kilroy was here
      </div>

      {/* Mode Switcher */}
      <div style={{ textAlign: 'center', padding: '12px 0', borderBottom: '1px solid #333' }}>
        <button
          onClick={() => setMode('audio')}
          style={{
            padding: '8px 24px',
            marginRight: 8,
            fontSize: 14,
            fontWeight: mode === 'audio' ? 600 : 400,
            background: mode === 'audio' ? '#4fc3f7' : '#555',
            color: mode === 'audio' ? '#000' : '#ccc',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer'
          }}
        >
          Audio Processing
        </button>
        <button
          onClick={() => setMode('transcript')}
          style={{
            padding: '8px 24px',
            fontSize: 14,
            fontWeight: mode === 'transcript' ? 600 : 400,
            background: mode === 'transcript' ? '#4fc3f7' : '#555',
            color: mode === 'transcript' ? '#000' : '#ccc',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer'
          }}
        >
          Transcript Editor
        </button>
      </div>

      {/* Audio Mode */}
      {mode === 'audio' && (
        <>
          {/* Source & Preview Range - Compact Row */}
          <div className="section" style={{ display: 'flex', gap: 24, alignItems: 'center', flexWrap: 'wrap' }}>
        <div>
          <button onClick={handleSelectFile}>Choose Video...</button>
          {filePath && <div className="file-path" style={{ maxWidth: 300 }}>{filePath.split('/').pop()}</div>}
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div className="field">
            <span>Start (sec)</span>
            <input
              type="number"
              min={0}
              value={startTime}
              onChange={e => setStartTime(Number(e.target.value))}
              style={{ width: 60 }}
            />
          </div>
          <div className="field">
            <span>Duration (sec)</span>
            <input
              type="number"
              min={1}
              max={60}
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              style={{ width: 60 }}
            />
          </div>
        </div>
      </div>

      {/* Channel Strips Container */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, padding: '6px 0' }}>
        {/* Compressor Strip */}
        <div style={{
          width: 150,
          background: `
            linear-gradient(180deg,
              rgba(68,68,74,1) 0%,
              rgba(54,54,60,1) 8%,
              rgba(48,48,54,1) 50%,
              rgba(42,42,48,1) 92%,
              rgba(34,34,40,1) 100%
            )
          `,
          border: '1px solid #555',
          borderRadius: 3,
          padding: '10px 0',
          boxShadow: `
            0 2px 8px rgba(0,0,0,0.6),
            0 8px 24px rgba(0,0,0,0.4),
            inset 0 1px 0 rgba(255,255,255,0.12),
            inset 0 -1px 0 rgba(0,0,0,0.3)
          `,
          position: 'relative' as const
        }}>
          {/* Noise texture overlay */}
          <div style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            opacity: 0.03,
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
            pointerEvents: 'none'
          }} />

          {/* COMP Header */}
          <div style={{
            textAlign: 'center',
            padding: '4px 0 5px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.05)',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)'
          }}>
            <span style={{ fontSize: 10, color: '#888', fontWeight: 600, letterSpacing: 2 }}>NR/COMP</span>
          </div>

          {/* DENOISE Section - Noise Reduction (first in signal chain) */}
          <div style={{
            padding: '6px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>DENOISE</span>
              <Toggle checked={noiseReduction.enabled} onChange={v => setNoiseReduction(prev => ({ ...prev, enabled: v }))} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Knob value={noiseReduction.strength} min={0} max={100} defaultValue={50}
                onChange={v => setNoiseReduction(prev => ({ ...prev, strength: v }))} label="STR" unit="%" size={42} emphasis={noiseReduction.enabled ? 'primary' : 'tertiary'} />
            </div>
          </div>

          {/* DYNAMICS Section - Threshold (dominant) + Ratio */}
          <div style={{
            padding: '6px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>DYNAMICS</span>
              <Toggle checked={compressor.enabled} onChange={v => setCompressor(prev => ({ ...prev, enabled: v }))} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Knob value={compressor.threshold} min={-60} max={0} defaultValue={-20}
                onChange={v => setCompressor(prev => ({ ...prev, threshold: v }))} label="" unit="dB" size={54} emphasis="primary" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <Knob value={compressor.ratio} min={1} max={20} defaultValue={4}
                  onChange={v => setCompressor(prev => ({ ...prev, ratio: v }))} label="" unit=":1" size={38} emphasis="secondary" />
                {/* GR Meter placeholder - visual only based on threshold/ratio */}
                <div style={{
                  width: 38,
                  height: 38,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  background: '#0a0a0a',
                  borderRadius: 2,
                  border: '1px solid #333',
                  padding: 2
                }}>
                  {[...Array(6)].map((_, i) => (
                    <div key={i} style={{
                      width: 6,
                      height: 3,
                      marginBottom: 1,
                      borderRadius: 1,
                      background: i < 2 ? '#f44' : i < 4 ? '#fa0' : '#4a4a4a',
                      opacity: compressor.enabled && compressor.mode !== 'LEVEL' ? (i < Math.abs(compressor.threshold) / 10 ? 0.9 : 0.2) : 0.15
                    }} />
                  ))}
                  <span style={{ fontSize: 6, color: '#555', marginTop: 2 }}>GR</span>
                </div>
              </div>
            </div>
          </div>

          {/* TIMING Section - Attack + Release */}
          <div style={{
            padding: '6px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
          }}>
            <div style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>TIMING</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Knob value={compressor.attack} min={0.1} max={200} defaultValue={10}
                onChange={v => setCompressor(prev => ({ ...prev, attack: v }))} label="ATK" unit="" logarithmic size={42} emphasis="secondary" />
              <Knob value={compressor.release} min={10} max={2000} defaultValue={100}
                onChange={v => setCompressor(prev => ({ ...prev, release: v }))} label="REL" unit="" logarithmic size={42} emphasis="secondary" />
            </div>
          </div>

          {/* DETECTOR Section - Emphasis */}
          <div style={{
            padding: '6px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
          }}>
            <div style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>DETECTOR</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Knob value={compressor.emphasis} min={20} max={2000} defaultValue={20}
                onChange={v => setCompressor(prev => ({ ...prev, emphasis: v }))} label="EMPH" unit="" logarithmic size={42} emphasis="tertiary" />
            </div>
          </div>

          {/* OUTPUT Section - Makeup */}
          <div style={{
            padding: '6px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
          }}>
            <div style={{ marginBottom: 4 }}>
              <span style={{ fontSize: 8, color: '#666', fontWeight: 600, letterSpacing: 1 }}>OUTPUT</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Knob value={compressor.makeup} min={-20} max={20} defaultValue={0}
                onChange={v => setCompressor(prev => ({ ...prev, makeup: v }))} label="GAIN" unit="dB" size={42} emphasis="secondary" />
            </div>
          </div>

          {/* MODE Buttons */}
          <div style={{
            padding: '8px 10px',
            display: 'flex',
            justifyContent: 'center',
            gap: 4
          }}>
            {(['LEVEL', 'COMP', 'LIMIT'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setCompressor(prev => ({ ...prev, mode }))}
                style={{
                  padding: '4px 8px',
                  fontSize: 9,
                  fontWeight: 600,
                  letterSpacing: 0.5,
                  border: '1px solid #333',
                  borderRadius: 2,
                  cursor: 'pointer',
                  background: compressor.mode === mode
                    ? 'linear-gradient(180deg, #3a3a3a 0%, #2a2a2a 100%)'
                    : 'linear-gradient(180deg, #4a4a4a 0%, #3a3a3a 100%)',
                  color: compressor.mode === mode ? '#4fc3f7' : '#888',
                  boxShadow: compressor.mode === mode
                    ? 'inset 0 2px 4px rgba(0,0,0,0.5), 0 0 4px rgba(79,195,247,0.2)'
                    : '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)'
                }}
              >
                {mode}
              </button>
            ))}
          </div>
        </div>

        {/* EQ Section - Channel Strip Faceplate */}
        <div style={{
          width: 168,
          background: `
            linear-gradient(180deg,
              rgba(72,72,78,1) 0%,
              rgba(58,58,64,1) 8%,
              rgba(52,52,58,1) 50%,
              rgba(46,46,52,1) 92%,
              rgba(38,38,44,1) 100%
            )
          `,
          border: '1px solid #555',
          borderRadius: 3,
          padding: '10px 0',
          boxShadow: `
            0 2px 8px rgba(0,0,0,0.6),
            0 8px 24px rgba(0,0,0,0.4),
            inset 0 1px 0 rgba(255,255,255,0.12),
            inset 0 -1px 0 rgba(0,0,0,0.3)
          `,
          position: 'relative' as const
        }}>
          {/* Noise texture overlay */}
          <div style={{
            position: 'absolute',
            top: 0, left: 0, right: 0, bottom: 0,
            opacity: 0.03,
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
            pointerEvents: 'none'
          }} />
          {/* EQ Header */}
          <div style={{
            textAlign: 'center',
            padding: '4px 0 5px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 -1px 0 rgba(255,255,255,0.05)',
            background: 'linear-gradient(180deg, rgba(255,255,255,0.02) 0%, transparent 100%)'
          }}>
            <span style={{ fontSize: 10, color: '#888', fontWeight: 600, letterSpacing: 2 }}>EQ</span>
          </div>

          {/* HI Band */}
          <div style={{
            padding: '6px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: '#777', fontWeight: 600, letterSpacing: 1 }}>HI</span>
              <Toggle checked={bands[2].enabled} onChange={v => updateBand(2, 'enabled', v)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Knob value={bands[2].frequency} min={20} max={20000} defaultValue={5000}
                onChange={v => updateBand(2, 'frequency', v)} label="" unit="" logarithmic size={54} emphasis="primary" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <Knob value={bands[2].q} min={0.1} max={10} defaultValue={1.0}
                  onChange={v => updateBand(2, 'q', v)} label="" decimals={1} size={38} emphasis="tertiary" />
                <Knob value={bands[2].gain} min={-24} max={24} defaultValue={0}
                  onChange={v => updateBand(2, 'gain', v)} label="" unit="" decimals={0} size={38} emphasis="secondary" />
              </div>
            </div>
          </div>

          {/* MID Band */}
          <div style={{
            padding: '6px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: '#777', fontWeight: 600, letterSpacing: 1 }}>MID</span>
              <Toggle checked={bands[1].enabled} onChange={v => updateBand(1, 'enabled', v)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Knob value={bands[1].frequency} min={20} max={20000} defaultValue={1000}
                onChange={v => updateBand(1, 'frequency', v)} label="" unit="" logarithmic size={54} emphasis="primary" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <Knob value={bands[1].q} min={0.1} max={10} defaultValue={1.0}
                  onChange={v => updateBand(1, 'q', v)} label="" decimals={1} size={38} emphasis="tertiary" />
                <Knob value={bands[1].gain} min={-24} max={24} defaultValue={0}
                  onChange={v => updateBand(1, 'gain', v)} label="" unit="" decimals={0} size={38} emphasis="secondary" />
              </div>
            </div>
          </div>

          {/* LO Band */}
          <div style={{
            padding: '6px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.4)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), inset 0 -1px 0 rgba(255,255,255,0.02)',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.08) 0%, transparent 40%, rgba(255,255,255,0.02) 100%)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 9, color: '#777', fontWeight: 600, letterSpacing: 1 }}>LO</span>
              <Toggle checked={bands[0].enabled} onChange={v => updateBand(0, 'enabled', v)} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Knob value={bands[0].frequency} min={20} max={20000} defaultValue={200}
                onChange={v => updateBand(0, 'frequency', v)} label="" unit="" logarithmic size={54} emphasis="primary" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                <Knob value={bands[0].q} min={0.1} max={10} defaultValue={1.0}
                  onChange={v => updateBand(0, 'q', v)} label="" decimals={1} size={38} emphasis="tertiary" />
                <Knob value={bands[0].gain} min={-24} max={24} defaultValue={0}
                  onChange={v => updateBand(0, 'gain', v)} label="" unit="" decimals={0} size={38} emphasis="secondary" />
              </div>
            </div>
          </div>

          {/* HP / LP Filters */}
          <div style={{
            padding: '6px 10px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            background: 'linear-gradient(180deg, rgba(0,0,0,0.06) 0%, transparent 50%)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 8, color: '#666', fontWeight: 600, width: 14 }}>HP</span>
              <Knob value={hpf.frequency} min={20} max={2000} defaultValue={80}
                onChange={v => setHpf(prev => ({ ...prev, frequency: v }))} label="" unit="" logarithmic size={36} emphasis="tertiary" />
              <Toggle checked={hpf.enabled} onChange={v => setHpf(prev => ({ ...prev, enabled: v }))} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 8, color: '#666', fontWeight: 600, width: 14 }}>LP</span>
              <Knob value={lpf.frequency} min={1000} max={20000} defaultValue={12000}
                onChange={v => setLpf(prev => ({ ...prev, frequency: v }))} label="" unit="" logarithmic size={36} emphasis="tertiary" />
              <Toggle checked={lpf.enabled} onChange={v => setLpf(prev => ({ ...prev, enabled: v }))} />
            </div>
          </div>
        </div>
      </div>

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
          <div className={`status ${statusClass}`} style={{ marginLeft: 12 }}>
            {statusText}
          </div>
        </div>
      </div>

      {/* Video Preview */}
      <div className="section">
        <video ref={videoRef} controls style={{ width: '100%', maxHeight: 400 }} />
      </div>
        </>
      )}

      {/* Transcript Mode */}
      {mode === 'transcript' && (
        <div style={{ padding: 20 }}>
          {!filePath && (
            <div style={{ textAlign: 'center', padding: 40, color: '#888' }}>
              <p>No media file selected</p>
              <p style={{ fontSize: 14 }}>Choose a video file using the button above to view its transcript</p>
            </div>
          )}

          {filePath && isTranscriptLoading && (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ fontSize: 18, marginBottom: 12 }}>Transcribing audio...</div>
              <div style={{ fontSize: 14, color: '#888' }}>This may take a moment</div>
            </div>
          )}

          {filePath && transcriptError && (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <div style={{ fontSize: 18, color: '#f44', marginBottom: 12 }}>Error loading transcript</div>
              <div style={{ fontSize: 14, color: '#888', marginBottom: 20 }}>{transcriptError}</div>
              <button onClick={loadTranscript}>Retry</button>
            </div>
          )}

          {filePath && transcript && edl && !isTranscriptLoading && !transcriptError && (
            <TranscriptEditor
              transcript={transcript}
              edl={edl}
              onEdlChange={handleEdlChange}
            />
          )}
        </div>
      )}
    </div>
  )
}

export default App
