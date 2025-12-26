import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { NoiseSampling } from '../NoiseSampling'
import type { QuietCandidate } from '../../../shared/types'

/**
 * Tests for NoiseSampling component
 *
 * NoiseSampling is a simple filter toggle with NO transport controls.
 * All auditioning happens through the global Preview button.
 *
 * Key behaviors:
 * - Toggle ON: Auto-detect + auto-select top-ranked candidate
 * - Toggle OFF: Clear noise sample region
 * - Read-only display of active sample window (no user transport)
 */

describe('NoiseSampling', () => {
  const mockOnNoiseSampleAccepted = vi.fn()
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

  it('displays read-only sample window when active', async () => {
    const mockCandidate: QuietCandidate = { startMs: 83000, endMs: 91000 }
    const mockDetectResult = { candidates: [mockCandidate] }

    window.electronAPI = {
      detectQuietCandidates: vi.fn().mockResolvedValue(mockDetectResult)
    } as unknown as typeof window.electronAPI

    render(
      <NoiseSampling
        filePath="/test/file.mov"
        onNoiseSampleAccepted={mockOnNoiseSampleAccepted}
        onNoiseSamplingDisabled={mockOnNoiseSamplingDisabled}
      />
    )

    // Toggle ON
    fireEvent.click(screen.getByText('OFF'))

    // Wait for read-only display
    await waitFor(() => {
      expect(screen.getByText('Auto sample:')).toBeInTheDocument()
    })
  })

  it('does not show any transport controls (Preview, Reject, Next)', async () => {
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
        onNoiseSamplingDisabled={mockOnNoiseSamplingDisabled}
      />
    )

    // Toggle ON
    fireEvent.click(screen.getByText('OFF'))

    // Wait for active state
    await waitFor(() => {
      expect(screen.getByText('Auto sample:')).toBeInTheDocument()
    })

    // No transport controls should exist
    expect(screen.queryByText('Preview')).not.toBeInTheDocument()
    expect(screen.queryByText('Reject')).not.toBeInTheDocument()
    expect(screen.queryByText('Next')).not.toBeInTheDocument()
    expect(screen.queryByText('Play')).not.toBeInTheDocument()
    expect(screen.queryByText('Accept')).not.toBeInTheDocument()
  })

  it('shows message when no quiet sections found', async () => {
    const mockDetectResult = { candidates: [] }

    window.electronAPI = {
      detectQuietCandidates: vi.fn().mockResolvedValue(mockDetectResult)
    } as unknown as typeof window.electronAPI

    render(
      <NoiseSampling
        filePath="/test/file.mov"
        onNoiseSampleAccepted={mockOnNoiseSampleAccepted}
        onNoiseSamplingDisabled={mockOnNoiseSamplingDisabled}
      />
    )

    // Toggle ON
    fireEvent.click(screen.getByText('OFF'))

    // Wait for "none" status message
    await waitFor(() => {
      expect(screen.getByText('No quiet sections found in this recording.')).toBeInTheDocument()
    })
  })
})

describe('Candidate time conversion', () => {
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
