import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useJobProgress, MIN_VISIBLE_MS, TERMINAL_DWELL_MS } from './useJobProgress'
import type { JobProgressEvent } from '../../shared/types'

describe('useJobProgress hook', () => {
  let mockOnJobProgress: vi.Mock
  let progressCallbacks: ((event: JobProgressEvent) => void)[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    progressCallbacks = []

    mockOnJobProgress = vi.fn((callback: (event: JobProgressEvent) => void) => {
      progressCallbacks.push(callback)
      return () => {
        progressCallbacks = progressCallbacks.filter(cb => cb !== callback)
      }
    })

    window.electronAPI = {
      onJobProgress: mockOnJobProgress
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('Timing enforcement logic', () => {
    it('enforces MIN_VISIBLE_MS when job completes quickly', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-1',
        status: 'running',
        percent: 0,
        phase: 'test-phase'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      expect(result.current.currentJob?.status).toBe('running')

      // Complete job quickly
      const completeEvent: JobProgressEvent = {
        jobId: 'job-1',
        status: 'completed',
        percent: 1.0
      }

      act(() => {
        progressCallbacks[0](completeEvent)
      })

      // Terminal should not show immediately
      expect(result.current.currentJob?.status).toBe('running')

      // Advance time but not enough to reach MIN_VISIBLE_MS
      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS - 100)
      })

      expect(result.current.currentJob?.status).toBe('running')

      // Advance to MIN_VISIBLE_MS
      act(() => {
        vi.advanceTimersByTime(100)
      })

      expect(result.current.currentJob?.status).toBe('completed')
    })

    it('shows terminal immediately when job runs longer than MIN_VISIBLE_MS', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-2',
        status: 'running',
        percent: 0.5,
        phase: 'processing'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      // Advance time past MIN_VISIBLE_MS
      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS + 100)
      })

      // Complete job
      const completeEvent: JobProgressEvent = {
        jobId: 'job-2',
        status: 'completed'
      }

      act(() => {
        progressCallbacks[0](completeEvent)
      })

      // Terminal should show immediately
      expect(result.current.currentJob?.status).toBe('completed')
    })

    it('enforces TERMINAL_DWELL_MS before clearing state', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-3',
        status: 'running',
        percent: 0
      }

      act(() => {
        progressCallbacks[0](event)
      })

      // Advance past MIN_VISIBLE_MS
      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS + 100)
      })

      // Complete job
      const completeEvent: JobProgressEvent = {
        jobId: 'job-3',
        status: 'completed'
      }

      act(() => {
        progressCallbacks[0](completeEvent)
      })

      expect(result.current.currentJob?.status).toBe('completed')

      // Advance but not past TERMINAL_DWELL_MS
      act(() => {
        vi.advanceTimersByTime(TERMINAL_DWELL_MS - 100)
      })

      expect(result.current.currentJob?.status).toBe('completed')

      // Advance past TERMINAL_DWELL_MS
      act(() => {
        vi.advanceTimersByTime(100)
      })

      expect(result.current.currentJob).toBeNull()
    })
  })

  describe('Progress update behavior', () => {
    it('updates running state immediately', () => {
      const { result } = renderHook(() => useJobProgress())

      const event1: JobProgressEvent = {
        jobId: 'job-4',
        status: 'running',
        percent: 0.25,
        phase: 'phase-1'
      }

      act(() => {
        progressCallbacks[0](event1)
      })

      expect(result.current.currentJob).toEqual({
        jobId: 'job-4',
        phase: 'phase-1',
        percent: 0.25,
        indeterminate: false,
        status: 'running',
        firstRunningAt: expect.any(Number)
      })

      // Update progress
      const event2: JobProgressEvent = {
        jobId: 'job-4',
        status: 'running',
        percent: 0.75,
        phase: 'phase-2'
      }

      act(() => {
        progressCallbacks[0](event2)
      })

      expect(result.current.currentJob?.percent).toBe(0.75)
      expect(result.current.currentJob?.phase).toBe('phase-2')
    })

    it('preserves firstRunningAt across progress updates', () => {
      const { result } = renderHook(() => useJobProgress())

      const event1: JobProgressEvent = {
        jobId: 'job-5',
        status: 'running',
        percent: 0
      }

      act(() => {
        progressCallbacks[0](event1)
      })

      const firstRunningAt = result.current.currentJob?.firstRunningAt

      // Progress updates
      const event2: JobProgressEvent = {
        jobId: 'job-5',
        status: 'running',
        percent: 0.5
      }

      act(() => {
        progressCallbacks[0](event2)
      })

      expect(result.current.currentJob?.firstRunningAt).toBe(firstRunningAt)
    })

    it('handles queued state correctly', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-6',
        status: 'queued',
        phase: 'queuing'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      expect(result.current.currentJob).toEqual({
        jobId: 'job-6',
        phase: 'queuing',
        percent: 0,
        indeterminate: true,
        status: 'queued'
      })
    })

    it('transitions from queued to running', () => {
      const { result } = renderHook(() => useJobProgress())

      const queuedEvent: JobProgressEvent = {
        jobId: 'job-7',
        status: 'queued'
      }

      act(() => {
        progressCallbacks[0](queuedEvent)
      })

      expect(result.current.currentJob?.status).toBe('queued')

      const runningEvent: JobProgressEvent = {
        jobId: 'job-7',
        status: 'running',
        percent: 0.1
      }

      act(() => {
        progressCallbacks[0](runningEvent)
      })

      expect(result.current.currentJob?.status).toBe('running')
      expect(result.current.currentJob?.percent).toBe(0.1)
    })
  })

  describe('Terminal states', () => {
    it('clears phase on completion', () => {
      const { result } = renderHook(() => useJobProgress())

      const runningEvent: JobProgressEvent = {
        jobId: 'job-8',
        status: 'running',
        phase: 'rendering',
        percent: 0.9
      }

      act(() => {
        progressCallbacks[0](runningEvent)
      })

      expect(result.current.currentJob?.phase).toBe('rendering')

      // Advance past MIN_VISIBLE_MS
      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS + 100)
      })

      const completeEvent: JobProgressEvent = {
        jobId: 'job-8',
        status: 'completed'
      }

      act(() => {
        progressCallbacks[0](completeEvent)
      })

      expect(result.current.currentJob?.phase).toBe('')
      expect(result.current.currentJob?.percent).toBe(1.0)
    })

    it('preserves phase for non-completion terminal states', () => {
      const { result } = renderHook(() => useJobProgress())

      const runningEvent: JobProgressEvent = {
        jobId: 'job-9',
        status: 'running',
        phase: 'processing',
        percent: 0.5
      }

      act(() => {
        progressCallbacks[0](runningEvent)
      })

      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS + 100)
      })

      const failedEvent: JobProgressEvent = {
        jobId: 'job-9',
        status: 'failed',
        phase: 'processing'
      }

      act(() => {
        progressCallbacks[0](failedEvent)
      })

      expect(result.current.currentJob?.phase).toBe('processing')
      expect(result.current.currentJob?.status).toBe('failed')
    })

    it('handles all terminal status types', () => {
      const terminals: Array<JobProgressEvent['status']> = ['completed', 'failed', 'cancelled', 'timed_out']

      terminals.forEach((status, index) => {
        // Reset callbacks for each iteration
        progressCallbacks = []

        const { result } = renderHook(() => useJobProgress())

        const runningEvent: JobProgressEvent = {
          jobId: `job-terminal-${index}`,
          status: 'running'
        }

        act(() => {
          progressCallbacks[0](runningEvent)
        })

        act(() => {
          vi.advanceTimersByTime(MIN_VISIBLE_MS + 100)
        })

        const terminalEvent: JobProgressEvent = {
          jobId: `job-terminal-${index}`,
          status: status
        }

        act(() => {
          progressCallbacks[0](terminalEvent)
        })

        expect(result.current.currentJob?.status).toBe(status)

        // Verify clearing happens
        act(() => {
          vi.advanceTimersByTime(TERMINAL_DWELL_MS)
        })

        expect(result.current.currentJob).toBeNull()
      })
    })
  })

  describe('Edge cases', () => {
    it('handles 0% progress', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-10',
        status: 'running',
        percent: 0
      }

      act(() => {
        progressCallbacks[0](event)
      })

      expect(result.current.currentJob?.percent).toBe(0)
    })

    it('handles 100% progress', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-11',
        status: 'running',
        percent: 1.0
      }

      act(() => {
        progressCallbacks[0](event)
      })

      expect(result.current.currentJob?.percent).toBe(1.0)
    })

    it('handles missing percent with default 0', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-12',
        status: 'running'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      expect(result.current.currentJob?.percent).toBe(0)
    })

    it('handles rapid progress updates', () => {
      const { result } = renderHook(() => useJobProgress())

      const event1: JobProgressEvent = {
        jobId: 'job-13',
        status: 'running',
        percent: 0.1
      }

      act(() => {
        progressCallbacks[0](event1)
      })

      const event2: JobProgressEvent = {
        jobId: 'job-13',
        status: 'running',
        percent: 0.2
      }

      act(() => {
        progressCallbacks[0](event2)
      })

      const event3: JobProgressEvent = {
        jobId: 'job-13',
        status: 'running',
        percent: 0.3
      }

      act(() => {
        progressCallbacks[0](event3)
      })

      expect(result.current.currentJob?.percent).toBe(0.3)
    })

    it('handles indeterminate progress', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-14',
        status: 'running',
        indeterminate: true
      }

      act(() => {
        progressCallbacks[0](event)
      })

      expect(result.current.currentJob?.indeterminate).toBe(true)
    })

    it('handles missing firstRunningAt on terminal (shows immediately)', () => {
      const { result } = renderHook(() => useJobProgress())

      // Trigger terminal directly without running first
      const terminalEvent: JobProgressEvent = {
        jobId: 'job-15',
        status: 'completed'
      }

      act(() => {
        progressCallbacks[0](terminalEvent)
      })

      // Should show terminal immediately without waiting
      expect(result.current.currentJob?.status).toBe('completed')
    })

    it('handles completion at exactly MIN_VISIBLE_MS boundary', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-16',
        status: 'running'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS)
      })

      const completeEvent: JobProgressEvent = {
        jobId: 'job-16',
        status: 'completed'
      }

      act(() => {
        progressCallbacks[0](completeEvent)
      })

      // Should show immediately (no additional delay)
      expect(result.current.currentJob?.status).toBe('completed')
    })
  })

  describe('Multiple jobs', () => {
    it('tracks multiple independent jobs', () => {
      const { result: result1 } = renderHook(() => useJobProgress())
      const { result: result2 } = renderHook(() => useJobProgress())

      const event1: JobProgressEvent = {
        jobId: 'job-multi-1',
        status: 'running',
        percent: 0.5
      }

      const event2: JobProgressEvent = {
        jobId: 'job-multi-2',
        status: 'running',
        percent: 0.3
      }

      act(() => {
        progressCallbacks[0](event1)
        progressCallbacks[1](event2)
      })

      expect(result1.current.currentJob?.jobId).toBe('job-multi-1')
      expect(result2.current.currentJob?.jobId).toBe('job-multi-2')
    })

    it('handles job cancellation clearing previous timer', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-17',
        status: 'running'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS + 100)
      })

      const completeEvent: JobProgressEvent = {
        jobId: 'job-17',
        status: 'completed'
      }

      act(() => {
        progressCallbacks[0](completeEvent)
      })

      expect(result.current.currentJob?.status).toBe('completed')

      // New completion event for same job
      const failEvent: JobProgressEvent = {
        jobId: 'job-17',
        status: 'failed'
      }

      act(() => {
        progressCallbacks[0](failEvent)
      })

      // Should update and not have duplicate timers
      expect(result.current.currentJob?.status).toBe('failed')
    })
  })

  describe('Cleanup and unmounting', () => {
    it('clears timers on unmount', () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
      const { unmount } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-18',
        status: 'running'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS + 100)
      })

      const completeEvent: JobProgressEvent = {
        jobId: 'job-18',
        status: 'completed'
      }

      act(() => {
        progressCallbacks[0](completeEvent)
      })

      unmount()

      // Should have called clearTimeout for the dwell timer
      expect(clearTimeoutSpy).toHaveBeenCalled()
      clearTimeoutSpy.mockRestore()
    })

    it('calls cleanup function returned by onJobProgress', () => {
      const { unmount } = renderHook(() => useJobProgress())

      unmount()

      // mockOnJobProgress should have been called once with the callback
      expect(mockOnJobProgress).toHaveBeenCalledTimes(1)
      expect(mockOnJobProgress).toHaveBeenCalledWith(expect.any(Function))
    })
  })

  describe('Default values and fallbacks', () => {
    it('uses default phase for running events without phase', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-19',
        status: 'running'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      expect(result.current.currentJob?.phase).toBe('')
    })

    it('uses default indeterminate false for running events', () => {
      const { result } = renderHook(() => useJobProgress())

      const event: JobProgressEvent = {
        jobId: 'job-20',
        status: 'running'
      }

      act(() => {
        progressCallbacks[0](event)
      })

      expect(result.current.currentJob?.indeterminate).toBe(false)
    })

    it('sets percent to 1.0 on completion', () => {
      const { result } = renderHook(() => useJobProgress())

      const runningEvent: JobProgressEvent = {
        jobId: 'job-21',
        status: 'running',
        percent: 0.8
      }

      act(() => {
        progressCallbacks[0](runningEvent)
      })

      act(() => {
        vi.advanceTimersByTime(MIN_VISIBLE_MS + 100)
      })

      const completeEvent: JobProgressEvent = {
        jobId: 'job-21',
        status: 'completed'
      }

      act(() => {
        progressCallbacks[0](completeEvent)
      })

      expect(result.current.currentJob?.percent).toBe(1.0)
    })
  })
})
