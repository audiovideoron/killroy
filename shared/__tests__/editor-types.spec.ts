import { describe, it, expect } from 'vitest'
import {
  assertIntegerMs,
  validateTimeRange,
  validateTranscriptV1,
  validateEdlV1,
  type TranscriptV1,
  type EdlV1,
  type TimeRange
} from '../editor-types'

describe('STEP 1 Gate: Data Contract Validation', () => {
  describe('assertIntegerMs', () => {
    it('accepts valid integer >= 0', () => {
      expect(() => assertIntegerMs(0, 'test')).not.toThrow()
      expect(() => assertIntegerMs(1000, 'test')).not.toThrow()
      expect(() => assertIntegerMs(999999, 'test')).not.toThrow()
    })

    it('rejects non-integer', () => {
      expect(() => assertIntegerMs(1.5, 'test')).toThrow('must be an integer')
      expect(() => assertIntegerMs(0.1, 'test')).toThrow('must be an integer')
    })

    it('rejects negative', () => {
      expect(() => assertIntegerMs(-1, 'test')).toThrow('must be >= 0')
      expect(() => assertIntegerMs(-100, 'test')).toThrow('must be >= 0')
    })
  })

  describe('validateTimeRange', () => {
    it('accepts valid range', () => {
      const range: TimeRange = { start_ms: 1000, end_ms: 2000 }
      expect(() => validateTimeRange(range)).not.toThrow()
    })

    it('accepts zero-duration range', () => {
      const range: TimeRange = { start_ms: 1000, end_ms: 1000 }
      expect(() => validateTimeRange(range)).not.toThrow()
    })

    it('rejects end_ms < start_ms', () => {
      const range: TimeRange = { start_ms: 2000, end_ms: 1000 }
      expect(() => validateTimeRange(range)).toThrow('must be >= start_ms')
    })

    it('rejects non-integer start_ms', () => {
      const range: TimeRange = { start_ms: 1.5, end_ms: 2000 }
      expect(() => validateTimeRange(range)).toThrow('must be an integer')
    })

    it('rejects non-integer end_ms', () => {
      const range: TimeRange = { start_ms: 1000, end_ms: 2.5 }
      expect(() => validateTimeRange(range)).toThrow('must be an integer')
    })

    it('rejects negative start_ms', () => {
      const range: TimeRange = { start_ms: -1, end_ms: 1000 }
      expect(() => validateTimeRange(range)).toThrow('must be >= 0')
    })
  })

  describe('validateTranscriptV1', () => {
    it('accepts valid transcript with all required fields', () => {
      const transcript: TranscriptV1 = {
        version: '1',
        video_id: 'test-uuid',
        tokens: [
          {
            token_id: 'token-1',
            text: 'hello',
            start_ms: 1000,
            end_ms: 1500,
            confidence: 0.95
          },
          {
            token_id: 'token-2',
            text: 'world',
            start_ms: 1500,
            end_ms: 2000,
            confidence: 0.98
          }
        ],
        segments: [
          {
            segment_id: 'seg-1',
            start_ms: 1000,
            end_ms: 2000,
            text: 'hello world',
            token_ids: ['token-1', 'token-2']
          }
        ]
      }
      expect(() => validateTranscriptV1(transcript)).not.toThrow()
    })

    it('accepts empty tokens and segments', () => {
      const transcript: TranscriptV1 = {
        version: '1',
        video_id: 'test-uuid',
        tokens: [],
        segments: []
      }
      expect(() => validateTranscriptV1(transcript)).not.toThrow()
    })

    it('rejects invalid version', () => {
      const transcript = {
        version: '2',
        video_id: 'test',
        tokens: [],
        segments: []
      } as any
      expect(() => validateTranscriptV1(transcript)).toThrow('Invalid transcript version')
    })

    it('rejects token with non-integer start_ms', () => {
      const transcript: TranscriptV1 = {
        version: '1',
        video_id: 'test',
        tokens: [
          {
            token_id: 't1',
            text: 'word',
            start_ms: 1.5,
            end_ms: 2000,
            confidence: 0.9
          }
        ],
        segments: []
      }
      expect(() => validateTranscriptV1(transcript)).toThrow('must be an integer')
    })

    it('rejects token with end_ms < start_ms', () => {
      const transcript: TranscriptV1 = {
        version: '1',
        video_id: 'test',
        tokens: [
          {
            token_id: 't1',
            text: 'word',
            start_ms: 2000,
            end_ms: 1000,
            confidence: 0.9
          }
        ],
        segments: []
      }
      expect(() => validateTranscriptV1(transcript)).toThrow('end_ms must be >= start_ms')
    })

    it('rejects segment with non-integer times', () => {
      const transcript: TranscriptV1 = {
        version: '1',
        video_id: 'test',
        tokens: [],
        segments: [
          {
            segment_id: 's1',
            start_ms: 1000.5,
            end_ms: 2000,
            text: 'text',
            token_ids: []
          }
        ]
      }
      expect(() => validateTranscriptV1(transcript)).toThrow('must be an integer')
    })
  })

  describe('validateEdlV1', () => {
    it('accepts valid EDL with all required fields', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test-uuid',
        edl_version_id: 'edl-uuid',
        created_at: '2025-01-01T00:00:00Z',
        params: {
          merge_threshold_ms: 80,
          pre_roll_ms: 40,
          post_roll_ms: 40,
          audio_crossfade_ms: 12
        },
        remove_ranges: [
          {
            range_id: 'range-1',
            start_ms: 1000,
            end_ms: 1500,
            source: 'user',
            reason: 'selection'
          },
          {
            range_id: 'range-2',
            start_ms: 2000,
            end_ms: 2500,
            source: 'heuristic',
            reason: 'filler'
          }
        ]
      }
      expect(() => validateEdlV1(edl)).not.toThrow()
    })

    it('accepts empty remove_ranges', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test',
        edl_version_id: 'edl',
        created_at: '2025-01-01T00:00:00Z',
        params: {
          merge_threshold_ms: 80,
          pre_roll_ms: 40,
          post_roll_ms: 40,
          audio_crossfade_ms: 12
        },
        remove_ranges: []
      }
      expect(() => validateEdlV1(edl)).not.toThrow()
    })

    it('rejects invalid version', () => {
      const edl = {
        version: '2',
        video_id: 'test',
        edl_version_id: 'edl',
        created_at: '2025-01-01',
        params: {
          merge_threshold_ms: 80,
          pre_roll_ms: 40,
          post_roll_ms: 40,
          audio_crossfade_ms: 12
        },
        remove_ranges: []
      } as any
      expect(() => validateEdlV1(edl)).toThrow('Invalid EDL version')
    })

    it('rejects non-integer merge_threshold_ms', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test',
        edl_version_id: 'edl',
        created_at: '2025-01-01',
        params: {
          merge_threshold_ms: 80.5,
          pre_roll_ms: 40,
          post_roll_ms: 40,
          audio_crossfade_ms: 12
        },
        remove_ranges: []
      }
      expect(() => validateEdlV1(edl)).toThrow('must be an integer')
    })

    it('rejects non-integer pre_roll_ms', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test',
        edl_version_id: 'edl',
        created_at: '2025-01-01',
        params: {
          merge_threshold_ms: 80,
          pre_roll_ms: 40.5,
          post_roll_ms: 40,
          audio_crossfade_ms: 12
        },
        remove_ranges: []
      }
      expect(() => validateEdlV1(edl)).toThrow('must be an integer')
    })

    it('rejects invalid remove_range times', () => {
      const edl: EdlV1 = {
        version: '1',
        video_id: 'test',
        edl_version_id: 'edl',
        created_at: '2025-01-01',
        params: {
          merge_threshold_ms: 80,
          pre_roll_ms: 40,
          post_roll_ms: 40,
          audio_crossfade_ms: 12
        },
        remove_ranges: [
          {
            range_id: 'r1',
            start_ms: 2000,
            end_ms: 1000,
            source: 'user',
            reason: 'selection'
          }
        ]
      }
      expect(() => validateEdlV1(edl)).toThrow('must be >= start_ms')
    })
  })
})
