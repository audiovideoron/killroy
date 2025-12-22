import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for render strategy failure handling
 *
 * Verifies that tryRenderStrategies properly handles:
 * - COPY succeeds (fast path)
 * - COPY fails, REENCODE succeeds (fallback path)
 * - Both COPY and REENCODE fail (comprehensive error)
 * - TIMEOUT/CANCELLED/SPAWN_FAILED propagate immediately (no retry)
 */

//Mock types matching electron/main.ts implementation
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

type RenderAttemptType = 'COPY' | 'REENCODE' | 'LAST_RESORT'

interface RenderAttempt {
  name: RenderAttemptType
  args: string[]
}

interface RenderAttemptFailure {
  attempt: RenderAttemptType
  error: FFmpegError
  stderrTail?: string
}

// Mock runFFmpeg for testing
let mockRunFFmpeg: (args: string[]) => Promise<FFmpegResult>

function getStderrTail(stderr: string, lines: number = 20): string {
  const allLines = stderr.split('\n')
  return allLines.slice(-lines).join('\n')
}

function diagnoseFFmpegFailure(stderr: string): string | null {
  const stderrLower = stderr.toLowerCase()

  if (stderrLower.includes('unknown encoder') || stderrLower.includes('encoder not found')) {
    return 'Missing video codec. FFmpeg may not be built with required encoders.'
  }
  if (stderrLower.includes('invalid data found') || stderrLower.includes('moov atom not found')) {
    return 'File may be corrupt or incomplete.'
  }
  if (stderrLower.includes('permission denied')) {
    return 'Permission denied. Check file/directory permissions.'
  }

  return null
}

async function tryRenderStrategies(
  attempts: RenderAttempt[],
  context: string
): Promise<FFmpegResult> {
  const failures: RenderAttemptFailure[] = []

  for (const attempt of attempts) {
    try {
      const result = await mockRunFFmpeg(attempt.args)
      return result
    } catch (error: any) {
      // Only retry on NON_ZERO_EXIT (codec/encoding failures)
      if (error.type !== FFmpegErrorType.NON_ZERO_EXIT) {
        throw error
      }

      failures.push({
        attempt: attempt.name,
        error: error as FFmpegError,
        stderrTail: error.stderr ? getStderrTail(error.stderr) : undefined
      })

      if (attempt === attempts[attempts.length - 1]) {
        const diagnosis = error.stderr ? diagnoseFFmpegFailure(error.stderr) : null
        const failureList = failures.map(f => `${f.attempt}: ${f.error.message}`).join('; ')

        throw {
          type: FFmpegErrorType.NON_ZERO_EXIT,
          message: diagnosis
            ? `All render attempts failed. ${diagnosis}\nAttempts: ${failureList}`
            : `All render attempts failed: ${failureList}`,
          stderr: error.stderr,
          exitCode: error.exitCode,
          attempts: failures
        }
      }
    }
  }

  throw new Error('No render attempts provided')
}

