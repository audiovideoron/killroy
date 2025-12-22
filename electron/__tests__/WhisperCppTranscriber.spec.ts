import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ProcessResult } from '../asr/runProcess'

// Mock runProcess before importing WhisperCppTranscriber
vi.mock('../asr/runProcess', () => ({
  runProcess: vi.fn()
}))

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    rmdirSync: vi.fn()
  }
})

import { WhisperCppTranscriber } from '../asr/WhisperCppTranscriber'
import { runProcess } from '../asr/runProcess'
import * as fs from 'fs'

describe('WhisperCppTranscriber', () => {
  const mockConfig = {
    binPath: '/usr/local/bin/whisper',
    modelPath: '/models/ggml-base.bin',
    threads: 4,
    language: 'en'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: files exist
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws when binary does not exist', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return path !== mockConfig.binPath
    })

    const transcriber = new WhisperCppTranscriber(mockConfig)

    await expect(transcriber.transcribe('/test/audio.wav', 'video-123')).rejects.toThrow(
      'Whisper binary not found'
    )
  })

  it('throws when model does not exist', async () => {
    vi.mocked(fs.existsSync).mockImplementation((path) => {
      return path !== mockConfig.modelPath
    })

    const transcriber = new WhisperCppTranscriber(mockConfig)

    await expect(transcriber.transcribe('/test/audio.wav', 'video-123')).rejects.toThrow(
      'Whisper model not found'
    )
  })

  it('parses word-level timestamps from whisper output', async () => {
    const mockWhisperOutput = {
      text: 'Hello world test',
      words: [
        { word: 'Hello', t0: 0, t1: 50, p: 0.95 },
        { word: 'world', t0: 50, t1: 100, p: 0.98 },
        { word: 'test', t0: 100, t1: 150, p: 0.92 }
      ]
    }

    vi.mocked(runProcess).mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: ''
    } as ProcessResult)

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockWhisperOutput))

    const transcriber = new WhisperCppTranscriber(mockConfig)
    const result = await transcriber.transcribe('/test/audio.wav', 'video-123')

    expect(result.version).toBe('1')
    expect(result.video_id).toBe('video-123')
    expect(result.tokens).toHaveLength(3)
    expect(result.tokens[0]).toMatchObject({
      text: 'Hello',
      start_ms: 0,
      end_ms: 500,
      confidence: 0.95
    })
    expect(result.tokens[1]).toMatchObject({
      text: 'world',
      start_ms: 500,
      end_ms: 1000,
      confidence: 0.98
    })
    expect(result.segments).toBeDefined()
    expect(result.segments.length).toBeGreaterThan(0)
  })

  it('falls back to segment-level timing when word timestamps unavailable', async () => {
    const mockWhisperOutput = {
      text: 'Hello world test transcript',
      segments: [
        { t0: 0, t1: 200, text: 'Hello world test transcript' }
      ]
    }

    vi.mocked(runProcess).mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: ''
    } as ProcessResult)

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockWhisperOutput))

    const transcriber = new WhisperCppTranscriber(mockConfig)
    const result = await transcriber.transcribe('/test/audio.wav', 'video-123')

    expect(result.tokens).toHaveLength(4) // 4 words
    expect(result.tokens[0].text).toBe('Hello')
    expect(result.tokens[0].start_ms).toBe(0)
    // Timing should be evenly distributed across segment
    expect(result.tokens[0].end_ms).toBeGreaterThan(0)
    expect(result.tokens[0].end_ms).toBeLessThan(result.tokens[1].start_ms + 100)
  })

  it('allocates word timings evenly within segments', async () => {
    const mockWhisperOutput = {
      text: 'Test transcript',
      segments: [
        { t0: 0, t1: 100, text: 'Test transcript' }
      ]
    }

    vi.mocked(runProcess).mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: ''
    } as ProcessResult)

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockWhisperOutput))

    const transcriber = new WhisperCppTranscriber(mockConfig)
    const result = await transcriber.transcribe('/test/audio.wav', 'video-123')

    expect(result.tokens).toHaveLength(2)
    const duration = result.tokens[0].end_ms - result.tokens[0].start_ms
    // Each word should get approximately equal time
    expect(duration).toBeGreaterThan(400)
    expect(duration).toBeLessThan(600)
  })

  it('throws when whisper.cpp fails', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      success: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Error processing audio'
    } as ProcessResult)

    const transcriber = new WhisperCppTranscriber(mockConfig)

    await expect(transcriber.transcribe('/test/audio.wav', 'video-123')).rejects.toThrow(
      'Whisper.cpp failed'
    )
  })

  it('invokes whisper.cpp with correct arguments', async () => {
    const mockWhisperOutput = {
      text: 'Test',
      words: [{ word: 'Test', t0: 0, t1: 50, p: 0.9 }]
    }

    vi.mocked(runProcess).mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: ''
    } as ProcessResult)

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockWhisperOutput))

    const transcriber = new WhisperCppTranscriber(mockConfig)
    await transcriber.transcribe('/test/audio.wav', 'video-123')

    expect(runProcess).toHaveBeenCalledWith(
      mockConfig.binPath,
      expect.arrayContaining([
        '-m', mockConfig.modelPath,
        '-f', '/test/audio.wav',
        '-oj',
        '-ml', '1',
        '-t', '4',
        '-l', 'en'
      ]),
      expect.objectContaining({
        timeout: 600000
      })
    )
  })

  it('cleans up temporary output directory', async () => {
    const mockWhisperOutput = {
      text: 'Test',
      words: [{ word: 'Test', t0: 0, t1: 50, p: 0.9 }]
    }

    vi.mocked(runProcess).mockResolvedValue({
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: ''
    } as ProcessResult)

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(mockWhisperOutput))
    vi.mocked(fs.readdirSync).mockReturnValue(['transcript.json'] as any)

    const transcriber = new WhisperCppTranscriber(mockConfig)
    await transcriber.transcribe('/test/audio.wav', 'video-123')

    // Should cleanup temp files
    expect(fs.unlinkSync).toHaveBeenCalled()
    expect(fs.rmdirSync).toHaveBeenCalled()
  })
})
