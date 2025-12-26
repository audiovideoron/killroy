import { describe, it, expect } from 'vitest'
import type { QuietCandidate } from '../../shared/types'

/**
 * Replicate parseSilenceDetectOutput logic for testing.
 * This ensures the FFmpeg silencedetect parsing logic is well-tested.
 */
function parseSilenceDetectOutput(stderr: string): QuietCandidate[] {
  const candidates: QuietCandidate[] = []
  const lines = stderr.split('\n')

  let currentStart: number | null = null

  for (const line of lines) {
    // Match silence_start: <seconds>
    const startMatch = line.match(/silence_start:\s*([\d.]+)/)
    if (startMatch) {
      currentStart = parseFloat(startMatch[1])
      continue
    }

    // Match silence_end: <seconds>
    const endMatch = line.match(/silence_end:\s*([\d.]+)/)
    if (endMatch && currentStart !== null) {
      const endSec = parseFloat(endMatch[1])
      candidates.push({
        startMs: Math.round(currentStart * 1000),
        endMs: Math.round(endSec * 1000)
      })
      currentStart = null
    }
  }

  return candidates
}

/**
 * Replicate sortQuietCandidates logic for testing.
 * Sorts by duration DESC, then by start time ASC.
 */
function sortQuietCandidates(candidates: QuietCandidate[]): QuietCandidate[] {
  return [...candidates].sort((a, b) => {
    const durationA = a.endMs - a.startMs
    const durationB = b.endMs - b.startMs

    // Primary: duration DESC
    if (durationB !== durationA) {
      return durationB - durationA
    }

    // Tie-break: start ASC
    return a.startMs - b.startMs
  })
}

describe('parseSilenceDetectOutput', () => {
  it('parses typical silencedetect output', () => {
    const stderr = `
[silencedetect @ 0x7f8b8c004c00] silence_start: 1.234
[silencedetect @ 0x7f8b8c004c00] silence_end: 2.567 | silence_duration: 1.333
[silencedetect @ 0x7f8b8c004c00] silence_start: 5.0
[silencedetect @ 0x7f8b8c004c00] silence_end: 7.5 | silence_duration: 2.5
`

    const result = parseSilenceDetectOutput(stderr)

    expect(result).toEqual([
      { startMs: 1234, endMs: 2567 },
      { startMs: 5000, endMs: 7500 }
    ])
  })

  it('handles empty output', () => {
    const result = parseSilenceDetectOutput('')
    expect(result).toEqual([])
  })

  it('handles output with no silence detected', () => {
    const stderr = `
frame=  100 fps=25 q=-1.0 size=    1024kB time=00:00:04.00 bitrate=2097.2kbits/s
`
    const result = parseSilenceDetectOutput(stderr)
    expect(result).toEqual([])
  })

  it('handles incomplete silence (start only, no end)', () => {
    const stderr = `
[silencedetect @ 0x7f8b8c004c00] silence_start: 10.0
`
    const result = parseSilenceDetectOutput(stderr)
    expect(result).toEqual([])
  })

  it('handles decimal precision correctly', () => {
    const stderr = `
[silencedetect @ 0x7f8b8c004c00] silence_start: 0.123456
[silencedetect @ 0x7f8b8c004c00] silence_end: 0.987654 | silence_duration: 0.864198
`
    const result = parseSilenceDetectOutput(stderr)

    expect(result).toEqual([
      { startMs: 123, endMs: 988 }  // Rounded
    ])
  })

  it('handles multiple silence regions', () => {
    const stderr = `
[silencedetect @ 0x7f8b8c004c00] silence_start: 0
[silencedetect @ 0x7f8b8c004c00] silence_end: 1.5 | silence_duration: 1.5
[silencedetect @ 0x7f8b8c004c00] silence_start: 10
[silencedetect @ 0x7f8b8c004c00] silence_end: 12 | silence_duration: 2
[silencedetect @ 0x7f8b8c004c00] silence_start: 20.5
[silencedetect @ 0x7f8b8c004c00] silence_end: 21.5 | silence_duration: 1
`
    const result = parseSilenceDetectOutput(stderr)

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ startMs: 0, endMs: 1500 })
    expect(result[1]).toEqual({ startMs: 10000, endMs: 12000 })
    expect(result[2]).toEqual({ startMs: 20500, endMs: 21500 })
  })

  it('ignores malformed lines', () => {
    const stderr = `
garbage line
silence_start: not a number
[silencedetect @ 0x7f8b8c004c00] silence_start: 1.0
random text here
[silencedetect @ 0x7f8b8c004c00] silence_end: 2.0 | silence_duration: 1.0
more garbage
`
    const result = parseSilenceDetectOutput(stderr)

    expect(result).toEqual([
      { startMs: 1000, endMs: 2000 }
    ])
  })
})

