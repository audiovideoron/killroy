/**
 * Whisper.cpp ASR Transcriber
 * Uses offline whisper.cpp binary for transcription
 */

import type { TranscriptV1, TranscriptToken, TranscriptSegment } from '../../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'
import { runProcess } from './runProcess'
import * as path from 'path'
import * as fs from 'fs'

export interface WhisperCppConfig {
  binPath: string // Path to whisper.cpp main binary
  modelPath: string // Path to ggml model file
  threads?: number // Number of threads (default: 4)
  language?: string // Language code (default: 'en')
}

/**
 * Whisper.cpp word-level timestamp output format
 */
interface WhisperWord {
  t0: number // Start time in centiseconds (100th of second)
  t1: number // End time in centiseconds
  word: string
  p: number // Probability/confidence
}

interface WhisperSegment {
  t0: number
  t1: number
  text: string
}

interface WhisperOutput {
  text: string
  segments?: WhisperSegment[]
  words?: WhisperWord[]
}

/**
 * Real Whisper-based transcriber using whisper.cpp
 */
export class WhisperCppTranscriber {
  private config: WhisperCppConfig

  constructor(config: WhisperCppConfig) {
    this.config = config
  }

  async transcribe(audioPath: string, videoId: string): Promise<TranscriptV1> {
    // Validate binary and model exist
    if (!fs.existsSync(this.config.binPath)) {
      throw new Error(`Whisper binary not found at: ${this.config.binPath}`)
    }
    if (!fs.existsSync(this.config.modelPath)) {
      throw new Error(`Whisper model not found at: ${this.config.modelPath}`)
    }

    // Create temp output directory
    const outputDir = path.join(path.dirname(audioPath), 'whisper-output')
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }

    const outputBase = path.join(outputDir, 'transcript')

    try {
      // Run whisper.cpp with word-level timestamps
      // whisper.cpp flags:
      // -m model
      // -f input file
      // -oj output JSON
      // -ml max-len (avoid overly long segments)
      // -t threads
      // -l language
      const args = [
        '-m', this.config.modelPath,
        '-f', audioPath,
        '-oj', // Output JSON with word timestamps
        '-ml', '1', // Word-level timestamps
        '-t', String(this.config.threads || 4),
        '-l', this.config.language || 'en',
        '-of', outputBase // Output file base (will add .json)
      ]

      const result = await runProcess(this.config.binPath, args, {
        timeout: 600000 // 10 minute timeout for long audio
      })

      if (!result.success) {
        throw new Error(
          `Whisper.cpp failed (exit ${result.exitCode}): ${result.stderr || result.error}`
        )
      }

      // Read JSON output
      const jsonPath = `${outputBase}.json`
      if (!fs.existsSync(jsonPath)) {
        throw new Error(`Whisper output JSON not found at: ${jsonPath}`)
      }

      const whisperOutput: WhisperOutput = JSON.parse(
        fs.readFileSync(jsonPath, 'utf8')
      )

      // Convert to TranscriptV1
      return this.convertToTranscriptV1(whisperOutput, videoId)
    } finally {
      // Cleanup output directory
      if (fs.existsSync(outputDir)) {
        const files = fs.readdirSync(outputDir)
        for (const file of files) {
          fs.unlinkSync(path.join(outputDir, file))
        }
        fs.rmdirSync(outputDir)
      }
    }
  }

  /**
   * Convert whisper.cpp output to TranscriptV1 format
   */
  private convertToTranscriptV1(
    whisperOutput: WhisperOutput,
    videoId: string
  ): TranscriptV1 {
    let tokens: TranscriptToken[]
    let segments: TranscriptSegment[]

    // If whisper provided word-level timestamps, use them directly
    if (whisperOutput.words && whisperOutput.words.length > 0) {
      tokens = whisperOutput.words.map((w) => ({
        token_id: uuidv4(),
        text: w.word.trim(),
        start_ms: Math.round(w.t0 * 10), // centiseconds to milliseconds
        end_ms: Math.round(w.t1 * 10),
        confidence: w.p
      }))

      // Group tokens into segments (every 10 words or by natural breaks)
      segments = this.groupTokensIntoSegments(tokens)
    } else if (whisperOutput.segments && whisperOutput.segments.length > 0) {
      // Fall back to segment-level: split text into words and allocate timing
      const allTokens: TranscriptToken[] = []
      segments = []

      for (const seg of whisperOutput.segments) {
        const words = this.splitIntoWords(seg.text)
        const segmentTokens = this.allocateWordTimings(
          words,
          Math.round(seg.t0 * 10),
          Math.round(seg.t1 * 10)
        )

        allTokens.push(...segmentTokens)

        segments.push({
          segment_id: uuidv4(),
          start_ms: Math.round(seg.t0 * 10),
          end_ms: Math.round(seg.t1 * 10),
          text: seg.text.trim(),
          token_ids: segmentTokens.map((t) => t.token_id)
        })
      }

      tokens = allTokens
    } else {
      // Fallback: single segment with full text
      const words = this.splitIntoWords(whisperOutput.text)
      tokens = this.allocateWordTimings(words, 0, 10000) // Assume 10 seconds

      segments = [
        {
          segment_id: uuidv4(),
          start_ms: 0,
          end_ms: 10000,
          text: whisperOutput.text.trim(),
          token_ids: tokens.map((t) => t.token_id)
        }
      ]
    }

    return {
      version: '1',
      video_id: videoId,
      tokens,
      segments
    }
  }

  /**
   * Split text into words (preserving punctuation as separate tokens if attached)
   */
  private splitIntoWords(text: string): string[] {
    // Split on whitespace, preserve tokens
    return text.trim().split(/\s+/).filter((w) => w.length > 0)
  }

  /**
   * Allocate word timings evenly within a time range
   */
  private allocateWordTimings(
    words: string[],
    start_ms: number,
    end_ms: number
  ): TranscriptToken[] {
    if (words.length === 0) return []

    const duration = end_ms - start_ms
    const timePerWord = duration / words.length

    return words.map((word, i) => ({
      token_id: uuidv4(),
      text: word,
      start_ms: Math.round(start_ms + i * timePerWord),
      end_ms: Math.round(start_ms + (i + 1) * timePerWord),
      confidence: 0.9 // Default confidence when not provided
    }))
  }

  /**
   * Group tokens into segments (every 10 words or natural breaks)
   */
  private groupTokensIntoSegments(tokens: TranscriptToken[]): TranscriptSegment[] {
    const segments: TranscriptSegment[] = []
    const wordsPerSegment = 10

    for (let i = 0; i < tokens.length; i += wordsPerSegment) {
      const segmentTokens = tokens.slice(i, i + wordsPerSegment)
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

    return segments
  }
}
