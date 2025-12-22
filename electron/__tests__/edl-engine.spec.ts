import { describe, it, expect } from 'vitest'
import {
  padRange,
  clampRange,
  mergeRanges,
  buildEffectiveRemoveRanges,
  invertToKeepRanges,
  computeEditedDuration
} from '../edl-engine'
import type { EdlV1, TimeRange } from '../../shared/editor-types'

describe('STEP 2 Gate: EDL Engine', () => {
  describe('padRange', () => {
    it('applies pre and post roll', () => {
      const range: TimeRange = { start_ms: 1000, end_ms: 2000 }
      const result = padRange(range, 50, 100)
      expect(result).toEqual({ start_ms: 950, end_ms: 2100 })
    })

    it('handles zero padding', () => {
      const range: TimeRange = { start_ms: 1000, end_ms: 2000 }
      const result = padRange(range, 0, 0)
      expect(result).toEqual({ start_ms: 1000, end_ms: 2000 })
    })

    it('can produce negative start_ms (clamping happens later)', () => {
      const range: TimeRange = { start_ms: 10, end_ms: 100 }
      const result = padRange(range, 50, 0)
      expect(result).toEqual({ start_ms: -40, end_ms: 100 })
    })
  })

  describe('clampRange', () => {
    it('clamps to [0, duration]', () => {
      const range: TimeRange = { start_ms: -100, end_ms: 5000 }
      const result = clampRange(range, 3000)
      expect(result).toEqual({ start_ms: 0, end_ms: 3000 })
    })

    it('leaves valid range unchanged', () => {
      const range: TimeRange = { start_ms: 1000, end_ms: 2000 }
      const result = clampRange(range, 3000)
      expect(result).toEqual({ start_ms: 1000, end_ms: 2000 })
    })

    it('clamps both to 0 if entirely negative', () => {
      const range: TimeRange = { start_ms: -500, end_ms: -100 }
      const result = clampRange(range, 1000)
      expect(result).toEqual({ start_ms: 0, end_ms: 0 })
    })

    it('clamps both to duration if entirely beyond', () => {
      const range: TimeRange = { start_ms: 5000, end_ms: 6000 }
      const result = clampRange(range, 3000)
      expect(result).toEqual({ start_ms: 3000, end_ms: 3000 })
    })
  })

  describe('mergeRanges', () => {
    it('merges overlapping ranges', () => {
      const ranges: TimeRange[] = [
        { start_ms: 1000, end_ms: 2000 },
        { start_ms: 1500, end_ms: 2500 }
      ]
      const result = mergeRanges(ranges, 0)
      expect(result).toEqual([{ start_ms: 1000, end_ms: 2500 }])
    })

    it('merges adjacent ranges within threshold', () => {
      const ranges: TimeRange[] = [
        { start_ms: 1000, end_ms: 2000 },
        { start_ms: 2050, end_ms: 3000 }
      ]
      const result = mergeRanges(ranges, 100)
      expect(result).toEqual([{ start_ms: 1000, end_ms: 3000 }])
    })

    it('does not merge ranges beyond threshold', () => {
      const ranges: TimeRange[] = [
        { start_ms: 1000, end_ms: 2000 },
        { start_ms: 2200, end_ms: 3000 }
      ]
      const result = mergeRanges(ranges, 100)
      expect(result).toEqual([
        { start_ms: 1000, end_ms: 2000 },
        { start_ms: 2200, end_ms: 3000 }
      ])
    })

    it('merges exactly adjacent ranges (gap = 0) when threshold = 0', () => {
      const ranges: TimeRange[] = [
        { start_ms: 1000, end_ms: 2000 },
        { start_ms: 2000, end_ms: 3000 }
      ]
      const result = mergeRanges(ranges, 0)
      expect(result).toEqual([{ start_ms: 1000, end_ms: 3000 }])
    })

    it('handles unsorted input', () => {
      const ranges: TimeRange[] = [
        { start_ms: 3000, end_ms: 4000 },
        { start_ms: 1000, end_ms: 2000 }
      ]
      const result = mergeRanges(ranges, 0)
      expect(result).toEqual([
        { start_ms: 1000, end_ms: 2000 },
        { start_ms: 3000, end_ms: 4000 }
      ])
    })

    it('handles empty array', () => {
      const result = mergeRanges([], 100)
      expect(result).toEqual([])
    })

    it('handles single range', () => {
      const ranges: TimeRange[] = [{ start_ms: 1000, end_ms: 2000 }]
      const result = mergeRanges(ranges, 100)
      expect(result).toEqual([{ start_ms: 1000, end_ms: 2000 }])
    })

    it('merges multiple overlapping ranges', () => {
      const ranges: TimeRange[] = [
        { start_ms: 1000, end_ms: 1500 },
        { start_ms: 1200, end_ms: 1800 },
        { start_ms: 1600, end_ms: 2000 }
      ]
      const result = mergeRanges(ranges, 0)
      expect(result).toEqual([{ start_ms: 1000, end_ms: 2000 }])
    })
  })

  describe('buildEffectiveRemoveRanges', () => {
    it('applies full pipeline: pad, clamp, merge', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test',
        edl_version_id: 'edl1',
        created_at: '2025-01-01',
        params: {
          merge_threshold_ms: 100,
          pre_roll_ms: 50,
          post_roll_ms: 50,
          audio_crossfade_ms: 12
        },
        remove_ranges: [
          {
            range_id: 'r1',
            start_ms: 1000,
            end_ms: 1500,
            source: 'user',
            reason: 'selection'
          },
          {
            range_id: 'r2',
            start_ms: 1600,
            end_ms: 2000,
            source: 'user',
            reason: 'selection'
          }
        ]
      }

      // Pad: r1 => [950, 1550], r2 => [1550, 2050]
      // Clamp: no change (within [0, 10000])
      // Merge: gap = 0, should merge
      const result = buildEffectiveRemoveRanges(edl, 10000)
      expect(result).toEqual([{ start_ms: 950, end_ms: 2050 }])
    })

    it('clamps negative padded ranges to 0', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test',
        edl_version_id: 'edl1',
        created_at: '2025-01-01',
        params: {
          merge_threshold_ms: 0,
          pre_roll_ms: 100,
          post_roll_ms: 50,
          audio_crossfade_ms: 12
        },
        remove_ranges: [
          {
            range_id: 'r1',
            start_ms: 50,
            end_ms: 200,
            source: 'user',
            reason: 'selection'
          }
        ]
      }

      // Pad: [50 - 100, 200 + 50] => [-50, 250]
      // Clamp: [0, 250]
      const result = buildEffectiveRemoveRanges(edl, 1000)
      expect(result).toEqual([{ start_ms: 0, end_ms: 250 }])
    })

    it('filters out empty ranges after clamping', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test',
        edl_version_id: 'edl1',
        created_at: '2025-01-01',
        params: {
          merge_threshold_ms: 0,
          pre_roll_ms: 0,
          post_roll_ms: 0,
          audio_crossfade_ms: 12
        },
        remove_ranges: [
          {
            range_id: 'r1',
            start_ms: 5000,
            end_ms: 6000,
            source: 'user',
            reason: 'selection'
          }
        ]
      }

      // Clamp to [0, 3000]: range becomes [3000, 3000] => empty
      const result = buildEffectiveRemoveRanges(edl, 3000)
      expect(result).toEqual([])
    })

    it('handles empty remove_ranges', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test',
        edl_version_id: 'edl1',
        created_at: '2025-01-01',
        params: {
          merge_threshold_ms: 80,
          pre_roll_ms: 40,
          post_roll_ms: 40,
          audio_crossfade_ms: 12
        },
        remove_ranges: []
      }

      const result = buildEffectiveRemoveRanges(edl, 10000)
      expect(result).toEqual([])
    })
  })

  describe('invertToKeepRanges', () => {
    it('inverts single remove to two keep ranges', () => {
      const removeRanges: TimeRange[] = [{ start_ms: 1000, end_ms: 2000 }]
      const result = invertToKeepRanges(removeRanges, 5000)
      expect(result).toEqual([
        { start_ms: 0, end_ms: 1000 },
        { start_ms: 2000, end_ms: 5000 }
      ])
    })

    it('returns full range when no removes', () => {
      const result = invertToKeepRanges([], 5000)
      expect(result).toEqual([{ start_ms: 0, end_ms: 5000 }])
    })

    it('removes everything when remove covers full duration', () => {
      const removeRanges: TimeRange[] = [{ start_ms: 0, end_ms: 5000 }]
      const result = invertToKeepRanges(removeRanges, 5000)
      expect(result).toEqual([])
    })

    it('handles remove at start only', () => {
      const removeRanges: TimeRange[] = [{ start_ms: 0, end_ms: 1000 }]
      const result = invertToKeepRanges(removeRanges, 5000)
      expect(result).toEqual([{ start_ms: 1000, end_ms: 5000 }])
    })

    it('handles remove at end only', () => {
      const removeRanges: TimeRange[] = [{ start_ms: 4000, end_ms: 5000 }]
      const result = invertToKeepRanges(removeRanges, 5000)
      expect(result).toEqual([{ start_ms: 0, end_ms: 4000 }])
    })

    it('handles multiple removes with gaps', () => {
      const removeRanges: TimeRange[] = [
        { start_ms: 1000, end_ms: 2000 },
        { start_ms: 3000, end_ms: 4000 }
      ]
      const result = invertToKeepRanges(removeRanges, 5000)
      expect(result).toEqual([
        { start_ms: 0, end_ms: 1000 },
        { start_ms: 2000, end_ms: 3000 },
        { start_ms: 4000, end_ms: 5000 }
      ])
    })

    it('handles adjacent removes (no gap)', () => {
      const removeRanges: TimeRange[] = [
        { start_ms: 1000, end_ms: 2000 },
        { start_ms: 2000, end_ms: 3000 }
      ]
      const result = invertToKeepRanges(removeRanges, 5000)
      expect(result).toEqual([
        { start_ms: 0, end_ms: 1000 },
        { start_ms: 3000, end_ms: 5000 }
      ])
    })

    it('handles unsorted input', () => {
      const removeRanges: TimeRange[] = [
        { start_ms: 3000, end_ms: 4000 },
        { start_ms: 1000, end_ms: 2000 }
      ]
      const result = invertToKeepRanges(removeRanges, 5000)
      expect(result).toEqual([
        { start_ms: 0, end_ms: 1000 },
        { start_ms: 2000, end_ms: 3000 },
        { start_ms: 4000, end_ms: 5000 }
      ])
    })
  })

  describe('computeEditedDuration', () => {
    it('sums keep range durations', () => {
      const keepRanges: TimeRange[] = [
        { start_ms: 0, end_ms: 1000 },
        { start_ms: 2000, end_ms: 3000 },
        { start_ms: 4000, end_ms: 5000 }
      ]
      const result = computeEditedDuration(keepRanges)
      expect(result).toBe(3000)
    })

    it('returns 0 for empty array', () => {
      const result = computeEditedDuration([])
      expect(result).toBe(0)
    })

    it('returns correct duration for single range', () => {
      const keepRanges: TimeRange[] = [{ start_ms: 1000, end_ms: 3500 }]
      const result = computeEditedDuration(keepRanges)
      expect(result).toBe(2500)
    })
  })
})
