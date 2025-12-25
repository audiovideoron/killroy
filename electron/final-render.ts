/**
 * Final Render - Render full edited video
 * Uses same EDL engine as preview
 */

import * as path from 'path'
import * as fs from 'fs'
import type { EdlV1, VideoAsset } from '../shared/editor-types'
import { buildEffectiveRemoveRanges, invertToKeepRanges, computeEditedDuration } from './edl-engine'
import { runFFmpeg } from './ffmpeg-runner'
import { validateMediaPath } from './path-validation'

export interface FinalRenderOptions {
  videoAsset: VideoAsset
  edl: EdlV1
  outputPath: string
}

export interface RenderReport {
  video_id: string
  edl_version_id: string
  output_path: string
  original_duration_ms: number
  edited_duration_ms: number
  segments_count: number
  render_time_ms: number
  created_at: string
}

/**
 * Render final edited video
 */
export async function renderFinal(options: FinalRenderOptions): Promise<RenderReport> {
  const { videoAsset, edl, outputPath } = options
  const startTime = Date.now()

  // Validate input video path
  const inputValidation = validateMediaPath(videoAsset.file_path)
  if (!inputValidation.ok) {
    throw new Error(`Invalid input video path: ${inputValidation.message}`)
  }

  // Validate output path is absolute
  if (!path.isAbsolute(outputPath)) {
    throw new Error(`Output path must be absolute: ${outputPath}`)
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  // Build effective remove ranges
  const effectiveRemoves = buildEffectiveRemoveRanges(edl, videoAsset.duration_ms)

  // Invert to keep ranges
  const keepRanges = invertToKeepRanges(effectiveRemoves, videoAsset.duration_ms)

  if (keepRanges.length === 0) {
    throw new Error('No content to render - all segments removed')
  }

  // Render using segment concat strategy
  const tmpDir = path.join(path.dirname(outputPath), 'final-segments')
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
  }

  const segmentPaths: string[] = []

  try {
    // Extract each segment
    for (let i = 0; i < keepRanges.length; i++) {
      const range = keepRanges[i]
      const segmentPath = path.join(tmpDir, `segment-${i}.mp4`)

      await extractSegment(videoAsset.file_path, range, segmentPath)
      segmentPaths.push(segmentPath)
    }

    // Concat segments
    await concatSegments(segmentPaths, outputPath)
  } finally {
    // Cleanup temp directory (including all segment files)
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }

  const renderTime = Date.now() - startTime
  const editedDuration = computeEditedDuration(keepRanges)

  const report: RenderReport = {
    video_id: videoAsset.video_id,
    edl_version_id: edl.edl_version_id,
    output_path: outputPath,
    original_duration_ms: videoAsset.duration_ms,
    edited_duration_ms: editedDuration,
    segments_count: keepRanges.length,
    render_time_ms: renderTime,
    created_at: new Date().toISOString()
  }

  // Write report to JSON
  const reportPath = outputPath.replace(/\.[^.]+$/, '-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))

  return report
}

/**
 * Extract a single segment
 */
async function extractSegment(
  inputPath: string,
  range: { start_ms: number; end_ms: number },
  outputPath: string
): Promise<void> {
  const start_sec = range.start_ms / 1000
  const duration_sec = (range.end_ms - range.start_ms) / 1000

  const args = [
    '-y',
    '-ss', start_sec.toString(),
    '-t', duration_sec.toString(),
    '-i', inputPath,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath
  ]

  try {
    await runFFmpeg({ args, timeoutMs: 10 * 60 * 1000 })
  } catch (error: any) {
    throw new Error(`ffmpeg segment extraction failed: ${error.message}`)
  }
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

  try {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFilePath,
      '-c', 'copy',
      outputPath
    ]

    await runFFmpeg({ args, timeoutMs: 10 * 60 * 1000 })
  } catch (error: any) {
    throw new Error(`ffmpeg concat failed: ${error.message}`)
  } finally {
    // Always cleanup concat file
    if (fs.existsSync(concatFilePath)) {
      fs.unlinkSync(concatFilePath)
    }
  }
}
