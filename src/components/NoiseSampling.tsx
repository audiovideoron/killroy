import { useState, useCallback, useEffect } from 'react'
import type { QuietCandidate } from '../../shared/types'

/**
 * Noise Sampling Component
 *
 * Implements deterministic auto-selection with silent advancement on rejection.
 * See: docs/noise-sample-auto-selection-investigation.md
 *
 * Behavior:
 * - Toggle ON: Auto-detect quiet regions, auto-select top-ranked candidate
 * - Reject: Silently advance to next-ranked candidate (no visible "Next" button)
 * - Toggle OFF: Clear noise sample region
 */

interface NoiseSamplingProps {
  filePath: string | null
  onNoiseSampleAccepted: (candidate: QuietCandidate) => void
  onPreviewCandidate: (candidate: QuietCandidate) => void
  onNoiseSamplingDisabled: () => void
}

type DetectionStatus = 'idle' | 'detecting' | 'active' | 'exhausted' | 'none'

export function NoiseSampling({
  filePath,
  onNoiseSampleAccepted,
  onPreviewCandidate,
  onNoiseSamplingDisabled
}: NoiseSamplingProps) {
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<DetectionStatus>('idle')
  const [candidates, setCandidates] = useState<QuietCandidate[]>([])
  const [candidateIndex, setCandidateIndex] = useState(0)

  const currentCandidate = candidates.length > 0 && candidateIndex < candidates.length
    ? candidates[candidateIndex]
    : null

  // Auto-detect when enabled and file is available
  useEffect(() => {
    if (!enabled || !filePath) return

    const detectAndSelect = async () => {
      setStatus('detecting')
      setCandidates([])
      setCandidateIndex(0)

      try {
        const result = await window.electronAPI.detectQuietCandidates(filePath)
        if (result.candidates.length > 0) {
          setCandidates(result.candidates)
          setStatus('active')
          // Auto-select top-ranked candidate (index 0)
          onNoiseSampleAccepted(result.candidates[0])
        } else {
          setStatus('none')
        }
      } catch (err) {
        console.error('[NoiseSampling] Detection error:', err)
        setStatus('none')
      }
    }

    detectAndSelect()
  }, [enabled, filePath, onNoiseSampleAccepted])

  // Handle toggle ON
  const handleEnable = useCallback(() => {
    if (!filePath) return
    setEnabled(true)
  }, [filePath])

  // Handle toggle OFF
  const handleDisable = useCallback(() => {
    setEnabled(false)
    setStatus('idle')
    setCandidates([])
    setCandidateIndex(0)
    onNoiseSamplingDisabled()
  }, [onNoiseSamplingDisabled])

  // Handle rejection - silently advance to next candidate
  // Per investigation doc: "automatic advancement through ranked candidates on rejection"
  const handleReject = useCallback(() => {
    if (candidates.length === 0) return

    const nextIndex = candidateIndex + 1
    if (nextIndex >= candidates.length) {
      // All candidates exhausted
      setStatus('exhausted')
      return
    }

    setCandidateIndex(nextIndex)
    // Auto-select next candidate
    onNoiseSampleAccepted(candidates[nextIndex])
  }, [candidates, candidateIndex, onNoiseSampleAccepted])

  // Handle preview of current candidate
  const handlePreview = useCallback(() => {
    if (!currentCandidate) return
    onPreviewCandidate(currentCandidate)
  }, [currentCandidate, onPreviewCandidate])

  // Reset when file changes
  useEffect(() => {
    setEnabled(false)
    setStatus('idle')
    setCandidates([])
    setCandidateIndex(0)
  }, [filePath])

  const formatTime = (ms: number): string => {
    const seconds = ms / 1000
    const mins = Math.floor(seconds / 60)
    const secs = (seconds % 60).toFixed(1)
    return mins > 0 ? `${mins}:${secs.padStart(4, '0')}` : `${secs}s`
  }

  const formatDuration = (candidate: QuietCandidate): string => {
    const durationMs = candidate.endMs - candidate.startMs
    return formatTime(durationMs)
  }

  // Toggle button style
  const toggleButtonStyle = {
    padding: '6px 14px',
    fontSize: 10,
    fontWeight: 600 as const,
    letterSpacing: 0.5,
    border: enabled ? '1px solid #2e7d32' : '1px solid #333',
    borderRadius: 3,
    cursor: filePath ? 'pointer' : 'not-allowed',
    background: enabled
      ? 'linear-gradient(180deg, #388e3c 0%, #2e7d32 100%)'
      : 'linear-gradient(180deg, #4a4a4a 0%, #3a3a3a 100%)',
    color: enabled ? '#fff' : '#ccc',
    boxShadow: '0 1px 2px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.08)',
    opacity: filePath ? 1 : 0.5
  }

  const smallButtonStyle = {
    padding: '4px 10px',
    fontSize: 9,
    fontWeight: 600 as const,
    border: '1px solid #333',
    borderRadius: 2,
    cursor: 'pointer',
    background: 'linear-gradient(180deg, #4a4a4a 0%, #3a3a3a 100%)',
    color: '#ccc',
    boxShadow: '0 1px 2px rgba(0,0,0,0.3)'
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: '8px 16px',
      background: `
        linear-gradient(180deg,
          rgba(58,58,64,1) 0%,
          rgba(48,48,54,1) 50%,
          rgba(42,42,48,1) 100%
        )
      `,
      border: '1px solid #555',
      borderRadius: 3,
      boxShadow: `
        0 2px 6px rgba(0,0,0,0.4),
        inset 0 1px 0 rgba(255,255,255,0.08)
      `
    }}>
      {/* Header with Toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 10, color: '#888', fontWeight: 600, letterSpacing: 2 }}>
          NOISE SAMPLING
        </span>
        <button
          onClick={enabled ? handleDisable : handleEnable}
          disabled={!filePath}
          style={toggleButtonStyle}
        >
          {status === 'detecting' ? 'Analyzing...' : enabled ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Status Messages */}
      {status === 'none' && (
        <div style={{ fontSize: 11, color: '#f59e0b', padding: '4px 0' }}>
          No quiet sections found in this recording.
        </div>
      )}

      {status === 'exhausted' && (
        <div style={{ fontSize: 11, color: '#f59e0b', padding: '4px 0' }}>
          All candidates rejected. Disable to reset.
        </div>
      )}

      {/* Active Selection */}
      {status === 'active' && currentCandidate && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#4caf50' }}>
            Noise sample:
          </span>
          <span style={{ fontSize: 11, color: '#4fc3f7', fontFamily: 'monospace' }}>
            {formatTime(currentCandidate.startMs)} - {formatTime(currentCandidate.endMs)}
          </span>
          <span style={{ fontSize: 10, color: '#666' }}>
            ({formatDuration(currentCandidate)})
          </span>

          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            <button onClick={handlePreview} style={smallButtonStyle}>
              Preview
            </button>
            {candidates.length > 1 && candidateIndex < candidates.length - 1 && (
              <button
                onClick={handleReject}
                style={{
                  ...smallButtonStyle,
                  border: '1px solid #c62828',
                  background: 'linear-gradient(180deg, #d32f2f 0%, #c62828 100%)',
                  color: '#fff'
                }}
              >
                Reject
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
