import { useState, useCallback, useEffect } from 'react'
import type { QuietCandidate } from '../../shared/types'

/**
 * Noise Sampling Component
 *
 * Simple filter toggle that auto-detects and auto-selects a noise sample.
 * No transport controls - all auditioning happens through global Preview.
 *
 * Behavior:
 * - Toggle ON: Auto-detect quiet regions, auto-select top-ranked candidate
 * - Toggle OFF: Clear noise sample region
 * - Read-only display of active sample window when enabled
 */

interface NoiseSamplingProps {
  filePath: string | null
  onNoiseSampleAccepted: (candidate: QuietCandidate) => void
  onNoiseSamplingDisabled: () => void
}

type DetectionStatus = 'idle' | 'detecting' | 'active' | 'none'

export function NoiseSampling({
  filePath,
  onNoiseSampleAccepted,
  onNoiseSamplingDisabled
}: NoiseSamplingProps) {
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<DetectionStatus>('idle')
  const [currentCandidate, setCurrentCandidate] = useState<QuietCandidate | null>(null)

  // Auto-detect when enabled and file is available
  useEffect(() => {
    if (!enabled || !filePath) return

    const detectAndSelect = async () => {
      setStatus('detecting')
      setCurrentCandidate(null)

      try {
        const result = await window.electronAPI.detectQuietCandidates(filePath)
        if (result.candidates.length > 0) {
          const topCandidate = result.candidates[0]
          setCurrentCandidate(topCandidate)
          setStatus('active')
          onNoiseSampleAccepted(topCandidate)
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
    setCurrentCandidate(null)
    onNoiseSamplingDisabled()
  }, [onNoiseSamplingDisabled])

  // Reset when file changes
  useEffect(() => {
    setEnabled(false)
    setStatus('idle')
    setCurrentCandidate(null)
  }, [filePath])

  const formatTime = (ms: number): string => {
    const seconds = ms / 1000
    const mins = Math.floor(seconds / 60)
    const secs = (seconds % 60).toFixed(1)
    return mins > 0 ? `${mins}:${secs.padStart(4, '0')}` : `${secs}s`
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

      {/* Read-only display of active sample window */}
      {status === 'active' && currentCandidate && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#4caf50' }}>
            Auto sample:
          </span>
          <span style={{ fontSize: 11, color: '#4fc3f7', fontFamily: 'monospace' }}>
            {formatTime(currentCandidate.startMs)} - {formatTime(currentCandidate.endMs)}
          </span>
        </div>
      )}
    </div>
  )
}