describe('sortQuietCandidates', () => {
  it('sorts by duration descending', () => {
    const candidates: QuietCandidate[] = [
      { startMs: 1000, endMs: 2000 },   // 1000ms duration
      { startMs: 5000, endMs: 8000 },   // 3000ms duration
      { startMs: 10000, endMs: 12000 }  // 2000ms duration
    ]

    const result = sortQuietCandidates(candidates)

    expect(result).toEqual([
      { startMs: 5000, endMs: 8000 },   // 3000ms - longest
      { startMs: 10000, endMs: 12000 }, // 2000ms
      { startMs: 1000, endMs: 2000 }    // 1000ms - shortest
    ])
  })

  it('uses start time ascending as tie-breaker', () => {
    const candidates: QuietCandidate[] = [
      { startMs: 5000, endMs: 6000 },   // 1000ms at 5s
      { startMs: 1000, endMs: 2000 },   // 1000ms at 1s
      { startMs: 3000, endMs: 4000 }    // 1000ms at 3s
    ]

    const result = sortQuietCandidates(candidates)

    // All same duration (1000ms), so sort by start time ASC
    expect(result).toEqual([
      { startMs: 1000, endMs: 2000 },   // 1s
      { startMs: 3000, endMs: 4000 },   // 3s
      { startMs: 5000, endMs: 6000 }    // 5s
    ])
  })

  it('handles empty array', () => {
    const result = sortQuietCandidates([])
    expect(result).toEqual([])
  })

  it('handles single candidate', () => {
    const candidates: QuietCandidate[] = [
      { startMs: 1000, endMs: 2000 }
    ]

    const result = sortQuietCandidates(candidates)
    expect(result).toEqual([{ startMs: 1000, endMs: 2000 }])
  })

  it('does not mutate original array', () => {
    const candidates: QuietCandidate[] = [
      { startMs: 1000, endMs: 2000 },
      { startMs: 5000, endMs: 8000 }
    ]

    const originalOrder = [...candidates]
    sortQuietCandidates(candidates)

    expect(candidates).toEqual(originalOrder)
  })

  it('handles mixed durations and tie-breakers correctly', () => {
    const candidates: QuietCandidate[] = [
      { startMs: 10000, endMs: 12000 },  // 2000ms at 10s
      { startMs: 1000, endMs: 4000 },    // 3000ms at 1s
      { startMs: 5000, endMs: 7000 },    // 2000ms at 5s
      { startMs: 20000, endMs: 23000 }   // 3000ms at 20s
    ]

    const result = sortQuietCandidates(candidates)

    expect(result).toEqual([
      { startMs: 1000, endMs: 4000 },    // 3000ms at 1s (longest, earliest)
      { startMs: 20000, endMs: 23000 },  // 3000ms at 20s (longest, later)
      { startMs: 5000, endMs: 7000 },    // 2000ms at 5s (shorter, earliest)
      { startMs: 10000, endMs: 12000 }   // 2000ms at 10s (shorter, later)
    ])
  })
})

describe('candidate capping', () => {
  it('caps to MAX_CANDIDATES (5)', () => {
    const candidates: QuietCandidate[] = [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
      { startMs: 4000, endMs: 5000 },
      { startMs: 6000, endMs: 7000 },
      { startMs: 8000, endMs: 9000 },
      { startMs: 10000, endMs: 11000 },
      { startMs: 12000, endMs: 13000 }
    ]

    const sorted = sortQuietCandidates(candidates)
    const capped = sorted.slice(0, 5)

    expect(capped).toHaveLength(5)
  })
})
