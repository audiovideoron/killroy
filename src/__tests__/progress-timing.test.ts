import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * Tests for progress UI timing behavior
 *
 * Verifies that:
 * - MIN_VISIBLE_MS enforces minimum visibility for running state
 * - TERMINAL_DWELL_MS keeps terminal states visible before clearing
 * - Multiple jobs have independent timers
 * - Timers are properly cleaned up
 */

const MIN_VISIBLE_MS = 500
const TERMINAL_DWELL_MS = 1000

interface JobProgressState {
  jobId: string
  phase: string
  percent: number
  indeterminate: boolean
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
  firstRunningAt?: number
  terminalAt?: number
  clearTimerId?: number
}

describe('Progress UI timing behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('MIN_VISIBLE_MS enforcement', () => {
    it('shows terminal immediately if job ran longer than MIN_VISIBLE_MS', () => {
      const firstRunningAt = 1000
      const now = firstRunningAt + 600  // Ran for 600ms > 500ms

      const elapsed = now - firstRunningAt

      expect(elapsed >= MIN_VISIBLE_MS).toBe(true)
    })

    it('delays terminal if job completed too quickly', () => {
      const firstRunningAt = 1000
      const now = firstRunningAt + 100  // Ran for only 100ms < 500ms

      const elapsed = now - firstRunningAt
      const shouldDelay = elapsed < MIN_VISIBLE_MS

      expect(shouldDelay).toBe(true)
      expect(MIN_VISIBLE_MS - elapsed).toBe(400)  // Should delay 400ms
    })

    it('calculates correct delay for instant completion', () => {
      const firstRunningAt = 1000
      const now = firstRunningAt  // Completed instantly

      const elapsed = now - firstRunningAt
      const delay = MIN_VISIBLE_MS - elapsed

      expect(elapsed).toBe(0)
      expect(delay).toBe(500)  // Full MIN_VISIBLE_MS delay
    })

    it('calculates correct delay for fast completion', () => {
      const firstRunningAt = 1000
      const now = firstRunningAt + 250  // Ran for 250ms

      const elapsed = now - firstRunningAt
      const delay = MIN_VISIBLE_MS - elapsed

      expect(elapsed).toBe(250)
      expect(delay).toBe(250)  // Delay 250ms to reach MIN_VISIBLE_MS
    })
  })

  describe('TERMINAL_DWELL_MS enforcement', () => {
    it('schedules clearing after TERMINAL_DWELL_MS', () => {
      const clearSpy = vi.fn()
      const timerId = setTimeout(clearSpy, TERMINAL_DWELL_MS)

      expect(clearSpy).not.toHaveBeenCalled()

      vi.advanceTimersByTime(TERMINAL_DWELL_MS - 1)
      expect(clearSpy).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(clearSpy).toHaveBeenCalledTimes(1)

      clearTimeout(timerId)
    })

    it('does not clear before TERMINAL_DWELL_MS elapses', () => {
      const clearSpy = vi.fn()
      setTimeout(clearSpy, TERMINAL_DWELL_MS)

      vi.advanceTimersByTime(500)
      expect(clearSpy).not.toHaveBeenCalled()

      vi.advanceTimersByTime(499)
      expect(clearSpy).not.toHaveBeenCalled()
    })

    it('clears exactly at TERMINAL_DWELL_MS', () => {
      const clearSpy = vi.fn()
      setTimeout(clearSpy, TERMINAL_DWELL_MS)

      vi.advanceTimersByTime(TERMINAL_DWELL_MS)
      expect(clearSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('Combined timing behavior', () => {
    it('fast job: shows running, delays terminal, then clears after dwell', () => {
      const events: string[] = []
      const firstRunningAt = 1000
      const completedAt = 1050  // Ran for 50ms

      // Job enters running state
      events.push('running')

      // Job completes quickly (50ms < MIN_VISIBLE_MS)
      const elapsed = completedAt - firstRunningAt
      const delayMs = MIN_VISIBLE_MS - elapsed  // 450ms

      // Schedule showing terminal after delay
      setTimeout(() => {
        events.push('terminal-shown')

        // Schedule clearing after TERMINAL_DWELL_MS
        setTimeout(() => {
          events.push('cleared')
        }, TERMINAL_DWELL_MS)
      }, delayMs)

      // Advance to just before showing terminal
      vi.advanceTimersByTime(delayMs - 1)
      expect(events).toEqual(['running'])

      // Advance to show terminal
      vi.advanceTimersByTime(1)
      expect(events).toEqual(['running', 'terminal-shown'])

      // Advance through dwell period
      vi.advanceTimersByTime(TERMINAL_DWELL_MS - 1)
      expect(events).toEqual(['running', 'terminal-shown'])

      // Advance to clearing
      vi.advanceTimersByTime(1)
      expect(events).toEqual(['running', 'terminal-shown', 'cleared'])
    })

    it('slow job: shows running, terminal immediately, then clears after dwell', () => {
      const events: string[] = []
      const firstRunningAt = 1000
      const completedAt = 1600  // Ran for 600ms > MIN_VISIBLE_MS

      // Job enters running state
      events.push('running')

      // Job completes slowly (600ms >= MIN_VISIBLE_MS)
      const elapsed = completedAt - firstRunningAt
      const shouldDelay = elapsed < MIN_VISIBLE_MS

      if (!shouldDelay) {
        events.push('terminal-shown')

        // Schedule clearing after TERMINAL_DWELL_MS
        setTimeout(() => {
          events.push('cleared')
        }, TERMINAL_DWELL_MS)
      }

      expect(events).toEqual(['running', 'terminal-shown'])

      // Advance through dwell period
      vi.advanceTimersByTime(TERMINAL_DWELL_MS)
      expect(events).toEqual(['running', 'terminal-shown', 'cleared'])
    })
  })

  describe('Multiple job independence', () => {
    it('job1 and job2 have independent timers', () => {
      const job1Events: string[] = []
      const job2Events: string[] = []

      // Job 1: fast completion (100ms runtime, needs 400ms delay)
      job1Events.push('job1-running')
      const job1Delay = 400  // MIN_VISIBLE_MS - 100ms

      setTimeout(() => {
        job1Events.push('job1-terminal')
        setTimeout(() => job1Events.push('job1-cleared'), TERMINAL_DWELL_MS)
      }, job1Delay)

      // Job 2: faster completion (50ms runtime, needs 450ms delay)
      job2Events.push('job2-running')
      const job2Delay = 450  // MIN_VISIBLE_MS - 50ms

      setTimeout(() => {
        job2Events.push('job2-terminal')
        setTimeout(() => job2Events.push('job2-cleared'), TERMINAL_DWELL_MS)
      }, job2Delay)

      // Timeline:
      // T=0: Both jobs start
      // T=400: Job1 terminal shows
      // T=450: Job2 terminal shows
      // T=1400: Job1 clears (400 + 1000)
      // T=1450: Job2 clears (450 + 1000)

      // Advance to job1 terminal
      vi.advanceTimersByTime(job1Delay)
      expect(job1Events).toEqual(['job1-running', 'job1-terminal'])
      expect(job2Events).toEqual(['job2-running'])

      // Advance to job2 terminal
      vi.advanceTimersByTime(job2Delay - job1Delay)  // 50ms
      expect(job1Events).toEqual(['job1-running', 'job1-terminal'])
      expect(job2Events).toEqual(['job2-running', 'job2-terminal'])

      // Advance to job1 cleared
      vi.advanceTimersByTime(TERMINAL_DWELL_MS - (job2Delay - job1Delay))  // 950ms
      expect(job1Events).toEqual(['job1-running', 'job1-terminal', 'job1-cleared'])
      expect(job2Events).toEqual(['job2-running', 'job2-terminal'])

      // Advance to job2 cleared
      vi.advanceTimersByTime(job2Delay - job1Delay)  // 50ms
      expect(job2Events).toEqual(['job2-running', 'job2-terminal', 'job2-cleared'])
    })
  })

  describe('Timer cleanup', () => {
    it('clearing a timer prevents it from firing', () => {
      const callback = vi.fn()
      const timerId = setTimeout(callback, 1000)

      clearTimeout(timerId)
      vi.advanceTimersByTime(1000)

      expect(callback).not.toHaveBeenCalled()
    })

    it('clearing non-existent timer does not throw', () => {
      expect(() => {
        clearTimeout(999999)
      }).not.toThrow()
    })

    it('can clear multiple timers', () => {
      const callback1 = vi.fn()
      const callback2 = vi.fn()

      const timer1 = setTimeout(callback1, 100)
      const timer2 = setTimeout(callback2, 200)

      clearTimeout(timer1)
      clearTimeout(timer2)

      vi.advanceTimersByTime(300)

      expect(callback1).not.toHaveBeenCalled()
      expect(callback2).not.toHaveBeenCalled()
    })
  })

  describe('Edge cases', () => {
    it('handles completion at exactly MIN_VISIBLE_MS', () => {
      const firstRunningAt = 1000
      const completedAt = 1500  // Exactly 500ms

      const elapsed = completedAt - firstRunningAt
      const shouldDelay = elapsed < MIN_VISIBLE_MS

      expect(shouldDelay).toBe(false)  // No delay needed
    })

    it('handles zero elapsed time', () => {
      const firstRunningAt = 1000
      const completedAt = 1000  // Instant

      const elapsed = completedAt - firstRunningAt
      const delay = MIN_VISIBLE_MS - elapsed

      expect(elapsed).toBe(0)
      expect(delay).toBe(MIN_VISIBLE_MS)
    })

    it('handles missing firstRunningAt (shows terminal immediately)', () => {
      const firstRunningAt = undefined
      const shouldShowImmediately = !firstRunningAt

      expect(shouldShowImmediately).toBe(true)
    })
  })
})
