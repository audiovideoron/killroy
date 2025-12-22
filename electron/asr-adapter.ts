/**
 * ASR Adapter Interface and Mock Implementation
 */

import type { TranscriptV1, TranscriptToken, TranscriptSegment } from '../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'
import { WhisperCppTranscriber } from './asr/WhisperCppTranscriber'

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
 * - 'mock' (default): MockTranscriber for testing
 * - 'whispercpp': Real Whisper.cpp transcriber
 */
export function getTranscriber(): ITranscriber {
  const backend = process.env.ASR_BACKEND || 'mock'

  console.log('=== ASR BACKEND INITIALIZATION ===')
  console.log('ASR_BACKEND:', backend)

  if (backend === 'whispercpp') {
    const binPath = process.env.WHISPER_CPP_BIN || '/opt/homebrew/bin/whisper-cli'
    const modelPath = process.env.WHISPER_MODEL || ''

    console.log('WHISPER_CPP_BIN:', binPath)
    console.log('WHISPER_MODEL:', modelPath)

    if (!modelPath) {
      const error = 'WHISPER_MODEL environment variable must be set when using ASR_BACKEND=whispercpp'
      console.error('ERROR:', error)
      throw new Error(error)
    }

    console.log('✓ Using WhisperCppTranscriber')
    return new WhisperCppTranscriber({
      binPath,
      modelPath,
      threads: parseInt(process.env.WHISPER_THREADS || '4', 10),
      language: process.env.WHISPER_LANGUAGE || 'en'
    })
  }

  // Default: mock transcriber
  console.log('✓ Using MockTranscriber (default)')
  return new MockTranscriber()
}
