import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { extractAudioForASR, cleanupAudioFile } from '../audio-extraction'
import { getTranscriber } from '../asr-adapter'
import { validateTranscriptV1 } from '../../shared/editor-types'
import * as path from 'path'
import * as fs from 'fs'

describe('STEP 4 Gate: Audio Extraction + ASR', () => {
  const testVideoDir = path.join(process.cwd(), 'media')
  const tmpDir = path.join(process.cwd(), 'tmp')
  let testVideoPath: string | null = null
  let extractedAudioPath: string | null = null

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
  })

  afterAll(() => {
    // Cleanup extracted audio
    if (extractedAudioPath) {
      cleanupAudioFile(extractedAudioPath)
    }
  })

  describe('extractAudioForASR', () => {
    it('extracts mono WAV from video file if available', async () => {
      if (!testVideoPath) {
        console.warn('No test video found, skipping extraction test')
        return
      }

      extractedAudioPath = await extractAudioForASR(testVideoPath, tmpDir)

      expect(fs.existsSync(extractedAudioPath)).toBe(true)
      expect(extractedAudioPath.endsWith('.wav')).toBe(true)

      // Check file size is reasonable (not empty)
      const stats = fs.statSync(extractedAudioPath)
      expect(stats.size).toBeGreaterThan(1000)

      console.log('Extracted audio:', extractedAudioPath, `(${stats.size} bytes)`)
    }, 15000)

    it('creates output directory if it does not exist', async () => {
      if (!testVideoPath) {
        return
      }

      const customDir = path.join(tmpDir, 'custom-output')
      if (fs.existsSync(customDir)) {
        fs.rmSync(customDir, { recursive: true })
      }

      const audioPath = await extractAudioForASR(testVideoPath, customDir)

      expect(fs.existsSync(customDir)).toBe(true)
      expect(fs.existsSync(audioPath)).toBe(true)

      // Cleanup
      cleanupAudioFile(audioPath)
      fs.rmdirSync(customDir)
    }, 15000)

    it('rejects non-existent video file', async () => {
      await expect(
        extractAudioForASR('/nonexistent/video.mp4', tmpDir)
      ).rejects.toThrow()
    })
  })

  describe('ASR Adapter', () => {
    // Force mock mode for these tests - they should not depend on real ASR binaries
    let originalAsrBackend: string | undefined

    beforeEach(() => {
      originalAsrBackend = process.env.ASR_BACKEND
      process.env.ASR_BACKEND = 'mock'
    })

    afterEach(() => {
      if (originalAsrBackend !== undefined) {
        process.env.ASR_BACKEND = originalAsrBackend
      } else {
        delete process.env.ASR_BACKEND
      }
    })

    it('transcriber returns valid TranscriptV1', async () => {
      // Verify we're in mock mode
      expect(process.env.ASR_BACKEND).toBe('mock')

      const transcriber = getTranscriber()
      const videoId = 'test-video-id'
      const audioPath = '/mock/audio.wav' // Mock doesn't actually use path

      const transcript = await transcriber.transcribe(audioPath, videoId)

      // Validate structure
      expect(() => validateTranscriptV1(transcript)).not.toThrow()

      expect(transcript.version).toBe('1')
      expect(transcript.video_id).toBe(videoId)
      expect(transcript.tokens.length).toBeGreaterThan(0)
      expect(transcript.segments.length).toBeGreaterThan(0)

      // Verify token times are ascending
      for (let i = 1; i < transcript.tokens.length; i++) {
        const prev = transcript.tokens[i - 1]
        const curr = transcript.tokens[i]
        expect(curr.start_ms).toBeGreaterThanOrEqual(prev.end_ms)
      }

      // Verify segments contain valid token_ids
      for (const segment of transcript.segments) {
        expect(segment.token_ids.length).toBeGreaterThan(0)
        for (const tokenId of segment.token_ids) {
          const token = transcript.tokens.find((t) => t.token_id === tokenId)
          expect(token).toBeDefined()
        }
      }

      console.log('Transcript stats:', {
        tokens: transcript.tokens.length,
        segments: transcript.segments.length,
        duration_ms: transcript.tokens[transcript.tokens.length - 1]?.end_ms || 0
      })
    })

    it('generates integer millisecond timestamps', async () => {
      const transcriber = getTranscriber()
      const transcript = await transcriber.transcribe('/mock/audio.wav', 'test-id')

      for (const token of transcript.tokens) {
        expect(Number.isInteger(token.start_ms)).toBe(true)
        expect(Number.isInteger(token.end_ms)).toBe(true)
      }

      for (const segment of transcript.segments) {
        expect(Number.isInteger(segment.start_ms)).toBe(true)
        expect(Number.isInteger(segment.end_ms)).toBe(true)
      }
    })
  })

  describe('cleanupAudioFile', () => {
    it('removes audio file if it exists', () => {
      const testFile = path.join(tmpDir, 'test-cleanup.wav')
      fs.writeFileSync(testFile, 'test data')

      expect(fs.existsSync(testFile)).toBe(true)

      cleanupAudioFile(testFile)

      expect(fs.existsSync(testFile)).toBe(false)
    })

    it('does not throw if file does not exist', () => {
      expect(() => {
        cleanupAudioFile('/nonexistent/file.wav')
      }).not.toThrow()
    })
  })
})
