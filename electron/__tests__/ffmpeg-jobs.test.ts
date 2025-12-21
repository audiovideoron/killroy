import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { ChildProcess } from 'child_process'

/**
 * Tests for FFmpeg job lifecycle management
 *
 * Verifies that the job registry properly tracks FFmpeg processes,
 * enforces timeouts, and cleans up resources on all exit paths.
 *
 * These tests use mocked child_process to avoid spawning real FFmpeg.
 */

// Mock types matching electron/main.ts implementation
enum FFmpegErrorType {
  SPAWN_FAILED = 'spawn_failed',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled',
  NON_ZERO_EXIT = 'non_zero_exit'
}

interface FFmpegError {
  type: FFmpegErrorType
  message: string
  stderr?: string
  exitCode?: number
}

interface FFmpegResult {
  success: boolean
  stderr: string
  error?: FFmpegError
}

interface FFmpegJob {
  id: string
  process: ChildProcess
  startTime: number
  timeoutHandle: NodeJS.Timeout | null
}

// Mock implementation for testing (extracted from electron/main.ts logic)
class FFmpegJobRegistry {
  private jobs = new Map<string, FFmpegJob>()

  register(job: FFmpegJob): void {
    this.jobs.set(job.id, job)
  }

  get(jobId: string): FFmpegJob | undefined {
    return this.jobs.get(jobId)
  }

  delete(jobId: string): void {
    this.jobs.delete(jobId)
  }

  size(): number {
    return this.jobs.size
  }

  clear(): void {
    const jobIds = Array.from(this.jobs.keys())
    for (const jobId of jobIds) {
      this.cleanup(jobId)
    }
  }

  cleanup(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return

    if (job.timeoutHandle) {
      clearTimeout(job.timeoutHandle)
    }

    if (job.process && !job.process.killed) {
      try {
        job.process.kill('SIGTERM')
      } catch (err) {
        // Ignore errors during cleanup
      }
    }

    this.jobs.delete(jobId)
  }
}

// Mock ChildProcess
class MockChildProcess extends EventEmitter {
  killed = false
  stderr = new EventEmitter()

  kill(signal?: string): boolean {
    this.killed = true
    this.emit('close', signal === 'SIGKILL' ? 137 : 143)
    return true
  }
}

describe('FFmpeg job registry', () => {
  let registry: FFmpegJobRegistry
  let mockProcess: MockChildProcess

  beforeEach(() => {
    registry = new FFmpegJobRegistry()
    mockProcess = new MockChildProcess()
  })

  afterEach(() => {
    registry.clear()
  })

  describe('Job registration', () => {
    it('registers a job when created', () => {
      const job: FFmpegJob = {
        id: 'test-job-1',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job)

      expect(registry.size()).toBe(1)
      expect(registry.get('test-job-1')).toBe(job)
    })

    it('tracks multiple jobs independently', () => {
      const job1: FFmpegJob = {
        id: 'job-1',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      const job2: FFmpegJob = {
        id: 'job-2',
        process: new MockChildProcess() as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job1)
      registry.register(job2)

      expect(registry.size()).toBe(2)
      expect(registry.get('job-1')).toBe(job1)
      expect(registry.get('job-2')).toBe(job2)
    })
  })

  describe('Job cleanup', () => {
    it('removes job from registry on cleanup', () => {
      const job: FFmpegJob = {
        id: 'cleanup-test',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job)
      expect(registry.size()).toBe(1)

      registry.cleanup('cleanup-test')

      expect(registry.size()).toBe(0)
      expect(registry.get('cleanup-test')).toBeUndefined()
    })

    it('kills the process during cleanup', () => {
      const job: FFmpegJob = {
        id: 'kill-test',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job)
      registry.cleanup('kill-test')

      expect(mockProcess.killed).toBe(true)
    })

    it('clears timeout handle during cleanup', () => {
      const timeoutHandle = setTimeout(() => {}, 10000)
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')

      const job: FFmpegJob = {
        id: 'timeout-test',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle
      }

      registry.register(job)
      registry.cleanup('timeout-test')

      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle)
      clearTimeoutSpy.mockRestore()
    })

    it('handles cleanup of non-existent job gracefully', () => {
      expect(() => {
        registry.cleanup('non-existent')
      }).not.toThrow()

      expect(registry.size()).toBe(0)
    })

    it('handles cleanup of already-killed process', () => {
      const job: FFmpegJob = {
        id: 'already-killed',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      mockProcess.killed = true
      registry.register(job)

      expect(() => {
        registry.cleanup('already-killed')
      }).not.toThrow()

      expect(registry.size()).toBe(0)
    })
  })

  describe('Registry clear (app quit)', () => {
    it('clears all jobs on registry clear', () => {
      const job1: FFmpegJob = {
        id: 'job-1',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      const mockProcess2 = new MockChildProcess()
      const job2: FFmpegJob = {
        id: 'job-2',
        process: mockProcess2 as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job1)
      registry.register(job2)

      expect(registry.size()).toBe(2)

      registry.clear()

      expect(registry.size()).toBe(0)
      expect(mockProcess.killed).toBe(true)
      expect(mockProcess2.killed).toBe(true)
    })

    it('is idempotent when called multiple times', () => {
      const job: FFmpegJob = {
        id: 'idempotent-test',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job)
      registry.clear()

      expect(() => {
        registry.clear()
      }).not.toThrow()

      expect(registry.size()).toBe(0)
    })
  })

  describe('Process lifecycle', () => {
    it('job remains in registry while process is running', () => {
      const job: FFmpegJob = {
        id: 'running-job',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job)

      // Process emits data (simulating running FFmpeg)
      mockProcess.stderr.emit('data', Buffer.from('FFmpeg output'))

      expect(registry.size()).toBe(1)
      expect(registry.get('running-job')).toBe(job)
    })

    it('simulates timeout scenario', () => {
      let timedOut = false
      const timeoutHandle = setTimeout(() => {
        timedOut = true
        registry.cleanup('timeout-job')
      }, 50)

      const job: FFmpegJob = {
        id: 'timeout-job',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle
      }

      registry.register(job)

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(timedOut).toBe(true)
          expect(registry.size()).toBe(0)
          expect(mockProcess.killed).toBe(true)
          resolve()
        }, 100)
      })
    })

    it('simulates successful completion', () => {
      const job: FFmpegJob = {
        id: 'success-job',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job)

      // Simulate successful exit
      mockProcess.emit('close', 0)

      // In real implementation, cleanup happens in promise resolution
      registry.cleanup('success-job')

      expect(registry.size()).toBe(0)
    })

    it('simulates error exit', () => {
      const job: FFmpegJob = {
        id: 'error-job',
        process: mockProcess as unknown as ChildProcess,
        startTime: Date.now(),
        timeoutHandle: null
      }

      registry.register(job)

      // Simulate error exit
      mockProcess.emit('close', 1)

      // In real implementation, cleanup happens in promise rejection
      registry.cleanup('error-job')

      expect(registry.size()).toBe(0)
    })
  })
})
