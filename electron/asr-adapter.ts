/**
 * ASR Adapter Interface and ElevenLabs Implementation
 */

import type { TranscriptV1, TranscriptToken, TranscriptSegment } from '../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'
import { ElevenLabsTranscriber } from './asr/ElevenLabsTranscriber'

/**
 * ASR Transcriber Interface
 */
export interface ITranscriber {
  transcribe(audioPath: string, videoId: string): Promise<TranscriptV1>
}

/**
 * Mock transcriber for testing
 * Generates realistic-looking transcript data without actual ASR
 */
export class MockTranscriber implements ITranscriber {
  async transcribe(audioPath: string, videoId: string): Promise<TranscriptV1> {
    // Simulate processing delay
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Generate mock tokens
    const words = [
      'Hello', 'world', 'this', 'is', 'a', 'test', 'transcript',
      'with', 'some', 'filler', 'words', 'um', 'like', 'uh',
      'you', 'know', 'basically', 'right'
    ]

    const tokens: TranscriptToken[] = []
    let currentTime = 0

    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      const duration = 200 + Math.random() * 300 // 200-500ms per word
      const pause = Math.random() * 200 // 0-200ms pause

      tokens.push({
        token_id: uuidv4(),
        text: word,
        start_ms: Math.round(currentTime),
        end_ms: Math.round(currentTime + duration),
        confidence: 0.85 + Math.random() * 0.14 // 0.85-0.99
      })

      currentTime += duration + pause
    }

    // Group tokens into segments (every 5 words)
    const segments: TranscriptSegment[] = []
    for (let i = 0; i < tokens.length; i += 5) {
      const segmentTokens = tokens.slice(i, i + 5)
      const start_ms = segmentTokens[0].start_ms
      const end_ms = segmentTokens[segmentTokens.length - 1].end_ms
      const text = segmentTokens.map((t) => t.text).join(' ')

      segments.push({
        segment_id: uuidv4(),
        start_ms,
        end_ms,
        text,
        token_ids: segmentTokens.map((t) => t.token_id)
      })
    }

    return {
      version: '1',
      video_id: videoId,
      tokens,
      segments
    }
  }
}

/**
 * Get transcriber instance based on configuration
 * Controlled by ASR_BACKEND environment variable:
 * - 'elevenlabs' (default): ElevenLabs Scribe API (real word-level timestamps)
 * - 'mock': MockTranscriber for testing
 */
export function getTranscriber(): ITranscriber {
  const backend = process.env.ASR_BACKEND || 'elevenlabs'

  console.log('=== ASR BACKEND INITIALIZATION ===')
  console.log('ASR_BACKEND:', backend)

  if (backend === 'mock') {
    console.log('✓ Using MockTranscriber')
    return new MockTranscriber()
  }

  // Default: ElevenLabs
  const apiKey = process.env.ELEVENLABS_API_KEY

  if (!apiKey) {
    const error = 'ELEVENLABS_API_KEY must be set for ASR'
    console.error('ERROR:', error)
    throw new Error(error)
  }

  console.log('✓ Using ElevenLabsTranscriber (real word-level timestamps)')
  return new ElevenLabsTranscriber({
    apiKey,
    language: process.env.ELEVENLABS_LANGUAGE || undefined,
    diarize: process.env.ELEVENLABS_DIARIZE === 'true'
  })
}
