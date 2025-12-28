/**
 * Voice Synthesis Pipeline
 * Synthesizes transcript to audio aligned with video timing
 */

import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { synthesizeWithElevenLabs } from './elevenlabs'
import { probeAudioDuration } from '../media-metadata'
import { buildEffectiveRemoveRanges, invertToKeepRanges } from '../edl-engine'
import type { TranscriptV1, TranscriptToken, EdlV1, VideoAsset } from '../../shared/editor-types'

// Default voice ID (Sarah)
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'

// Chunking threshold: start new chunk if gap > this many ms
const CHUNK_GAP_THRESHOLD_MS = 500

// Time stretch bounds (atempo range: 0.5 to 2.0, but keep it natural)
const MIN_TEMPO = 0.85
const MAX_TEMPO = 1.15

interface SynthChunk {
  start_ms: number
  end_ms: number
  text: string
  tokens: TranscriptToken[]
}

interface FittedChunk {
  chunk: SynthChunk
  audioPath: string
  fittedPath: string
  synth_duration_ms: number
  target_duration_ms: number
}

export interface SynthesisReport {
  outputPath: string
  chunks: number
  total_target_ms: number
  total_synth_ms: number
  tempo_adjustments: number
}

/**
 * Build synthesis chunks from tokens within keep ranges
 */
function buildChunks(
  tokens: TranscriptToken[],
  keepRanges: Array<{ start_ms: number; end_ms: number }>
): SynthChunk[] {
  const chunks: SynthChunk[] = []

  for (const range of keepRanges) {
    // Filter tokens that fall within this keep range
    const rangeTokens = tokens.filter(
      (t) => t.start_ms >= range.start_ms && t.end_ms <= range.end_ms
    )

    if (rangeTokens.length === 0) continue

    // Group consecutive tokens into chunks based on gap threshold
    let currentChunk: TranscriptToken[] = []

    for (let i = 0; i < rangeTokens.length; i++) {
      const token = rangeTokens[i]

      if (currentChunk.length === 0) {
        currentChunk.push(token)
        continue
      }

      const lastToken = currentChunk[currentChunk.length - 1]
      const gap = token.start_ms - lastToken.end_ms

      if (gap > CHUNK_GAP_THRESHOLD_MS) {
        // Finish current chunk and start new one
        chunks.push({
          start_ms: currentChunk[0].start_ms,
          end_ms: currentChunk[currentChunk.length - 1].end_ms,
          text: currentChunk.map((t) => t.text).join(' '),
          tokens: currentChunk
        })
        currentChunk = [token]
      } else {
        currentChunk.push(token)
      }
    }

    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push({
        start_ms: currentChunk[0].start_ms,
        end_ms: currentChunk[currentChunk.length - 1].end_ms,
        text: currentChunk.map((t) => t.text).join(' '),
        tokens: currentChunk
      })
    }
  }

  return chunks
}

/**
 * Run FFmpeg command
 */
function runFFmpegCommand(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg failed: ${stderr}`))
      } else {
        resolve()
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })
  })
}

/**
 * Fit audio to target duration using padding, tempo adjustment, or trimming
 */
async function fitAudioToDuration(
  inputPath: string,
  outputPath: string,
  synth_ms: number,
  target_ms: number
): Promise<{ tempoUsed: number }> {
  const ratio = synth_ms / target_ms

  if (ratio <= 1.0) {
    // Synth is shorter or equal - pad with silence
    const padDuration = (target_ms - synth_ms) / 1000
    await runFFmpegCommand([
      '-y',
      '-i', inputPath,
      '-af', `apad=pad_dur=${padDuration}`,
      '-ar', '44100',
      '-ac', '1',
      outputPath
    ])
    return { tempoUsed: 1.0 }
  }

  // Synth is longer - try tempo adjustment
  let tempo = ratio
  if (tempo > MAX_TEMPO) {
    tempo = MAX_TEMPO
  }

  // Apply tempo
  await runFFmpegCommand([
    '-y',
    '-i', inputPath,
    '-af', `atempo=${tempo}`,
    '-ar', '44100',
    '-ac', '1',
    outputPath
  ])

  // Check if still too long after tempo adjustment
  const adjustedDuration = await probeAudioDuration(outputPath)
  if (adjustedDuration > target_ms + 50) {
    // Trim to target
    const trimPath = outputPath.replace('.wav', '-trimmed.wav')
    await runFFmpegCommand([
      '-y',
      '-i', outputPath,
      '-t', (target_ms / 1000).toString(),
      '-ar', '44100',
      '-ac', '1',
      trimPath
    ])
    fs.renameSync(trimPath, outputPath)
  }

  return { tempoUsed: tempo }
}

/**
 * Generate silence audio of specified duration
 */
async function generateSilence(outputPath: string, duration_ms: number): Promise<void> {
  await runFFmpegCommand([
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=r=44100:cl=mono`,
    '-t', (duration_ms / 1000).toString(),
    outputPath
  ])
}

