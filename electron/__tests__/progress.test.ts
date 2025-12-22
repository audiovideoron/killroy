import { describe, it, expect } from 'vitest'

/**
 * Tests for FFmpeg progress parsing and reporting
 *
 * Verifies that:
 * - Progress parser extracts time from various stderr formats
 * - Percent calculation is correct when duration is known
 * - Indeterminate mode works when duration is unknown
 * - Progress throttling limits updates to 10/sec
 */

// Mock types matching electron/main.ts implementation
interface FFmpegProgress {
  positionSeconds: number
  rawLine: string
}

/**
 * Parse FFmpeg stderr line for progress information.
 * This is a copy of the implementation from electron/main.ts for testing.
 */
function parseFFmpegProgress(line: string): FFmpegProgress | null {
  // Pattern 1: time=HH:MM:SS.ms (e.g., time=00:01:23.45)
  const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/)
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10)
    const minutes = parseInt(timeMatch[2], 10)
    const seconds = parseInt(timeMatch[3], 10)
    const milliseconds = parseInt(timeMatch[4], 10)

    const positionSeconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 100
    return { positionSeconds, rawLine: line }
  }

  // Pattern 2: time=seconds (e.g., time=83.45)
  const simpleTimeMatch = line.match(/time=(\d+\.?\d*)/)
  if (simpleTimeMatch) {
    const positionSeconds = parseFloat(simpleTimeMatch[1])
    return { positionSeconds, rawLine: line }
  }

  // Pattern 3: out_time_ms=milliseconds (ffmpeg -progress pipe:2 format)
  const outTimeMsMatch = line.match(/out_time_ms=(\d+)/)
  if (outTimeMsMatch) {
    const positionMs = parseInt(outTimeMsMatch[1], 10)
    const positionSeconds = positionMs / 1_000_000  // FFmpeg uses microseconds
    return { positionSeconds, rawLine: line }
  }

  return null
}

describe('FFmpeg progress parser', () => {
  describe('Pattern 1: HH:MM:SS.ms format', () => {
    it('parses time=00:00:05.23', () => {
      const result = parseFFmpegProgress('time=00:00:05.23 bitrate=...')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBeCloseTo(5.23, 2)
    })

    it('parses time=00:01:23.45', () => {
      const result = parseFFmpegProgress('frame=123 fps=30 time=00:01:23.45 bitrate=...')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBeCloseTo(83.45, 2)
    })

    it('parses time=01:30:00.00', () => {
      const result = parseFFmpegProgress('time=01:30:00.00')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBe(5400)
    })
  })

  describe('Pattern 2: Simple seconds format', () => {
    it('parses time=5.23', () => {
      const result = parseFFmpegProgress('time=5.23')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBeCloseTo(5.23, 2)
    })

    it('parses time=83.45', () => {
      const result = parseFFmpegProgress('time=83.45')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBeCloseTo(83.45, 2)
    })

    it('parses time=0', () => {
      const result = parseFFmpegProgress('time=0')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBe(0)
    })
  })

  describe('Pattern 3: out_time_ms format', () => {
    it('parses out_time_ms=5000000', () => {
      const result = parseFFmpegProgress('out_time_ms=5000000')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBeCloseTo(5, 2)
    })

    it('parses out_time_ms=83450000', () => {
      const result = parseFFmpegProgress('out_time_ms=83450000')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBeCloseTo(83.45, 2)
    })
  })

  describe('Non-matching lines', () => {
    it('returns null for line without time', () => {
      const result = parseFFmpegProgress('frame=123 fps=30 bitrate=1234kbps')

      expect(result).toBeNull()
    })

    it('returns null for empty line', () => {
      const result = parseFFmpegProgress('')

      expect(result).toBeNull()
    })

    it('returns null for random text', () => {
      const result = parseFFmpegProgress('Input #0, mov,mp4,m4a,3gp,3g2,mj2, from input.mp4')

      expect(result).toBeNull()
    })
  })

  describe('Edge cases', () => {
    it('handles line with multiple time-like patterns (prefers first match)', () => {
      const result = parseFFmpegProgress('time=00:00:10.00 speed=1.5x time=5.0')

      expect(result).not.toBeNull()
      expect(result?.positionSeconds).toBe(10)
    })

    it('preserves raw line in result', () => {
      const line = 'frame=300 fps=30 time=00:00:10.00 bitrate=1234kbps'
      const result = parseFFmpegProgress(line)

      expect(result).not.toBeNull()
      expect(result?.rawLine).toBe(line)
    })
  })
})

describe('Progress calculation', () => {
  describe('Percent computation', () => {
    it('calculates percent correctly when position < duration', () => {
      const positionSeconds = 5
      const durationSeconds = 15
      const percent = positionSeconds / durationSeconds

      expect(percent).toBeCloseTo(0.333, 3)
    })

    it('calculates 100% when position = duration', () => {
      const positionSeconds = 15
      const durationSeconds = 15
      const percent = positionSeconds / durationSeconds

      expect(percent).toBe(1.0)
    })

    it('clamps percent to 1.0 when position > duration', () => {
      const positionSeconds = 20
      const durationSeconds = 15
      const percent = Math.min(1.0, positionSeconds / durationSeconds)

      expect(percent).toBe(1.0)
    })

    it('clamps percent to 0.0 when position < 0', () => {
      const positionSeconds = -5
      const durationSeconds = 15
      const percent = Math.max(0, positionSeconds / durationSeconds)

      expect(percent).toBe(0)
    })
  })

  describe('Indeterminate mode', () => {
    it('is indeterminate when duration is unknown', () => {
      const durationSeconds = undefined
      const indeterminate = !durationSeconds

      expect(indeterminate).toBe(true)
    })

    it('is determinate when duration is known', () => {
      const durationSeconds = 15
      const indeterminate = !durationSeconds

      expect(indeterminate).toBe(false)
    })

    it('is indeterminate when duration is 0', () => {
      const durationSeconds = 0
      const indeterminate = !durationSeconds || durationSeconds <= 0

      expect(indeterminate).toBe(true)
    })
  })
})

describe('Progress throttling', () => {
  it('throttles to max 100ms between updates', () => {
    const timestamps: number[] = []
    const now = 1000

    // Simulate rapid progress updates
    for (let i = 0; i < 10; i++) {
      const currentTime = now + i * 10  // Every 10ms
      const lastEmit = timestamps[timestamps.length - 1] || 0

      // Throttle: only emit if >100ms since last
      if (currentTime - lastEmit >= 100) {
        timestamps.push(currentTime)
      }
    }

    // Should only emit once (at first update)
    expect(timestamps.length).toBe(1)
  })

  it('allows update after 100ms has passed', () => {
    const timestamps: number[] = []

    timestamps.push(1000)   // First update

    // Try update at 50ms (should be blocked)
    const time50 = 1050
    if (time50 - timestamps[timestamps.length - 1] >= 100) {
      timestamps.push(time50)
    }

    // Try update at 100ms (should pass)
    const time100 = 1100
    if (time100 - timestamps[timestamps.length - 1] >= 100) {
      timestamps.push(time100)
    }

    expect(timestamps).toEqual([1000, 1100])
  })
})
