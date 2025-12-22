import { describe, it, expect, beforeAll } from 'vitest'
import { renderPreview, type PreviewOptions } from '../preview-render'
import { extractVideoMetadata } from '../media-metadata'
import type { EdlV1 } from '../../shared/editor-types'
import * as path from 'path'
import * as fs from 'fs'

describe('STEP 6 Gate: Preview Render', () => {
  const testVideoDir = path.join(process.cwd(), 'media')
  const tmpDir = path.join(process.cwd(), 'tmp', 'preview-tests')
  let testVideoPath: string | null = null

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

  it('renders preview window without edits', async () => {
    if (!testVideoPath) {
      console.warn('No test video found, skipping preview test')
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

    const options: PreviewOptions = {
      videoAsset,
      edl,
      playhead_ms: 5000, // 5 seconds
      window_ms: 4000, // 4 second window
      outputDir: tmpDir
    }

    const result = await renderPreview(options)

    expect(result.preview_path).toBeDefined()
    expect(fs.existsSync(result.preview_path)).toBe(true)

    expect(result.original_playhead_ms).toBe(5000)
    expect(result.window_start_ms).toBe(3000) // 5000 - 2000
    expect(result.window_end_ms).toBe(7000) // 5000 + 2000

    // Check file size
    const stats = fs.statSync(result.preview_path)
    expect(stats.size).toBeGreaterThan(1000)

    console.log('Preview rendered:', result.preview_path, `(${stats.size} bytes)`)

    // Cleanup
    fs.unlinkSync(result.preview_path)
  }, 30000)

  it('renders preview with edits applied', async () => {
    if (!testVideoPath) {
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
      remove_ranges: [
        {
          range_id: 'r1',
          start_ms: 4000,
          end_ms: 5000,
          source: 'user',
          reason: 'selection'
        }
      ]
    }

    const options: PreviewOptions = {
      videoAsset,
      edl,
      playhead_ms: 5000,
      window_ms: 6000,
      outputDir: tmpDir
    }

    const result = await renderPreview(options)

    expect(result.preview_path).toBeDefined()
    expect(fs.existsSync(result.preview_path)).toBe(true)

    const stats = fs.statSync(result.preview_path)
    expect(stats.size).toBeGreaterThan(1000)

    console.log('Preview with edits rendered:', `(${stats.size} bytes)`)

    // Cleanup
    fs.unlinkSync(result.preview_path)
  }, 30000)

  it('clamps preview window to video duration', async () => {
    if (!testVideoPath) {
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

    // Playhead near end
    const options: PreviewOptions = {
      videoAsset,
      edl,
      playhead_ms: videoAsset.duration_ms - 1000,
      window_ms: 5000,
      outputDir: tmpDir
    }

    const result = await renderPreview(options)

    expect(result.window_end_ms).toBeLessThanOrEqual(videoAsset.duration_ms)
    expect(result.window_start_ms).toBeGreaterThanOrEqual(0)

    // Cleanup
    if (fs.existsSync(result.preview_path)) {
      fs.unlinkSync(result.preview_path)
    }
  }, 30000)

  it('throws when preview window has no content', async () => {
    if (!testVideoPath) {
      return
    }

    const videoAsset = await extractVideoMetadata(testVideoPath)

    // Remove entire duration
    const edl: EdlV1 = {
      version: '1',
      video_id: videoAsset.video_id,
      edl_version_id: 'edl-1',
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

    const options: PreviewOptions = {
      videoAsset,
      edl,
      playhead_ms: 5000,
      window_ms: 4000,
      outputDir: tmpDir
    }

    await expect(renderPreview(options)).rejects.toThrow('No content in preview window')
  })
})