/**
 * Main synthesis pipeline
 */
export async function synthesizeVoiceTrack(
  videoAsset: VideoAsset,
  transcript: TranscriptV1,
  edl: EdlV1,
  workDir: string
): Promise<SynthesisReport> {
  // Create work directory
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true })
  }

  // Compute keep ranges
  let keepRanges: Array<{ start_ms: number; end_ms: number }>
  if (edl.remove_ranges.length > 0) {
    const effectiveRemoves = buildEffectiveRemoveRanges(edl, videoAsset.duration_ms)
    keepRanges = invertToKeepRanges(effectiveRemoves, videoAsset.duration_ms)
  } else {
    keepRanges = [{ start_ms: 0, end_ms: videoAsset.duration_ms }]
  }

  // Build chunks from transcript
  const chunks = buildChunks(transcript.tokens, keepRanges)

  if (chunks.length === 0) {
    throw new Error('No transcript chunks to synthesize')
  }

  console.log(`[synthesis] Processing ${chunks.length} chunks...`)

  // Synthesize and fit each chunk
  const fittedChunks: FittedChunk[] = []
  let tempoAdjustments = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const target_duration_ms = chunk.end_ms - chunk.start_ms

    console.log(`[synthesis] Chunk ${i + 1}/${chunks.length}: "${chunk.text.substring(0, 50)}..."`)

    // Synthesize
    const rawPath = path.join(workDir, `chunk-${i}-raw.mp3`)
    const synthPath = await synthesizeWithElevenLabs(chunk.text, DEFAULT_VOICE_ID, rawPath)
    const synth_duration_ms = await probeAudioDuration(synthPath)

    // Fit to target duration
    const fittedPath = path.join(workDir, `chunk-${i}-fitted.wav`)
    const { tempoUsed } = await fitAudioToDuration(synthPath, fittedPath, synth_duration_ms, target_duration_ms)

    if (tempoUsed !== 1.0) {
      tempoAdjustments++
    }

    fittedChunks.push({
      chunk,
      audioPath: synthPath,
      fittedPath,
      synth_duration_ms,
      target_duration_ms
    })
  }

  // Assemble full track with gaps
  console.log('[synthesis] Assembling full track...')

  const assemblyParts: string[] = []
  let currentTime = 0

  for (const fitted of fittedChunks) {
    const chunkStart = fitted.chunk.start_ms

    // Insert silence for gap before this chunk
    if (chunkStart > currentTime) {
      const gapDuration = chunkStart - currentTime
      const silencePath = path.join(workDir, `silence-${assemblyParts.length}.wav`)
      await generateSilence(silencePath, gapDuration)
      assemblyParts.push(silencePath)
    }

    assemblyParts.push(fitted.fittedPath)
    currentTime = fitted.chunk.end_ms
  }

  // Add trailing silence if needed
  if (currentTime < videoAsset.duration_ms) {
    const trailingSilence = path.join(workDir, `silence-trailing.wav`)
    await generateSilence(trailingSilence, videoAsset.duration_ms - currentTime)
    assemblyParts.push(trailingSilence)
  }

  // Concatenate all parts
  const concatListPath = path.join(workDir, 'concat-list.txt')
  const concatContent = assemblyParts.map((p) => `file '${p}'`).join('\n')
  fs.writeFileSync(concatListPath, concatContent)

  const assembledTrackPath = path.join(workDir, 'synthesized-track.wav')
  await runFFmpegCommand([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-ar', '44100',
    '-ac', '1',
    assembledTrackPath
  ])

  // Mux with original video
  console.log('[synthesis] Muxing with video...')

  const outputPath = path.join(workDir, 'preview-synthesized.mp4')
  await runFFmpegCommand([
    '-y',
    '-i', videoAsset.file_path,
    '-i', assembledTrackPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-shortest',
    outputPath
  ])

  console.log('[synthesis] Complete!')

  // Calculate totals
  const total_target_ms = fittedChunks.reduce((sum, f) => sum + f.target_duration_ms, 0)
  const total_synth_ms = fittedChunks.reduce((sum, f) => sum + f.synth_duration_ms, 0)

  return {
    outputPath,
    chunks: chunks.length,
    total_target_ms,
    total_synth_ms,
    tempo_adjustments: tempoAdjustments
  }
}
