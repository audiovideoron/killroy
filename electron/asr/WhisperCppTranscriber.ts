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
 * Whisper.cpp JSON output format (from whisper-cli -oj)
 */
interface WhisperTranscriptionSegment {
  timestamps: {
    from: string // "00:00:00,000"
    to: string   // "00:00:03,490"
  }
  offsets: {
    from: number // milliseconds
    to: number   // milliseconds
  }
  text: string
}

interface WhisperOutput {
  systeminfo?: string
  model?: Record<string, unknown>
  params?: Record<string, unknown>
  result?: {
    language: string
  }
  transcription: WhisperTranscriptionSegment[]
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

      console.log('[WhisperCpp] Running command:', this.config.binPath, args.join(' '))

      const result = await runProcess(this.config.binPath, args, {
        timeout: 600000 // 10 minute timeout for long audio
      })

      console.log('[WhisperCpp] Process exit code:', result.exitCode)
      console.log('[WhisperCpp] STDOUT:', result.stdout?.substring(0, 500))
      console.log('[WhisperCpp] STDERR:', result.stderr?.substring(0, 500))

      if (!result.success) {
        throw new Error(
          `Whisper.cpp failed (exit ${result.exitCode})\nSTDERR:\n${result.stderr}\nSTDOUT:\n${result.stdout}\nERROR:\n${result.error || 'none'}`
        )
      }

      // Allow filesystem to flush (whisper may write file asynchronously)
      await new Promise(resolve => setTimeout(resolve, 100))

      // Use consistent path - compute once
      const transcriptPath = path.join(outputDir, 'transcript.json')
      console.log('[WhisperCpp] Looking for output at:', transcriptPath)
      console.log('[WhisperCpp] Output directory exists:', fs.existsSync(outputDir))

      // List files in output directory for debugging
      if (fs.existsSync(outputDir)) {
        const files = fs.readdirSync(outputDir)
        console.log('[WhisperCpp] Files in output directory:', files)
      } else {
        console.log('[WhisperCpp] ERROR: Output directory does not exist:', outputDir)
      }

      if (!fs.existsSync(transcriptPath)) {
        // Extra diagnostic: check parent directory
        const parentDir = path.dirname(audioPath)
        console.log('[WhisperCpp] Parent directory:', parentDir)
        console.log('[WhisperCpp] Parent directory contents:', fs.readdirSync(parentDir))

        throw new Error(
          `Whisper output JSON not found at: ${transcriptPath}\n` +
          `Exit code: ${result.exitCode}\n` +
          `Output directory: ${outputDir}\n` +
          `Output directory exists: ${fs.existsSync(outputDir)}\n` +
          `Parent directory: ${parentDir}\n` +
          `STDOUT: ${result.stdout}\n` +
          `STDERR: ${result.stderr}`
        )
      }

      const jsonContent = fs.readFileSync(transcriptPath, 'utf8')
      console.log('[WhisperCpp] JSON content length:', jsonContent.length)
      console.log('[WhisperCpp] JSON preview:', jsonContent.substring(0, 200))

      const whisperOutput: WhisperOutput = JSON.parse(jsonContent)

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
   * Convert whisper-cli JSON output to TranscriptV1 format
   */
  private convertToTranscriptV1(
    whisperOutput: WhisperOutput,
    videoId: string
  ): TranscriptV1 {
    console.log('[WhisperCpp] Converting to TranscriptV1, segments:', whisperOutput.transcription?.length)

    if (!whisperOutput.transcription || whisperOutput.transcription.length === 0) {
      throw new Error('Whisper output contains no transcription segments')
    }

    const allTokens: TranscriptToken[] = []
    const segments: TranscriptSegment[] = []

    // Process each transcription segment from whisper-cli
    for (const seg of whisperOutput.transcription) {
      // Skip empty segments
      if (!seg.text || seg.text.trim().length === 0) {
        continue
      }

      const start_ms = seg.offsets.from
      const end_ms = seg.offsets.to

      // Split segment text into words and allocate timing
      const words = this.splitIntoWords(seg.text)
      const segmentTokens = this.allocateWordTimings(words, start_ms, end_ms)

      allTokens.push(...segmentTokens)

      segments.push({
        segment_id: uuidv4(),
        start_ms,
        end_ms,
        text: seg.text.trim(),
        token_ids: segmentTokens.map((t) => t.token_id)
      })
    }

    console.log('[WhisperCpp] Converted to', allTokens.length, 'tokens,', segments.length, 'segments')

    return {
      version: '1',
      video_id: videoId,
      tokens: allTokens,
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

}
