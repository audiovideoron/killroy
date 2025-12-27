import { useState, useRef, useEffect } from 'react'
import type { JobProgressEvent } from '../../shared/types'

// Timing constants for progress UI visibility
export const MIN_VISIBLE_MS = 500   // Minimum time to show running state before terminal
export const TERMINAL_DWELL_MS = 1000  // Time to show terminal state before clearing

export interface JobProgressViewState {
  jobId: string
  phase: string
  percent: number
  indeterminate: boolean
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'
  firstRunningAt?: number  // Timestamp when status first became 'running'
  terminalAt?: number      // Timestamp when status became terminal
  clearTimerId?: number    // Timer ID for clearing terminal state
}

/**
 * Hook to manage job progress state with timing enforcement.
 *
 * Enforces:
 * - MIN_VISIBLE_MS: minimum time running state is visible before showing terminal
 * - TERMINAL_DWELL_MS: time terminal state remains visible before clearing
 *
 * @returns currentJob - The current job progress state, or null if no active job
 */
export function useJobProgress(): { currentJob: JobProgressViewState | null } {
  const jobStatesRef = useRef<Map<string, JobProgressViewState>>(new Map())
  const [currentJob, setCurrentJob] = useState<JobProgressViewState | null>(null)

  useEffect(() => {
    const cleanup = window.electronAPI.onJobProgress((event) => {
      console.log('[progress]', event)

      const jobStates = jobStatesRef.current
      const now = Date.now()
      const existingJob = jobStates.get(event.jobId)

      // Clear any existing timer for this job
      if (existingJob?.clearTimerId) {
        clearTimeout(existingJob.clearTimerId)
      }

      // Determine if this is a terminal state
      const isTerminal = ['completed', 'failed', 'cancelled', 'timed_out'].includes(event.status)

      if (event.status === 'running') {
        // Running state - update immediately
        const newState: JobProgressViewState = {
          jobId: event.jobId,
          phase: event.phase || '',
          percent: event.percent || 0,
          indeterminate: event.indeterminate || false,
          status: event.status,
          firstRunningAt: existingJob?.firstRunningAt || now
        }

        jobStates.set(event.jobId, newState)
        setCurrentJob({ ...newState })

      } else if (isTerminal) {
        // Terminal state - enforce MIN_VISIBLE_MS and TERMINAL_DWELL_MS
        const firstRunningAt = existingJob?.firstRunningAt

        const showTerminal = () => {
          const terminalState: JobProgressViewState = {
            jobId: event.jobId,
            phase: event.status === 'completed' ? '' : event.phase || '',
            percent: event.status === 'completed' ? 1.0 : (existingJob?.percent || 0),
            indeterminate: false,
            status: event.status,
            firstRunningAt,
            terminalAt: Date.now()
          }

          jobStates.set(event.jobId, terminalState)
          setCurrentJob({ ...terminalState })

          // Schedule clearing after TERMINAL_DWELL_MS
          const clearTimer = window.setTimeout(() => {
            jobStates.delete(event.jobId)
            // Only clear UI if this is still the current job
            setCurrentJob(prev => prev?.jobId === event.jobId ? null : prev)
          }, TERMINAL_DWELL_MS)

          terminalState.clearTimerId = clearTimer
          jobStates.set(event.jobId, terminalState)
        }

        // Enforce MIN_VISIBLE_MS
        if (firstRunningAt) {
          const elapsed = now - firstRunningAt
          if (elapsed < MIN_VISIBLE_MS) {
            // Delay showing terminal until MIN_VISIBLE_MS has elapsed
            const delayTimer = window.setTimeout(showTerminal, MIN_VISIBLE_MS - elapsed)

            // Store temporary timer in job state
            const delayState: JobProgressViewState = {
              ...existingJob!,
              clearTimerId: delayTimer
            }
            jobStates.set(event.jobId, delayState)
          } else {
            // Already visible long enough, show terminal immediately
            showTerminal()
          }
        } else {
          // No firstRunningAt (edge case), show terminal immediately
          showTerminal()
        }

      } else if (event.status === 'queued') {
        // Queued state - store but don't display prominently
        const queuedState: JobProgressViewState = {
          jobId: event.jobId,
          phase: event.phase || '',
          percent: 0,
          indeterminate: true,
          status: 'queued'
        }

        jobStates.set(event.jobId, queuedState)
        setCurrentJob({ ...queuedState })
      }
    })

    // Cleanup all timers on unmount
    return () => {
      cleanup()
      const jobStates = jobStatesRef.current
      jobStates.forEach(job => {
        if (job.clearTimerId) {
          clearTimeout(job.clearTimerId)
        }
      })
      jobStates.clear()
    }
  }, [])

  return { currentJob }
}
