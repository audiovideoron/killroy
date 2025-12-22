/**
 * Preview Render - Render ±N seconds around playhead
 * Uses same EDL engine as final render
 */

import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import type { EdlV1, TimeRange, VideoAsset } from '../shared/editor-types'
import { buildEffectiveRemoveRanges, invertToKeepRanges } from './edl-engine'
import { v4 as uuidv4 } from 'uuid'

export interface PreviewOptions {
  videoAsset: VideoAsset
  edl: EdlV1
  playhead_ms: number
  window_ms: number // Total window size (e.g., 10000 = 10 seconds)
  outputDir: string
}

export interface PreviewResult {
  preview_path: string
  original_playhead_ms: number
  window_start_ms: number
  window_end_ms: number
}

/**
 * Render preview window around playhead
 */
export async function renderPreview(options: PreviewOptions): Promise<PreviewResult> {
  const { videoAsset, edl, playhead_ms, window_ms, outputDir } = options

  // Ensure output dir exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // Compute preview window
  const half_window = Math.floor(window_ms / 2)
  let window_start_ms = Math.max(0, playhead_ms - half_window)
  let window_end_ms = Math.min(videoAsset.duration_ms, playhead_ms + half_window)

  // Clamp to duration
  if (window_end_ms > videoAsset.duration_ms) {
    window_end_ms = videoAsset.duration_ms
    window_start_ms = Math.max(0, window_end_ms - window_ms)
  }

  // Build effective remove ranges
  const effectiveRemoves = buildEffectiveRemoveRanges(edl, videoAsset.duration_ms)

  // Invert to keep ranges
  const keepRanges = invertToKeepRanges(effectiveRemoves, videoAsset.duration_ms)

  // Filter keep ranges to those intersecting preview window
  const windowRange: TimeRange = { start_ms: window_start_ms, end_ms: window_end_ms }
  const relevantKeepRanges = filterRangesToWindow(keepRanges, windowRange)

  // Output path
  const outputPath = path.join(outputDir, `preview-${uuidv4()}.mp4`)

  if (relevantKeepRanges.length === 0) {
    // No content in preview window
    throw new Error('No content in preview window')
  }

  // Render using segment concat strategy
  await renderSegmentConcat(
    videoAsset.file_path,
    relevantKeepRanges,
    window_start_ms,
    outputPath
  )

  return {
    preview_path: outputPath,
    original_playhead_ms: playhead_ms,
    window_start_ms,
    window_end_ms
  }
}

/**
 * Filter keep ranges to those that intersect with window
 */
function filterRangesToWindow(ranges: TimeRange[], window: TimeRange): TimeRange[] {
  return ranges
    .map((range) => {
      // Compute intersection
      const start_ms = Math.max(range.start_ms, window.start_ms)
      const end_ms = Math.min(range.end_ms, window.end_ms)

      if (end_ms <= start_ms) {
        return null // No intersection
      }

      return { start_ms, end_ms }
    })
    .filter((r): r is TimeRange => r !== null)
}

/**
 * Render using segment concat strategy (Option A)
 * Extract each keep range, then concat
 */
async function renderSegmentConcat(
  inputPath: string,
  keepRanges: TimeRange[],
  offset_ms: number,
  outputPath: string
): Promise<void> {
  const tmpDir = path.join(path.dirname(outputPath), 'segments')
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
  }

  const segmentPaths: string[] = []

  try {
    // Extract each segment
    for (let i = 0; i < keepRanges.length; i++) {
      const range = keepRanges[i]
      const segmentPath = path.join(tmpDir, `segment-${i}.mp4`)

      await extractSegment(inputPath, range, segmentPath)
      segmentPaths.push(segmentPath)
    }

    // Concat segments
    await concatSegments(segmentPaths, outputPath)
  } finally {
    // Cleanup segments
    for (const segmentPath of segmentPaths) {
      if (fs.existsSync(segmentPath)) {
        fs.unlinkSync(segmentPath)
      }
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmdirSync(tmpDir)
    }
  }
}

/**
 * Extract a single segment
 */
async function extractSegment(
  inputPath: string,
  range: TimeRange,
  outputPath: string
): Promise<void> {
  const start_sec = range.start_ms / 1000
  const duration_sec = (range.end_ms - range.start_ms) / 1000

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', start_sec.toString(),
      '-t', duration_sec.toString(),
      '-i', inputPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-c:a', 'aac',
      '-b:a', '192k',
      outputPath
    ]

    const proc = spawn('ffmpeg', args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg segment extraction failed: ${stderr}`))
      }
      resolve()
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })
  })
}

/**
 * Concat segments using concat demuxer
 */
async function concatSegments(segmentPaths: string[], outputPath: string): Promise<void> {
  if (segmentPaths.length === 1) {
    // Single segment, just copy
    fs.copyFileSync(segmentPaths[0], outputPath)
    return
  }

  // Create concat file
  const concatFilePath = path.join(path.dirname(outputPath), 'concat-list.txt')
  const concatContent = segmentPaths.map((p) => `file '${p}'`).join('\n')
  fs.writeFileSync(concatFilePath, concatContent)

  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c', 'copy',
      outputPath
    ]

    const proc = spawn('ffmpeg', args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      // Cleanup concat file
      if (fs.existsSync(concatFilePath)) {
        fs.unlinkSync(concatFilePath)
      }

      if (code !== 0) {
        return reject(new Error(`ffmpeg concat failed: ${stderr}`))
      }
      resolve()
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })
  })
}
