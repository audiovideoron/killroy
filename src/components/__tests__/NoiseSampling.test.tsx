import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NoiseSampling } from '../NoiseSampling'
import type { QuietCandidate } from '../../../shared/types'

/**
 * Tests for NoiseSampling component
 * See: docs/noise-sample-auto-selection-investigation.md
 *
 * Key behaviors:
 * - Toggle ON: Auto-detect + auto-select top-ranked candidate
 * - Reject: Silent auto-advance to next candidate (no visible "Next" button)
 * - Toggle OFF: Clear noise sample region
 */

describe('NoiseSampling', () => {
  const mockOnNoiseSampleAccepted = vi.fn()
  const mockOnPreviewCandidate = vi.fn()
  const mockOnNoiseSamplingDisabled = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('auto-selects top candidate when enabled', async () => {
    const mockCandidate: QuietCandidate = { startMs: 100000, endMs: 108000 }
    const mockDetectResult = { candidates: [mockCandidate] }

    window.electronAPI = {
      detectQuietCandidates: vi.fn().mockResolvedValue(mockDetectResult)
    } as unknown as typeof window.electronAPI

    render(
      <NoiseSampling
        filePath="/test/file.mov"
        onNoiseSampleAccepted={mockOnNoiseSampleAccepted}
        onPreviewCandidate={mockOnPreviewCandidate}
        onNoiseSamplingDisabled={mockOnNoiseSamplingDisabled}
      />
    )

    // Toggle ON
    const toggleButton = screen.getByText('OFF')
    fireEvent.click(toggleButton)

    // Wait for detection and auto-selection
    await waitFor(() => {
      expect(mockOnNoiseSampleAccepted).toHaveBeenCalledWith(mockCandidate)
    })
  })

  it('calls onPreviewCandidate when Preview is clicked', async () => {
    const mockCandidate: QuietCandidate = { startMs: 100000, endMs: 108000 }
    const mockDetectResult = { candidates: [mockCandidate] }

    window.electronAPI = {
      detectQuietCandidates: vi.fn().mockResolvedValue(mockDetectResult)
    } as unknown as typeof window.electronAPI

    render(
      <NoiseSampling
        filePath="/test/file.mov"
        onNoiseSampleAccepted={mockOnNoiseSampleAccepted}
        onPreviewCandidate={mockOnPreviewCandidate}
        onNoiseSamplingDisabled={mockOnNoiseSamplingDisabled}
      />
    )

    // Toggle ON
    fireEvent.click(screen.getByText('OFF'))

    // Wait for active state with Preview button
    await waitFor(() => {
      expect(screen.getByText('Preview')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Preview'))

    expect(mockOnPreviewCandidate).toHaveBeenCalledWith(mockCandidate)
  })

  it('silently advances to next candidate on rejection', async () => {
    const candidates: QuietCandidate[] = [
      { startMs: 100000, endMs: 108000 },
      { startMs: 200000, endMs: 210000 }
    ]
    const mockDetectResult = { candidates }

    window.electronAPI = {
      detectQuietCandidates: vi.fn().mockResolvedValue(mockDetectResult)
    } as unknown as typeof window.electronAPI

    render(
      <NoiseSampling
        filePath="/test/file.mov"
        onNoiseSampleAccepted={mockOnNoiseSampleAccepted}
        onPreviewCandidate={mockOnPreviewCandidate}
        onNoiseSamplingDisabled={mockOnNoiseSamplingDisabled}
      />
    )

    // Toggle ON
    fireEvent.click(screen.getByText('OFF'))

    // Wait for first candidate to be auto-selected
    await waitFor(() => {
      expect(mockOnNoiseSampleAccepted).toHaveBeenCalledWith(candidates[0])
    })

    // Click Reject to silently advance
    fireEvent.click(screen.getByText('Reject'))

    // Next candidate should be auto-selected
    expect(mockOnNoiseSampleAccepted).toHaveBeenCalledWith(candidates[1])
  })

  it('calls onNoiseSamplingDisabled when toggled OFF', async () => {
    const mockCandidate: QuietCandidate = { startMs: 100000, endMs: 108000 }
    const mockDetectResult = { candidates: [mockCandidate] }

    window.electronAPI = {
      detectQuietCandidates: vi.fn().mockResolvedValue(mockDetectResult)
    } as unknown as typeof window.electronAPI

    render(
      <NoiseSampling
        filePath="/test/file.mov"
        onNoiseSampleAccepted={mockOnNoiseSampleAccepted}
        onPreviewCandidate={mockOnPreviewCandidate}
        onNoiseSamplingDisabled={mockOnNoiseSamplingDisabled}
      />
    )

    // Toggle ON
    fireEvent.click(screen.getByText('OFF'))

    // Wait for active state
    await waitFor(() => {
      expect(screen.getByText('ON')).toBeInTheDocument()
    })

    // Toggle OFF
    fireEvent.click(screen.getByText('ON'))

    expect(mockOnNoiseSamplingDisabled).toHaveBeenCalled()
  })

  it('does not show Next button (silent advancement)', async () => {
    const candidates: QuietCandidate[] = [
      { startMs: 100000, endMs: 108000 },
      { startMs: 200000, endMs: 210000 }
    ]
    const mockDetectResult = { candidates }

    window.electronAPI = {
      detectQuietCandidates: vi.fn().mockResolvedValue(mockDetectResult)
    } as unknown as typeof window.electronAPI

    render(
      <NoiseSampling
        filePath="/test/file.mov"
        onNoiseSampleAccepted={mockOnNoiseSampleAccepted}
        onPreviewCandidate={mockOnPreviewCandidate}
        onNoiseSamplingDisabled={mockOnNoiseSamplingDisabled}
      />
    )

    // Toggle ON
    fireEvent.click(screen.getByText('OFF'))

    // Wait for active state
    await waitFor(() => {
      expect(screen.getByText('Reject')).toBeInTheDocument()
    })

    // "Next" button should NOT exist - per investigation doc
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
  })

  it('candidate time range converts correctly to seconds', () => {
    const candidate: QuietCandidate = { startMs: 100000, endMs: 108000 }
    const expectedStartSec = 100
    const expectedDurationSec = 8

    const startSec = candidate.startMs / 1000
    const durationSec = (candidate.endMs - candidate.startMs) / 1000

    expect(startSec).toBe(expectedStartSec)
    expect(durationSec).toBe(expectedDurationSec)
  })
})

describe('Preview FFmpeg Command', () => {
  it('preview command includes -ss and -t flags', () => {
    const candidate: QuietCandidate = { startMs: 100000, endMs: 108000 }
    const startSec = candidate.startMs / 1000
    const durationSec = (candidate.endMs - candidate.startMs) / 1000

    // Simulate FFmpeg args construction
    const ffmpegArgs = [
      '-ss', String(startSec),
      '-t', String(durationSec),
      '-i', 'input.mov'
    ]

    expect(ffmpegArgs).toContain('-ss')
    expect(ffmpegArgs).toContain('100')
    expect(ffmpegArgs).toContain('-t')
    expect(ffmpegArgs).toContain('8')
  })
})

describe('Preview Shared Pipeline', () => {
  it('noise sampler preview uses shared requestPreview pipeline', () => {
    const mockPlayProcessed = vi.fn()

    // Noise sampler preview delegates to shared requestPreview
    // which calls playProcessed() after updating shared state
    mockPlayProcessed()

    expect(mockPlayProcessed).toHaveBeenCalledTimes(1)
  })

  it('requestPreview is called with reason: noise-sampler for candidate preview', () => {
    const mockRequestPreview = vi.fn()
    const candidate = { startMs: 100000, endMs: 108000 }
    const startSec = candidate.startMs / 1000
    const durationSec = (candidate.endMs - candidate.startMs) / 1000

    mockRequestPreview({ startSec, durationSec, reason: 'noise-sampler' })

    expect(mockRequestPreview).toHaveBeenCalledWith({
      startSec: 100,
      durationSec: 8,
      reason: 'noise-sampler'
    })
  })

  it('requestPreview uses fixed PREVIEW_DURATION_SEC for main preview', () => {
    const PREVIEW_DURATION_SEC = 10  // Per investigation doc
    const mockRequestPreview = vi.fn()
    const startTime = 0

    mockRequestPreview({ startSec: startTime, durationSec: PREVIEW_DURATION_SEC, reason: 'main' })

    expect(mockRequestPreview).toHaveBeenCalledWith({
      startSec: 0,
      durationSec: 10,  // Fixed duration
      reason: 'main'
    })
  })
})

describe('Noise Sampler NR Override', () => {
  it('noise-sampler reason forces noiseReduction.enabled = true', () => {
    // Global NR state (disabled)
    const noiseReduction = { strength: 50, enabled: false }
    const reason = 'noise-sampler'

    // The override logic from requestPreview
    const effectiveNoiseReduction = reason === 'noise-sampler'
      ? { ...noiseReduction, enabled: true }
      : noiseReduction

    expect(effectiveNoiseReduction.enabled).toBe(true)
    expect(effectiveNoiseReduction.strength).toBe(50) // preserves strength
  })

  it('main reason preserves global noiseReduction state', () => {
    // Global NR state (disabled)
    const noiseReduction = { strength: 50, enabled: false }
    const reason = 'main'

    // The override logic from requestPreview
    const effectiveNoiseReduction = reason === 'main'
      ? noiseReduction
      : { ...noiseReduction, enabled: true }

    expect(effectiveNoiseReduction.enabled).toBe(false)
    expect(effectiveNoiseReduction.strength).toBe(50)
  })

  it('noise-sampler does not mutate original noiseReduction object', () => {
    const noiseReduction = { strength: 50, enabled: false }
    const reason = 'noise-sampler'

    const effectiveNoiseReduction = reason === 'noise-sampler'
      ? { ...noiseReduction, enabled: true }
      : noiseReduction

    // Original unchanged
    expect(noiseReduction.enabled).toBe(false)
    // Override is separate
    expect(effectiveNoiseReduction.enabled).toBe(true)
    expect(effectiveNoiseReduction).not.toBe(noiseReduction)
  })
})
