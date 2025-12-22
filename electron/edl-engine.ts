/**
 * EDL Engine - Pure range manipulation logic
 * No side effects, no FFmpeg
 */

import type { EdlV1, TimeRange } from '../shared/editor-types'

/**
 * Apply pre/post padding to a time range
 */
export function padRange(
  range: TimeRange,
  pre_roll_ms: number,
  post_roll_ms: number
): TimeRange {
  return {
    start_ms: range.start_ms - pre_roll_ms,
    end_ms: range.end_ms + post_roll_ms
  }
}

/**
 * Clamp a time range to [0, duration_ms]
 */
export function clampRange(range: TimeRange, duration_ms: number): TimeRange {
  return {
    start_ms: Math.max(0, Math.min(range.start_ms, duration_ms)),
    end_ms: Math.max(0, Math.min(range.end_ms, duration_ms))
  }
}

/**
 * Merge overlapping or near-adjacent ranges
 * Ranges are merged if gap <= merge_threshold_ms
 * Input ranges must be sorted by start_ms
 */
export function mergeRanges(ranges: TimeRange[], merge_threshold_ms: number): TimeRange[] {
  if (ranges.length === 0) return []

  const sorted = [...ranges].sort((a, b) => a.start_ms - b.start_ms)
  const merged: TimeRange[] = []
  let current = { ...sorted[0] }

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]
    const gap = next.start_ms - current.end_ms

    if (gap <= merge_threshold_ms) {
      // Merge: extend current range to include next
      current.end_ms = Math.max(current.end_ms, next.end_ms)
    } else {
      // No merge: save current and start new
      merged.push(current)
      current = { ...next }
    }
  }

  merged.push(current)
  return merged
}

/**
 * Build effective remove ranges from EDL:
 * 1. Apply padding
 * 2. Clamp to [0, duration]
 * 3. Merge overlapping/adjacent ranges
 * 4. Filter out empty ranges
 */
export function buildEffectiveRemoveRanges(edl: EdlV1, duration_ms: number): TimeRange[] {
  const { pre_roll_ms, post_roll_ms, merge_threshold_ms } = edl.params

  // Step 1: Pad
  const padded = edl.remove_ranges.map((r) => padRange(r, pre_roll_ms, post_roll_ms))

  // Step 2: Clamp
  const clamped = padded.map((r) => clampRange(r, duration_ms))

  // Step 3: Merge
  const merged = mergeRanges(clamped, merge_threshold_ms)

  // Step 4: Filter empty
  return merged.filter((r) => r.end_ms > r.start_ms)
}

/**
 * Invert remove ranges to keep ranges
 * Returns segments that should be kept
 */
export function invertToKeepRanges(removeRanges: TimeRange[], duration_ms: number): TimeRange[] {
  if (removeRanges.length === 0) {
    return [{ start_ms: 0, end_ms: duration_ms }]
  }

  const sorted = [...removeRanges].sort((a, b) => a.start_ms - b.start_ms)
  const keepRanges: TimeRange[] = []

  // Before first remove
  if (sorted[0].start_ms > 0) {
    keepRanges.push({ start_ms: 0, end_ms: sorted[0].start_ms })
  }

  // Between removes
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]
    const next = sorted[i + 1]
    const gap_start = current.end_ms
    const gap_end = next.start_ms

    if (gap_end > gap_start) {
      keepRanges.push({ start_ms: gap_start, end_ms: gap_end })
    }
  }

  // After last remove
  const last = sorted[sorted.length - 1]
  if (last.end_ms < duration_ms) {
    keepRanges.push({ start_ms: last.end_ms, end_ms: duration_ms })
  }

  return keepRanges
}

/**
 * Compute total edited duration from keep ranges
 */
export function computeEditedDuration(keepRanges: TimeRange[]): number {
  return keepRanges.reduce((sum, r) => sum + (r.end_ms - r.start_ms), 0)
}
