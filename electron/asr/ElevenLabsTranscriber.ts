/**
 * ElevenLabs Speech-to-Text Transcriber
 * Uses ElevenLabs Scribe API for transcription with real word-level timestamps
 */

import type { TranscriptV1, TranscriptToken, TranscriptSegment } from '../../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import * as path from 'path'
import fetch from 'node-fetch'
import FormData from 'form-data'

const ELEVENLABS_STT_API = 'https://api.elevenlabs.io/v1/speech-to-text'

/**
 * ElevenLabs STT API response word format
 */
interface ElevenLabsWord {
  text: string
  start: number  // seconds
  end: number    // seconds
  type: 'word' | 'spacing' | 'audio_event'
  speaker_id?: string
}

/**
 * ElevenLabs STT API response format
 */
interface ElevenLabsSTTResponse {
  language_code: string
  language_probability: number
  text: string
  words: ElevenLabsWord[]
}

export interface ElevenLabsTranscriberConfig {
  apiKey?: string  // Falls back to ELEVENLABS_API_KEY env var
  language?: string  // ISO-639-1 code, null for auto-detect
  diarize?: boolean
}

/**
 * ElevenLabs-based transcriber with real word-level timestamps
 */
export class ElevenLabsTranscriber {
  private config: ElevenLabsTranscriberConfig

  constructor(config: ElevenLabsTranscriberConfig = {}) {
    this.config = config
  }

  async transcribe(audioPath: string, videoId: string): Promise<TranscriptV1> {
    const apiKey = this.config.apiKey || process.env.ELEVENLABS_API_KEY
    if (!apiKey) {
      throw new Error('ELEVENLABS_API_KEY is not set')
    }

    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`)
    }

    console.log('[ElevenLabs STT] Transcribing:', audioPath)

    // Prepare multipart form data
    const form = new FormData()
    form.append('file', fs.createReadStream(audioPath), {
      filename: path.basename(audioPath),
      contentType: this.getContentType(audioPath)
    })
    form.append('model_id', 'scribe_v1')
    form.append('timestamps_granularity', 'word')

    if (this.config.language) {
      form.append('language_code', this.config.language)
    }
    if (this.config.diarize) {
      form.append('diarize', 'true')
    }

    const response = await fetch(ELEVENLABS_STT_API, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        ...form.getHeaders()
      },
      body: form
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('[ElevenLabs STT] API Error:', response.status, errorText)
      throw new Error(`ElevenLabs STT failed: ${response.status} ${errorText}`)
    }

    const result = await response.json() as ElevenLabsSTTResponse
    console.log('[ElevenLabs STT] Success:', result.text?.substring(0, 100) + '...')
    console.log('[ElevenLabs STT] Words:', result.words?.length || 0)
    console.log('[ElevenLabs STT] FULL TEXT:', result.text)
    console.log('[ElevenLabs STT] ALL WORDS:', JSON.stringify(result.words, null, 2))

    return this.convertToTranscriptV1(result, videoId)
  }

  private getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    const contentTypes: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.m4a': 'audio/mp4',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.webm': 'audio/webm',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska'
    }
    return contentTypes[ext] || 'application/octet-stream'
  }

  private convertToTranscriptV1(
    response: ElevenLabsSTTResponse,
    videoId: string
  ): TranscriptV1 {
    const tokens: TranscriptToken[] = []
    const segments: TranscriptSegment[] = []

    if (!response.words || response.words.length === 0) {
      console.warn('[ElevenLabs STT] No words in response')
      return { version: '1', video_id: videoId, tokens: [], segments: [] }
    }

    // Debug: log unique types in response
    const types = [...new Set(response.words.map(w => w.type))]
    console.log('[ElevenLabs STT] Word types in response:', types)

    // Filter to only actual words (skip spacing and audio events)
    // Be lenient: include words that have text and timestamps, even if type is missing
    const words = response.words.filter(w => {
      const isWord = w.type === 'word' || (!w.type && w.text && typeof w.start === 'number')
      return isWord
    })
    console.log('[ElevenLabs STT] After filter:', words.length, 'words')

    // Create tokens with real timestamps (convert seconds to ms)
    for (const word of words) {
      tokens.push({
        token_id: uuidv4(),
        text: word.text,
        start_ms: Math.round(word.start * 1000),
        end_ms: Math.round(word.end * 1000),
        confidence: 0.95  // ElevenLabs doesn't provide per-word confidence
      })
    }

    // Group into segments (by sentence or ~10 second chunks)
    const segmentTokens: TranscriptToken[][] = []
    let currentSegment: TranscriptToken[] = []
    let segmentStart = 0

    for (const token of tokens) {
      if (currentSegment.length === 0) {
        segmentStart = token.start_ms
      }

      currentSegment.push(token)

      // End segment on sentence-ending punctuation or time threshold
      const isSentenceEnd = /[.!?]$/.test(token.text)
      const timeSinceStart = token.end_ms - segmentStart

      if (isSentenceEnd || timeSinceStart > 10000 || currentSegment.length >= 50) {
        segmentTokens.push([...currentSegment])
        currentSegment = []
      }
    }

    // Don't forget remaining tokens
    if (currentSegment.length > 0) {
      segmentTokens.push(currentSegment)
    }

    // Build segments
    for (const segToks of segmentTokens) {
      if (segToks.length === 0) continue

      segments.push({
        segment_id: uuidv4(),
        start_ms: segToks[0].start_ms,
        end_ms: segToks[segToks.length - 1].end_ms,
        text: segToks.map(t => t.text).join(' '),
        token_ids: segToks.map(t => t.token_id)
      })
    }

    console.log('[ElevenLabs STT] Converted:', tokens.length, 'tokens,', segments.length, 'segments')

    return {
      version: '1',
      video_id: videoId,
      tokens,
      segments
    }
  }
}
