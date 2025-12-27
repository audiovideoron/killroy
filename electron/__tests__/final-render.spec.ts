import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { renderFinal, type FinalRenderOptions } from '../final-render'
import { extractVideoMetadata } from '../media-metadata'
import type { EdlV1 } from '../../shared/editor-types'
import * as path from 'path'
import * as fs from 'fs'

describe('STEP 7 Gate: Final Render', () => {
  const testVideoDir = path.join(process.cwd(), 'media')
  const tmpDir = path.join(process.cwd(), 'tmp', 'final-tests')
  let testVideoPath: string | null = null
  const outputsToCleanup: string[] = []

  beforeAll(() => {
    // Find test video
    if (fs.existsSync(testVideoDir)) {
      const files = fs.readdirSync(testVideoDir)
      const videoFile = files.find((f) =>
        /\.(mp4|mov|mkv|avi|webm)$/i.test(f)
      )
      if (videoFile) {
        testVideoPath = path.join(testVideoDir, videoFile)
      }
    }

    // Ensure tmp dir exists
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true })
    }
  })

  afterAll(() => {
    // Cleanup rendered outputs
    for (const output of outputsToCleanup) {
      if (fs.existsSync(output)) {
        fs.unlinkSync(output)
      }
      // Also cleanup report
      const reportPath = output.replace(/\.[^.]+$/, '-report.json')
      if (fs.existsSync(reportPath)) {
        fs.unlinkSync(reportPath)
      }
    }
  })

  it('renders full video without edits', async () => {
    if (!testVideoPath) {
      console.warn('No test video found, skipping final render test')
      return
    }

    const videoAsset = await extractVideoMetadata(testVideoPath)

    const edl: EdlV1 = {
      version: '1',
      video_id: videoAsset.video_id,
      edl_version_id: 'edl-1',
      created_at: new Date().toISOString(),
      params: {
        merge_threshold_ms: 80,
        pre_roll_ms: 40,
        post_roll_ms: 40,
        audio_crossfade_ms: 12
      },
      remove_ranges: []
    }

    const outputPath = path.join(tmpDir, 'final-no-edits.mp4')
    outputsToCleanup.push(outputPath)

    const options: FinalRenderOptions = {
      videoAsset,
      edl,
      outputPath
    }

    const report = await renderFinal(options)

    expect(fs.existsSync(outputPath)).toBe(true)
    expect(report.output_path).toBe(outputPath)
    expect(report.original_duration_ms).toBe(videoAsset.duration_ms)
    expect(report.edited_duration_ms).toBe(videoAsset.duration_ms)
    expect(report.segments_count).toBe(1)
    expect(report.render_time_ms).toBeGreaterThan(0)

    // Check report file
    const reportPath = outputPath.replace(/\.[^.]+$/, '-report.json')
    expect(fs.existsSync(reportPath)).toBe(true)

    const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    expect(reportData).toEqual(report)

    console.log('Final render report:', report)
  }, 180000) // 3min timeout - FFmpeg renders take ~143s

  it('renders full video with edits', async () => {
    if (!testVideoPath) {
      return
    }

    const videoAsset = await extractVideoMetadata(testVideoPath)

    const edl: EdlV1 = {
      version: '1',
      video_id: videoAsset.video_id,
      edl_version_id: 'edl-2',
      created_at: new Date().toISOString(),
      params: {
        merge_threshold_ms: 80,
        pre_roll_ms: 40,
        post_roll_ms: 40,
        audio_crossfade_ms: 12
      },
      remove_ranges: [
        {
          range_id: 'r1',
          start_ms: 5000,
          end_ms: 8000,
          source: 'user',
          reason: 'selection'
        },
        {
          range_id: 'r2',
          start_ms: 15000,
          end_ms: 18000,
          source: 'user',
          reason: 'filler'
        }
      ]
    }

    const outputPath = path.join(tmpDir, 'final-with-edits.mp4')
    outputsToCleanup.push(outputPath)

    const options: FinalRenderOptions = {
      videoAsset,
      edl,
      outputPath
    }

    const report = await renderFinal(options)

    expect(fs.existsSync(outputPath)).toBe(true)
    expect(report.output_path).toBe(outputPath)
    expect(report.original_duration_ms).toBe(videoAsset.duration_ms)
    expect(report.edited_duration_ms).toBeLessThan(videoAsset.duration_ms)
    expect(report.segments_count).toBeGreaterThan(0)

    // Check file size
    const stats = fs.statSync(outputPath)
    expect(stats.size).toBeGreaterThan(1000)

    console.log('Final with edits report:', {
      original_duration_ms: report.original_duration_ms,
      edited_duration_ms: report.edited_duration_ms,
      segments: report.segments_count,
      render_time_ms: report.render_time_ms
    })
  }, 180000) // 3min timeout - FFmpeg renders take ~143s

  it('throws when all content is removed', async () => {
    if (!testVideoPath) {
      return
    }

    const videoAsset = await extractVideoMetadata(testVideoPath)

    // Remove entire video
    const edl: EdlV1 = {
      version: '1',
      video_id: videoAsset.video_id,
      edl_version_id: 'edl-3',
      created_at: new Date().toISOString(),
      params: {
        merge_threshold_ms: 0,
        pre_roll_ms: 0,
        post_roll_ms: 0,
        audio_crossfade_ms: 12
      },
      remove_ranges: [
        {
          range_id: 'r1',
          start_ms: 0,
          end_ms: videoAsset.duration_ms,
          source: 'user',
          reason: 'selection'
        }
      ]
    }

    const outputPath = path.join(tmpDir, 'final-empty.mp4')

    const options: FinalRenderOptions = {
      videoAsset,
      edl,
      outputPath
    }

    await expect(renderFinal(options)).rejects.toThrow('No content to render')
  })

  it('writes render report JSON', async () => {
    if (!testVideoPath) {
      return
    }

    const videoAsset = await extractVideoMetadata(testVideoPath)

    const edl: EdlV1 = {
      version: '1',
      video_id: videoAsset.video_id,
      edl_version_id: 'edl-4',
      created_at: new Date().toISOString(),
      params: {
        merge_threshold_ms: 80,
        pre_roll_ms: 40,
        post_roll_ms: 40,
        audio_crossfade_ms: 12
      },
      remove_ranges: []
    }

    const outputPath = path.join(tmpDir, 'final-report-test.mp4')
    outputsToCleanup.push(outputPath)

    await renderFinal({ videoAsset, edl, outputPath })

    const reportPath = outputPath.replace(/\.[^.]+$/, '-report.json')
    expect(fs.existsSync(reportPath)).toBe(true)

    const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'))

    expect(reportData.video_id).toBe(videoAsset.video_id)
    expect(reportData.edl_version_id).toBe('edl-4')
    expect(reportData.output_path).toBe(outputPath)
    expect(reportData.created_at).toBeDefined()
  }, 180000) // 3min timeout - FFmpeg renders take ~143s
})
