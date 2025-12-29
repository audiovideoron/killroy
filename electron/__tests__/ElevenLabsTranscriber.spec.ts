/**
 * ElevenLabsTranscriber Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock fetch before importing the module
vi.mock('node-fetch', () => ({
  default: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  createReadStream: vi.fn(() => ({ pipe: vi.fn() }))
}))

vi.mock('form-data', () => {
  return {
    default: class MockFormData {
      append = vi.fn()
      getHeaders = vi.fn(() => ({ 'content-type': 'multipart/form-data' }))
    }
  }
})

import { ElevenLabsTranscriber } from '../asr/ElevenLabsTranscriber'
import fetch from 'node-fetch'

const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>

describe('ElevenLabsTranscriber', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ELEVENLABS_API_KEY = 'test-api-key'
  })

  it('should throw if API key is missing', async () => {
    delete process.env.ELEVENLABS_API_KEY
    const transcriber = new ElevenLabsTranscriber()

    await expect(transcriber.transcribe('/test/audio.mp3', 'video-123'))
      .rejects.toThrow('ELEVENLABS_API_KEY is not set')
  })

  it('should convert API response to TranscriptV1 with real timestamps', async () => {
    const mockResponse = {
      language_code: 'en',
      language_probability: 0.98,
      text: 'Hello world test',
      words: [
        { text: 'Hello', start: 0.5, end: 0.8, type: 'word', speaker_id: 'speaker_0' },
        { text: ' ', start: 0.8, end: 0.9, type: 'spacing', speaker_id: 'speaker_0' },
        { text: 'world', start: 0.9, end: 1.3, type: 'word', speaker_id: 'speaker_0' },
        { text: ' ', start: 1.3, end: 1.4, type: 'spacing', speaker_id: 'speaker_0' },
        { text: 'test', start: 1.4, end: 1.8, type: 'word', speaker_id: 'speaker_0' }
      ]
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    })

    const transcriber = new ElevenLabsTranscriber({ apiKey: 'test-key' })
    const result = await transcriber.transcribe('/test/audio.mp3', 'video-123')

    // Should have 3 tokens (words only, spacing filtered out)
    expect(result.tokens).toHaveLength(3)
    expect(result.version).toBe('1')
    expect(result.video_id).toBe('video-123')

    // Check real timestamps (converted from seconds to ms)
    expect(result.tokens[0].text).toBe('Hello')
    expect(result.tokens[0].start_ms).toBe(500)
    expect(result.tokens[0].end_ms).toBe(800)

    expect(result.tokens[1].text).toBe('world')
    expect(result.tokens[1].start_ms).toBe(900)
    expect(result.tokens[1].end_ms).toBe(1300)

    expect(result.tokens[2].text).toBe('test')
    expect(result.tokens[2].start_ms).toBe(1400)
    expect(result.tokens[2].end_ms).toBe(1800)
  })

  it('should filter out audio events', async () => {
    const mockResponse = {
      language_code: 'en',
      language_probability: 0.98,
      text: '(laughter) Hello',
      words: [
        { text: '(laughter)', start: 0.0, end: 0.5, type: 'audio_event' },
        { text: 'Hello', start: 0.6, end: 1.0, type: 'word', speaker_id: 'speaker_0' }
      ]
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    })

    const transcriber = new ElevenLabsTranscriber({ apiKey: 'test-key' })
    const result = await transcriber.transcribe('/test/audio.mp3', 'video-123')

    // Should only have the word, not the audio event
    expect(result.tokens).toHaveLength(1)
    expect(result.tokens[0].text).toBe('Hello')
  })

  it('should handle API errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Invalid API key')
    })

    const transcriber = new ElevenLabsTranscriber({ apiKey: 'bad-key' })

    await expect(transcriber.transcribe('/test/audio.mp3', 'video-123'))
      .rejects.toThrow('ElevenLabs STT failed: 401')
  })

  it('should create segments from words', async () => {
    const mockResponse = {
      language_code: 'en',
      language_probability: 0.98,
      text: 'This is a sentence.',
      words: [
        { text: 'This', start: 0.0, end: 0.3, type: 'word' },
        { text: 'is', start: 0.4, end: 0.5, type: 'word' },
        { text: 'a', start: 0.6, end: 0.7, type: 'word' },
        { text: 'sentence.', start: 0.8, end: 1.2, type: 'word' }
      ]
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse)
    })

    const transcriber = new ElevenLabsTranscriber({ apiKey: 'test-key' })
    const result = await transcriber.transcribe('/test/audio.mp3', 'video-123')

    expect(result.segments.length).toBeGreaterThan(0)
    expect(result.segments[0].text).toBe('This is a sentence.')
    expect(result.segments[0].token_ids).toHaveLength(4)
  })
})
