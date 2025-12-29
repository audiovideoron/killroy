/**
 * Transcript-Driven Video Editor v1 - Data Contracts
 * Canonical timebase: integer milliseconds
 */

// ============================================================================
// TranscriptV1
// ============================================================================

export interface TranscriptToken {
  token_id: string
  text: string
  start_ms: number
  end_ms: number
  confidence: number
}

export interface TranscriptSegment {
  segment_id: string
  start_ms: number
  end_ms: number
  text: string
  token_ids: string[]
}

export interface TranscriptV1 {
  version: '1'
  video_id: string
  tokens: TranscriptToken[]
  segments: TranscriptSegment[]
}

// ============================================================================
// EdlV1
// ============================================================================

export interface TimeRange {
  start_ms: number
  end_ms: number
}

export interface RemoveRange extends TimeRange {
  range_id: string
  source: 'user' | 'heuristic' | 'ai'
  reason: 'selection' | 'filler' | 'pause'
}

export interface EdlParams {
  merge_threshold_ms: number
  pre_roll_ms: number
  post_roll_ms: number
  audio_crossfade_ms: number
}

/**
 * Word replacement for synthesis
 * When a word is replaced, the original audio is silenced and synth fills the gap
 */
export interface WordReplacement {
  replacement_id: string
  token_id: string          // Reference to original token
  original_text: string
  replacement_text: string
  start_ms: number          // Original timing preserved
  end_ms: number
}

/**
 * Word insertion for synthesis
 * New text inserted after a token - creates NEW time in the output
 */
export interface WordInsertion {
  insertion_id: string
  text: string              // The new text to synthesize
  after_token_id: string | null  // Insert after this token (null = beginning)
}

export interface EdlV1 {
  version: '1'
  video_id: string
  edl_version_id: string
  created_at: string
  params: EdlParams
  remove_ranges: RemoveRange[]
  replacements?: WordReplacement[]  // Optional for backwards compatibility
  insertions?: WordInsertion[]      // Optional - new text creating new time
}

// ============================================================================
// VideoAsset
// ============================================================================

export interface VideoAsset {
  video_id: string
  file_path: string
  duration_ms: number
  fps: number
  sample_rate: number
  width: number
  height: number
}

// ============================================================================
// Runtime Guards
// ============================================================================

export function assertIntegerMs(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got ${value}`)
  }
  if (value < 0) {
    throw new Error(`${name} must be >= 0, got ${value}`)
  }
}

export function validateTimeRange(range: TimeRange): void {
  assertIntegerMs(range.start_ms, 'start_ms')
  assertIntegerMs(range.end_ms, 'end_ms')
  if (range.end_ms < range.start_ms) {
    throw new Error(`end_ms (${range.end_ms}) must be >= start_ms (${range.start_ms})`)
  }
}

export function validateTranscriptV1(transcript: TranscriptV1): void {
  if (transcript.version !== '1') {
    throw new Error(`Invalid transcript version: ${transcript.version}`)
  }

  for (const token of transcript.tokens) {
    assertIntegerMs(token.start_ms, 'token.start_ms')
    assertIntegerMs(token.end_ms, 'token.end_ms')
    if (token.end_ms < token.start_ms) {
      throw new Error(`Token ${token.token_id}: end_ms must be >= start_ms`)
    }
  }

  for (const segment of transcript.segments) {
    assertIntegerMs(segment.start_ms, 'segment.start_ms')
    assertIntegerMs(segment.end_ms, 'segment.end_ms')
    if (segment.end_ms < segment.start_ms) {
      throw new Error(`Segment ${segment.segment_id}: end_ms must be >= start_ms`)
    }
  }
}

export function validateEdlV1(edl: EdlV1): void {
  if (edl.version !== '1') {
    throw new Error(`Invalid EDL version: ${edl.version}`)
  }

  assertIntegerMs(edl.params.merge_threshold_ms, 'params.merge_threshold_ms')
  assertIntegerMs(edl.params.pre_roll_ms, 'params.pre_roll_ms')
  assertIntegerMs(edl.params.post_roll_ms, 'params.post_roll_ms')
  assertIntegerMs(edl.params.audio_crossfade_ms, 'params.audio_crossfade_ms')

  for (const range of edl.remove_ranges) {
    validateTimeRange(range)
  }

  // Validate replacements if present
  if (edl.replacements) {
    for (const repl of edl.replacements) {
      assertIntegerMs(repl.start_ms, 'replacement.start_ms')
      assertIntegerMs(repl.end_ms, 'replacement.end_ms')
      if (repl.end_ms < repl.start_ms) {
        throw new Error(`Replacement ${repl.replacement_id}: end_ms must be >= start_ms`)
      }
    }
  }

  // Validate insertions if present
  if (edl.insertions) {
    for (const ins of edl.insertions) {
      if (!ins.insertion_id) {
        throw new Error('Insertion missing insertion_id')
      }
      if (!ins.text || ins.text.trim().length === 0) {
        throw new Error(`Insertion ${ins.insertion_id}: text must not be empty`)
      }
    }
  }
}