describe('Render strategy failure handling', () => {
  beforeEach(() => {
    mockRunFFmpeg = vi.fn()
  })

  const createAttempts = (): RenderAttempt[] => [
    {
      name: 'COPY',
      args: ['-c:v', 'copy', '-c:a', 'aac', 'output.mp4']
    },
    {
      name: 'REENCODE',
      args: ['-c:v', 'libx264', '-preset', 'fast', '-c:a', 'aac', 'output.mp4']
    }
  ]

  describe('Success paths', () => {
    it('succeeds on first attempt (COPY)', async () => {
      mockRunFFmpeg = vi.fn().mockResolvedValue({
        success: true,
        stderr: ''
      })

      const attempts = createAttempts()
      const result = await tryRenderStrategies(attempts, 'test')

      expect(result.success).toBe(true)
      expect(mockRunFFmpeg).toHaveBeenCalledTimes(1)
      expect(mockRunFFmpeg).toHaveBeenCalledWith(attempts[0].args)
    })

    it('falls back to REENCODE when COPY fails', async () => {
      let callCount = 0
      mockRunFFmpeg = vi.fn().mockImplementation(async (args) => {
        callCount++
        if (callCount === 1) {
          // First attempt (COPY) fails
          throw {
            type: FFmpegErrorType.NON_ZERO_EXIT,
            message: 'FFmpeg exited with code 1',
            stderr: 'Error: codec not supported for copying',
            exitCode: 1
          }
        } else {
          // Second attempt (REENCODE) succeeds
          return { success: true, stderr: '' }
        }
      })

      const attempts = createAttempts()
      const result = await tryRenderStrategies(attempts, 'test')

      expect(result.success).toBe(true)
      expect(mockRunFFmpeg).toHaveBeenCalledTimes(2)
      expect(mockRunFFmpeg).toHaveBeenCalledWith(attempts[0].args)
      expect(mockRunFFmpeg).toHaveBeenCalledWith(attempts[1].args)
    })
  })

  describe('Comprehensive failure', () => {
    it('throws comprehensive error when both COPY and REENCODE fail', async () => {
      mockRunFFmpeg = vi.fn().mockRejectedValue({
        type: FFmpegErrorType.NON_ZERO_EXIT,
        message: 'FFmpeg exited with code 1',
        stderr: 'Error: unknown encoder libx264',
        exitCode: 1
      })

      const attempts = createAttempts()

      try {
        await tryRenderStrategies(attempts, 'test')
        throw new Error('Should have thrown error')
      } catch (err: any) {
        expect(err.type).toBe(FFmpegErrorType.NON_ZERO_EXIT)
        expect(err.message).toContain('All render attempts failed')
        expect(err.message).toContain('Missing video codec')
        expect(err.attempts).toEqual(expect.arrayContaining([
          expect.objectContaining({ attempt: 'COPY' }),
          expect.objectContaining({ attempt: 'REENCODE' })
        ]))
      }

      expect(mockRunFFmpeg).toHaveBeenCalledTimes(2)
    })

    it('includes failure details from both attempts', async () => {
      let callCount = 0
      mockRunFFmpeg = vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) {
          throw {
            type: FFmpegErrorType.NON_ZERO_EXIT,
            message: 'Copy failed: codec not supported',
            stderr: 'Error during copy',
            exitCode: 1
          }
        } else {
          throw {
            type: FFmpegErrorType.NON_ZERO_EXIT,
            message: 'Re-encode failed: encoder not found',
            stderr: 'Error: unknown encoder libx264',
            exitCode: 1
          }
        }
      })

      const attempts = createAttempts()

      try {
        await tryRenderStrategies(attempts, 'test')
        throw new Error('Should have thrown')
      } catch (error: any) {
        expect(error.attempts).toHaveLength(2)
        expect(error.attempts[0].attempt).toBe('COPY')
        expect(error.attempts[0].error.message).toContain('Copy failed')
        expect(error.attempts[1].attempt).toBe('REENCODE')
        expect(error.attempts[1].error.message).toContain('Re-encode failed')
        expect(error.message).toContain('COPY: Copy failed')
        expect(error.message).toContain('REENCODE: Re-encode failed')
      }
    })

    it('provides user-actionable diagnosis for common failures', async () => {
      mockRunFFmpeg = vi.fn().mockRejectedValue({
        type: FFmpegErrorType.NON_ZERO_EXIT,
        message: 'FFmpeg exited with code 1',
        stderr: 'Error: permission denied when writing output file',
        exitCode: 1
      })

      const attempts = createAttempts()

      await expect(
        tryRenderStrategies(attempts, 'test')
      ).rejects.toMatchObject({
        message: expect.stringContaining('Permission denied')
      })
    })
  })

  describe('Non-retryable errors', () => {
    it('propagates TIMEOUT immediately without retry', async () => {
      mockRunFFmpeg = vi.fn().mockRejectedValue({
        type: FFmpegErrorType.TIMEOUT,
        message: 'FFmpeg operation timed out after 300s',
        stderr: ''
      })

      const attempts = createAttempts()

      await expect(
        tryRenderStrategies(attempts, 'test')
      ).rejects.toMatchObject({
        type: FFmpegErrorType.TIMEOUT,
        message: expect.stringContaining('timed out')
      })

      // Should NOT retry on timeout
      expect(mockRunFFmpeg).toHaveBeenCalledTimes(1)
    })

    it('propagates CANCELLED immediately without retry', async () => {
      mockRunFFmpeg = vi.fn().mockRejectedValue({
        type: FFmpegErrorType.CANCELLED,
        message: 'Render operation was cancelled',
        stderr: ''
      })

      const attempts = createAttempts()

      await expect(
        tryRenderStrategies(attempts, 'test')
      ).rejects.toMatchObject({
        type: FFmpegErrorType.CANCELLED,
        message: expect.stringContaining('cancelled')
      })

      expect(mockRunFFmpeg).toHaveBeenCalledTimes(1)
    })

    it('propagates SPAWN_FAILED immediately without retry', async () => {
      mockRunFFmpeg = vi.fn().mockRejectedValue({
        type: FFmpegErrorType.SPAWN_FAILED,
        message: 'Failed to start FFmpeg: command not found',
        stderr: ''
      })

      const attempts = createAttempts()

      await expect(
        tryRenderStrategies(attempts, 'test')
      ).rejects.toMatchObject({
        type: FFmpegErrorType.SPAWN_FAILED,
        message: expect.stringContaining('Failed to start')
      })

      expect(mockRunFFmpeg).toHaveBeenCalledTimes(1)
    })
  })

  describe('Error diagnosis', () => {
    it('diagnoses corrupt file errors', async () => {
      mockRunFFmpeg = vi.fn().mockRejectedValue({
        type: FFmpegErrorType.NON_ZERO_EXIT,
        message: 'FFmpeg exited with code 1',
        stderr: 'Error: moov atom not found in input file',
        exitCode: 1
      })

      const attempts = createAttempts()

      await expect(
        tryRenderStrategies(attempts, 'test')
      ).rejects.toMatchObject({
        message: expect.stringContaining('corrupt or incomplete')
      })
    })

    it('diagnoses missing codec errors', async () => {
      mockRunFFmpeg = vi.fn().mockRejectedValue({
        type: FFmpegErrorType.NON_ZERO_EXIT,
        message: 'FFmpeg exited with code 1',
        stderr: 'Error: unknown encoder libx264',
        exitCode: 1
      })

      const attempts = createAttempts()

      try {
        await tryRenderStrategies(attempts, 'test')
        throw new Error('Should have thrown')
      } catch (error: any) {
        expect(error.message).toContain('Missing video codec')
        expect(error.message).toContain('All render attempts failed')
      }
    })
  })
})
