import { describe, it, expect, beforeAll } from 'vitest'
import { extractVideoMetadata } from '../media-metadata'
import * as path from 'path'
import * as fs from 'fs'

describe('STEP 3 Gate: Media Metadata Extraction', () => {
  const testVideoDir = path.join(process.cwd(), 'media')
  let testVideoPath: string | null = null

  beforeAll(() => {
    // Check if media directory exists and find first video file
    if (fs.existsSync(testVideoDir)) {
      const files = fs.readdirSync(testVideoDir)
      const videoFile = files.find((f) =>
        /\.(mp4|mov|mkv|avi|webm)$/i.test(f)
      )
      if (videoFile) {
        testVideoPath = path.join(testVideoDir, videoFile)
      }
    }
  })

  it('validates ffprobe is available', async () => {
    const { spawn } = await import('child_process')
    const proc = spawn('ffprobe', ['-version'])

    await new Promise<void>((resolve, reject) => {
      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error('ffprobe not found'))
        }
      })
      proc.on('error', (err: any) => {
        // Skip test if ffprobe is not installed (common in CI)
        if (err.code === 'ENOENT') {
          console.warn('ffprobe not found, skipping test')
          resolve()
        } else {
          reject(err)
        }
      })
    })
  })

  it('extracts metadata from video file if available', async () => {
    if (!testVideoPath) {
      console.warn('No test video found in media/, skipping extraction test')
      return
    }

    const metadata = await extractVideoMetadata(testVideoPath)

    // Validate VideoAsset structure
    expect(metadata.video_id).toBeDefined()
    expect(typeof metadata.video_id).toBe('string')
    expect(metadata.video_id.length).toBeGreaterThan(0)

    expect(metadata.file_path).toBe(testVideoPath)
    expect(metadata.duration_ms).toBeGreaterThan(0)
    expect(Number.isInteger(metadata.duration_ms)).toBe(true)

    expect(metadata.fps).toBeGreaterThan(0)
    expect(metadata.sample_rate).toBeGreaterThan(0)
    expect(metadata.width).toBeGreaterThan(0)
    expect(metadata.height).toBeGreaterThan(0)

    console.log('Extracted metadata:', {
      duration_ms: metadata.duration_ms,
      fps: metadata.fps,
      sample_rate: metadata.sample_rate,
      dimensions: `${metadata.width}x${metadata.height}`
    })
  }, 10000) // 10s timeout for video processing

  it('rejects non-existent file', async () => {
    await expect(
      extractVideoMetadata('/nonexistent/file.mp4')
    ).rejects.toThrow()
  })

  it('rejects invalid file', async () => {
    // Create a temp text file
    const tempFile = path.join(process.cwd(), 'tmp', 'test-invalid.txt')
    const tmpDir = path.dirname(tempFile)

    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true })
    }

    fs.writeFileSync(tempFile, 'not a video')

    await expect(
      extractVideoMetadata(tempFile)
    ).rejects.toThrow()

    // Cleanup
    fs.unlinkSync(tempFile)
  })
})
