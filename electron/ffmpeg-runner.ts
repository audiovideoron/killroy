/**
 * FFmpeg Runner - Shared utility for spawning FFmpeg with job tracking
 *
 * Provides:
 * - Job registration and tracking
 * - Timeout enforcement
 * - Cancellation support
 * - Guaranteed cleanup
 */

import { spawn, ChildProcess } from 'child_process'

export interface FFmpegJob {
  id: string
  process: ChildProcess
  startTime: number
  timeoutHandle: NodeJS.Timeout | null
}

export enum FFmpegErrorType {
  SPAWN_FAILED = 'spawn_failed',
  TIMEOUT = 'timeout',
  CANCELLED = 'cancelled',
  NON_ZERO_EXIT = 'non_zero_exit'
}

export interface FFmpegError {
  type: FFmpegErrorType
  message: string
  stderr?: string
  exitCode?: number
}

export interface FFmpegResult {
  success: boolean
  stderr: string
  error?: FFmpegError
}

export interface RunFFmpegOptions {
  args: string[]
  timeoutMs?: number
  jobId?: string
}

/**
 * Global job registry
 */
const activeJobs = new Map<string, FFmpegJob>()

/**
 * Clean up a job: kill process, clear timeout, remove from registry
 */
function cleanupJob(jobId: string): void {
  const job = activeJobs.get(jobId)
  if (!job) return

  // Clear timeout
  if (job.timeoutHandle) {
    clearTimeout(job.timeoutHandle)
  }

  // Kill process if running
  if (job.process && !job.process.killed) {
    try {
      job.process.kill('SIGTERM')
    } catch (err) {
      // Ignore cleanup errors
    }
  }

  // Remove from registry
  activeJobs.delete(jobId)
}

/**
 * Cancel a running job by ID
 */
export function cancelJob(jobId: string): boolean {
  const job = activeJobs.get(jobId)
  if (!job) return false

  cleanupJob(jobId)
  return true
}

/**
 * Cleanup all active jobs (e.g., on app quit)
 */
export function cleanupAllJobs(): void {
  const jobIds = Array.from(activeJobs.keys())
  for (const jobId of jobIds) {
    cleanupJob(jobId)
  }
}

/**
 * Get number of active jobs
 */
export function getActiveJobCount(): number {
  return activeJobs.size
}

/**
 * Run FFmpeg with job tracking and timeout
 */
export function runFFmpeg(options: RunFFmpegOptions): Promise<FFmpegResult> {
  const { args, timeoutMs = 5 * 60 * 1000, jobId: providedJobId } = options

  return new Promise((resolve, reject) => {
    const jobId = providedJobId || `ffmpeg-${Date.now()}-${Math.random().toString(36).substring(7)}`

    // Spawn process
    const proc = spawn('ffmpeg', args)
    let stderr = ''
    let resolved = false

    // Single-resolution helpers
    const resolveOnce = (result: FFmpegResult) => {
      if (resolved) return
      resolved = true
      cleanupJob(jobId)
      resolve(result)
    }

    const rejectOnce = (error: FFmpegError) => {
      if (resolved) return
      resolved = true
      cleanupJob(jobId)
      reject(error)
    }

    // Set timeout
    const timeoutHandle = setTimeout(() => {
      rejectOnce({
        type: FFmpegErrorType.TIMEOUT,
        message: `FFmpeg timed out after ${timeoutMs / 1000}s`,
        stderr
      })
    }, timeoutMs)

    // Register job
    const job: FFmpegJob = {
      id: jobId,
      process: proc,
      startTime: Date.now(),
      timeoutHandle
    }
    activeJobs.set(jobId, job)

    // Capture stderr
    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    // Handle exit
    proc.on('close', (code) => {
      if (code === 0) {
        resolveOnce({ success: true, stderr })
      } else {
        rejectOnce({
          type: FFmpegErrorType.NON_ZERO_EXIT,
          message: `FFmpeg exited with code ${code}`,
          stderr,
          exitCode: code
        })
      }
    })

    // Handle spawn error
    proc.on('error', (err) => {
      rejectOnce({
        type: FFmpegErrorType.SPAWN_FAILED,
        message: `Failed to spawn ffmpeg: ${err.message}`,
        stderr
      })
    })
  })
}
