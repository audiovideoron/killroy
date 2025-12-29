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
import { getConfiguredVoiceId } from './voice-clone'
import type { TranscriptV1, TranscriptToken, EdlV1, VideoAsset, WordReplacement } from '../../shared/editor-types'

// Default voice ID (Sarah) - used as fallback when no cloned voice configured
const DEFAULT_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'

// Resolve active voice ID (cloned voice takes priority)
function resolveVoiceId(): string {
  return getConfiguredVoiceId(DEFAULT_VOICE_ID)
}

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
  audioTrackPath: string  // Path to synthesized-track.wav for export
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
 * Fit audio to target duration using padding or minimal tempo adjustment
 * NO TRIMMING - synth plays at natural speed, may overflow slot
 */
async function fitAudioToDuration(
  inputPath: string,
  outputPath: string,
  synth_ms: number,
  target_ms: number
): Promise<{ tempoUsed: number; actual_ms: number }> {
  const ratio = synth_ms / target_ms

  if (ratio <= 1.0) {
    // Synth is shorter or equal - pad with silence to fill slot
    const padDuration = (target_ms - synth_ms) / 1000
    await runFFmpegCommand([
      '-y',
      '-i', inputPath,
      '-af', `apad=pad_dur=${padDuration}`,
      '-ar', '44100',
      '-ac', '1',
      outputPath
    ])
    return { tempoUsed: 1.0, actual_ms: target_ms }
  }

  // Synth is longer - only apply minimal tempo adjustment (within natural range)
  // If ratio > MAX_TEMPO, we do NOT trim - let synth overflow
  let tempo = ratio
  if (tempo > MAX_TEMPO) {
    console.log(`[fit] Synth ${synth_ms}ms > target ${target_ms}ms (ratio ${ratio.toFixed(2)}x) - using natural speed, will overflow`)
    // Just copy without tempo adjustment - play at natural speed
    await runFFmpegCommand([
      '-y',
      '-i', inputPath,
      '-ar', '44100',
      '-ac', '1',
      outputPath
    ])
    return { tempoUsed: 1.0, actual_ms: synth_ms }
  }

  // Ratio is within acceptable tempo range - apply tempo
  console.log(`[fit] Applying tempo ${tempo.toFixed(2)}x to fit ${synth_ms}ms into ${target_ms}ms`)
  await runFFmpegCommand([
    '-y',
    '-i', inputPath,
    '-af', `atempo=${tempo}`,
    '-ar', '44100',
    '-ac', '1',
    outputPath
  ])

  const adjustedDuration = await probeAudioDuration(outputPath)
  return { tempoUsed: tempo, actual_ms: adjustedDuration }
}

/**
 * Probe mean volume of an audio file or region
 * Returns mean_volume in dB
 */
async function probeVolume(audioPath: string, startMs?: number, durationMs?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const args: string[] = ['-y']

    // If seeking to a specific region, extract it first for accurate measurement
    if (startMs !== undefined && durationMs !== undefined) {
      args.push('-ss', (startMs / 1000).toString())
      args.push('-t', (durationMs / 1000).toString())
    }

    args.push('-i', audioPath, '-af', 'volumedetect', '-f', 'null', '/dev/null')

    const proc = spawn('ffmpeg', args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      // Parse mean_volume from stderr
      const match = stderr.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/)
      if (match) {
        resolve(parseFloat(match[1]))
      } else {
        // If no volume detected (silence), return very low value
        resolve(-91.0)
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to probe volume: ${err.message}`))
    })
  })
}

/**
 * Apply volume adjustment to audio file
 */
async function adjustVolume(inputPath: string, outputPath: string, volumeDb: number): Promise<void> {
  await runFFmpegCommand([
    '-y',
    '-i', inputPath,
    '-af', `volume=${volumeDb}dB`,
    '-ar', '44100',
    '-ac', '1',
    outputPath
  ])
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

  // [tts:synth] Forensic log: voice resolution and output paths
  console.log('[tts:synth] workDir:', workDir)
  console.log('[tts:synth] ELEVENLABS_VOICE_ID env:', process.env.ELEVENLABS_VOICE_ID || '(unset)')

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

  // Resolve voice ID once for entire synthesis (cloned voice takes priority)
  const voiceId = resolveVoiceId()
  const isDefaultVoice = voiceId === DEFAULT_VOICE_ID
  console.log(`[tts:synth] voiceId: ${voiceId}${isDefaultVoice ? ' (DEFAULT - Sarah)' : ' (CLONED)'}`)
  console.log(`[tts:synth] model: eleven_multilingual_v2`)
  console.log(`[tts:synth] outputPath: ${path.join(workDir, 'preview-synthesized.mp4')}`)
  console.log(`[synthesis] Processing ${chunks.length} chunks...`)

  // Synthesize and fit each chunk
  const fittedChunks: FittedChunk[] = []
  let tempoAdjustments = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const target_duration_ms = chunk.end_ms - chunk.start_ms

    console.log(`[synthesis] Chunk ${i + 1}/${chunks.length}: "${chunk.text.substring(0, 50)}..."`)

    // Synthesize using resolved voice
    const rawPath = path.join(workDir, `chunk-${i}-raw.mp3`)
    const synthPath = await synthesizeWithElevenLabs(chunk.text, voiceId, rawPath)
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
    audioTrackPath: assembledTrackPath,
    chunks: chunks.length,
    total_target_ms,
    total_synth_ms,
    tempo_adjustments: tempoAdjustments
  }
}

// ============================================================================
// HYBRID SYNTHESIS - DSP + Synth Patches
// ============================================================================

interface ReplacementChunk {
  replacement: WordReplacement
  audioPath: string
  fittedPath: string
  synth_duration_ms: number
  target_duration_ms: number
}

/**
 * Extract audio from video and apply DSP filters
 */
async function extractAudioWithDsp(
  videoPath: string,
  outputPath: string,
  dspFilterChain: string | null
): Promise<void> {
  const args = [
    '-y',
    '-i', videoPath,
    '-vn'  // No video
  ]

  if (dspFilterChain) {
    args.push('-af', dspFilterChain)
  }

  args.push(
    '-ar', '44100',
    '-ac', '1',
    outputPath
  )

  await runFFmpegCommand(args)
}

/**
 * Silence specific time regions in an audio file
 */
async function silenceRegions(
  inputPath: string,
  outputPath: string,
  regions: Array<{ start_ms: number; end_ms: number }>
): Promise<void> {
  if (regions.length === 0) {
    // No regions to silence - just copy
    fs.copyFileSync(inputPath, outputPath)
    return
  }

  // Build volume filter with enable conditions for each region
  // volume=enable='between(t,1.5,2.0)+between(t,5.0,5.5)':volume=0
  const conditions = regions
    .map(r => `between(t,${r.start_ms / 1000},${r.end_ms / 1000})`)
    .join('+')

  const filter = `volume=enable='${conditions}':volume=0`

  await runFFmpegCommand([
    '-y',
    '-i', inputPath,
    '-af', filter,
    '-ar', '44100',
    '-ac', '1',
    outputPath
  ])
}

/**
 * Synthesize only replacement words (with level matching)
 */
async function synthesizeReplacementChunks(
  replacements: WordReplacement[],
  voiceId: string,
  workDir: string,
  referenceAudioPath: string
): Promise<ReplacementChunk[]> {
  const chunks: ReplacementChunk[] = []

  for (let i = 0; i < replacements.length; i++) {
    const repl = replacements[i]
    const target_duration_ms = repl.end_ms - repl.start_ms

    console.log(`[hybrid] Synth replacement ${i + 1}/${replacements.length}: "${repl.original_text}" → "${repl.replacement_text}"`)

    // Synthesize replacement text
    const rawPath = path.join(workDir, `repl-${i}-raw.mp3`)
    const synthPath = await synthesizeWithElevenLabs(repl.replacement_text, voiceId, rawPath)
    const synth_duration_ms = await probeAudioDuration(synthPath)

    // Fit to target duration
    const unfittedPath = path.join(workDir, `repl-${i}-unfitted.wav`)
    await fitAudioToDuration(synthPath, unfittedPath, synth_duration_ms, target_duration_ms)

    // Level matching: reduce synth to match reference audio level
    const refVolume = await probeVolume(referenceAudioPath)
    const synthVolume = await probeVolume(unfittedPath)
    const adjustment = refVolume - synthVolume
    console.log(`[hybrid] Level match: ref=${refVolume.toFixed(1)}dB synth=${synthVolume.toFixed(1)}dB adj=${adjustment.toFixed(1)}dB`)

    const fittedPath = path.join(workDir, `repl-${i}-fitted.wav`)
    await adjustVolume(unfittedPath, fittedPath, adjustment)

    chunks.push({
      replacement: repl,
      audioPath: synthPath,
      fittedPath,
      synth_duration_ms,
      target_duration_ms
    })
  }

  return chunks
}

/**
 * Build synth patches track - silence with synth chunks at replacement positions
 */
async function buildSynthPatchesTrack(
  synthChunks: ReplacementChunk[],
  totalDuration_ms: number,
  workDir: string,
  outputPath: string
): Promise<void> {
  if (synthChunks.length === 0) {
    // No patches - create pure silence
    await generateSilence(outputPath, totalDuration_ms)
    return
  }

  // Sort chunks by start time
  const sorted = [...synthChunks].sort((a, b) => a.replacement.start_ms - b.replacement.start_ms)

  // Build the track by assembling silence + chunks
  const parts: string[] = []
  let currentTime = 0

  // Buffer before synth starts - protects preceding word's tail
  const SYNTH_START_BUFFER_MS = 50

  console.log('[synth-track] Building synth patches track...')
  for (let i = 0; i < sorted.length; i++) {
    const chunk = sorted[i]
    const chunkStart = chunk.replacement.start_ms + SYNTH_START_BUFFER_MS

    // Silence before this chunk
    if (chunkStart > currentTime) {
      const silenceDuration = chunkStart - currentTime
      const silencePath = path.join(workDir, `synth-silence-${i}.wav`)
      console.log(`[synth-track] Adding silence: ${currentTime}ms - ${chunkStart}ms (${silenceDuration}ms)`)
      await generateSilence(silencePath, silenceDuration)
      parts.push(silencePath)
    }

    // The synth chunk
    console.log(`[synth-track] Adding synth chunk: ${chunkStart}ms - ${chunkStart + chunk.synth_duration_ms}ms (${chunk.synth_duration_ms}ms)`)
    parts.push(chunk.fittedPath)
    // After synth ends, current time is start + buffer + synth duration
    currentTime = chunkStart + chunk.synth_duration_ms
  }

  // Trailing silence
  if (currentTime < totalDuration_ms) {
    const silencePath = path.join(workDir, `synth-silence-trailing.wav`)
    await generateSilence(silencePath, totalDuration_ms - currentTime)
    parts.push(silencePath)
  }

  // Concatenate all parts
  const concatListPath = path.join(workDir, 'synth-concat-list.txt')
  fs.writeFileSync(concatListPath, parts.map(p => `file '${p}'`).join('\n'))

  await runFFmpegCommand([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-ar', '44100',
    '-ac', '1',
    outputPath
  ])
}

/**
 * Mix DSP track (with holes) and synth patches track
 * Since they're mutually exclusive, simple addition works
 */
async function mixDspAndSynth(
  dspPath: string,
  synthPath: string,
  outputPath: string
): Promise<void> {
  await runFFmpegCommand([
    '-y',
    '-i', dspPath,
    '-i', synthPath,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:normalize=0',
    '-ar', '44100',
    '-ac', '1',
    outputPath
  ])
}

/**
 * Main hybrid synthesis pipeline
 * Creates preview with DSP-processed audio + synthesized replacement patches
 */
export async function synthesizeHybridTrack(
  videoAsset: VideoAsset,
  edl: EdlV1,
  dspFilterChain: string | null,
  workDir: string
): Promise<SynthesisReport> {
  // Create work directory
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true })
  }

  const replacements = edl.replacements || []
  let effectiveRemoves = buildEffectiveRemoveRanges(edl, videoAsset.duration_ms)

  // Protect regions adjacent to replacements from being deleted by padding
  // If a remove range's padding would eat into the area before a replacement, trim it back
  for (const repl of replacements) {
    effectiveRemoves = effectiveRemoves.map(remove => {
      // If remove range ends after replacement starts and overlaps with pre-replacement zone
      // Trim the remove range to end at the replacement start
      if (remove.end_ms > repl.start_ms && remove.start_ms < repl.start_ms) {
        console.log(`[hybrid] Trimming remove range end from ${remove.end_ms}ms to ${repl.start_ms}ms to protect pre-replacement audio`)
        return { start_ms: remove.start_ms, end_ms: repl.start_ms }
      }
      // If remove range starts before replacement ends and overlaps with post-replacement zone
      // Trim the remove range to start at the replacement end
      if (remove.start_ms < repl.end_ms && remove.end_ms > repl.end_ms) {
        console.log(`[hybrid] Trimming remove range start from ${remove.start_ms}ms to ${repl.end_ms}ms to protect post-replacement audio`)
        return { start_ms: repl.end_ms, end_ms: remove.end_ms }
      }
      return remove
    }).filter(r => r.end_ms > r.start_ms) // Remove empty ranges
  }

  console.log('[hybrid] Starting hybrid synthesis...')
  console.log('[hybrid] DSP filter:', dspFilterChain || '(none)')
  console.log('[hybrid] Replacements:', replacements.length)
  console.log('[hybrid] Remove ranges:', effectiveRemoves.length)

  // Detailed logging for debugging
  console.log('[hybrid] === REMOVE RANGES ===')
  effectiveRemoves.forEach((r, i) => {
    console.log(`[hybrid]   ${i}: ${r.start_ms}ms - ${r.end_ms}ms (${r.end_ms - r.start_ms}ms)`)
  })
  console.log('[hybrid] === REPLACEMENTS ===')
  replacements.forEach((r, i) => {
    console.log(`[hybrid]   ${i}: "${r.original_text}" → "${r.replacement_text}" at ${r.start_ms}ms - ${r.end_ms}ms`)
    // Log safety buffer info
    const bufferBefore = 100 // ms we should keep before replacement
    const safeStart = r.start_ms - bufferBefore
    console.log(`[hybrid]   ${i}: Audio before replacement should be preserved until ${safeStart}ms (${bufferBefore}ms buffer)`)
  })

  const voiceId = resolveVoiceId()
  console.log(`[hybrid] voiceId: ${voiceId}`)

  // Step 1: Extract audio and apply DSP
  console.log('[hybrid] Step 1: Extracting audio with DSP...')
  const dspFullPath = path.join(workDir, 'dsp-full.wav')
  await extractAudioWithDsp(videoAsset.file_path, dspFullPath, dspFilterChain)

  // Step 2: Synthesize replacement chunks FIRST (to know actual duration)
  console.log('[hybrid] Step 2: Synthesizing replacement words...')
  const synthChunks = await synthesizeReplacementChunks(replacements, voiceId, workDir, dspFullPath)

  // Step 3: Silence remove_ranges AND full synth regions (including overflow)
  const SYNTH_START_BUFFER_MS = 50 // Must match buildSynthPatchesTrack
  console.log('[hybrid] Step 3: Silencing removed + replacement regions...')
  const dspWithHolesPath = path.join(workDir, 'dsp-with-holes.wav')
  const silenceRegionsList = [
    ...effectiveRemoves.map(r => ({ start_ms: r.start_ms, end_ms: r.end_ms })),
    // Silence from original word (with small buffer) through end of synth
    ...synthChunks.map(chunk => ({
      start_ms: chunk.replacement.start_ms + SYNTH_START_BUFFER_MS,
      end_ms: chunk.replacement.start_ms + SYNTH_START_BUFFER_MS + chunk.synth_duration_ms
    }))
  ]
  console.log('[hybrid] === SILENCE REGIONS ===')
  silenceRegionsList.forEach((r, i) => {
    console.log(`[hybrid]   ${i}: ${r.start_ms}ms - ${r.end_ms}ms`)
  })
  await silenceRegions(dspFullPath, dspWithHolesPath, silenceRegionsList)

  // Step 4: Build synth patches track
  console.log('[hybrid] Step 4: Building synth patches track...')
  const synthPatchesPath = path.join(workDir, 'synth-patches.wav')
  await buildSynthPatchesTrack(synthChunks, videoAsset.duration_ms, workDir, synthPatchesPath)

  // Step 5: Mix DSP + synth
  console.log('[hybrid] Step 5: Mixing DSP and synth tracks...')
  const hybridAudioPath = path.join(workDir, 'hybrid-audio.wav')
  await mixDspAndSynth(dspWithHolesPath, synthPatchesPath, hybridAudioPath)

  // Step 6: Time-compress by extracting only keep_ranges
  console.log('[hybrid] Step 6: Time-compressing to match final export...')
  let keepRanges = invertToKeepRanges(effectiveRemoves, videoAsset.duration_ms)
  console.log('[hybrid] Keep ranges (before expansion):', keepRanges.length)

  // Expand keep ranges to include full synth audio (may be longer than original word)
  const SYNTH_POSITION_BUFFER_MS = 50 // Must match SYNTH_START_BUFFER_MS in buildSynthPatchesTrack
  for (const synth of synthChunks) {
    const repl = synth.replacement
    // Synth starts at repl.start_ms + buffer, runs for synth_duration_ms
    const synthEndMs = repl.start_ms + SYNTH_POSITION_BUFFER_MS + synth.synth_duration_ms

    for (let i = 0; i < keepRanges.length; i++) {
      const k = keepRanges[i]
      // If synth starts in this keep range but extends beyond it
      if (repl.start_ms >= k.start_ms && repl.start_ms < k.end_ms && synthEndMs > k.end_ms) {
        console.log(`[hybrid] Expanding keep range ${i} end from ${k.end_ms}ms to ${synthEndMs}ms to include full synth (${synth.synth_duration_ms}ms)`)
        keepRanges[i] = { start_ms: k.start_ms, end_ms: synthEndMs }
      }
    }
  }

  // Merge overlapping keep ranges (can happen when synth expansion overlaps with next range)
  keepRanges.sort((a, b) => a.start_ms - b.start_ms)
  const mergedRanges: Array<{ start_ms: number; end_ms: number }> = []
  for (const range of keepRanges) {
    if (mergedRanges.length === 0) {
      mergedRanges.push({ ...range })
    } else {
      const last = mergedRanges[mergedRanges.length - 1]
      // If this range overlaps or is adjacent to the last one, merge them
      if (range.start_ms <= last.end_ms) {
        console.log(`[hybrid] Merging overlapping keep ranges: ${last.start_ms}-${last.end_ms}ms + ${range.start_ms}-${range.end_ms}ms`)
        last.end_ms = Math.max(last.end_ms, range.end_ms)
      } else {
        mergedRanges.push({ ...range })
      }
    }
  }
  keepRanges = mergedRanges

  console.log('[hybrid] === KEEP RANGES (after expansion) ===')
  keepRanges.forEach((r, i) => {
    console.log(`[hybrid]   ${i}: ${r.start_ms}ms - ${r.end_ms}ms (${r.end_ms - r.start_ms}ms)`)
  })

  // Check if synth audio falls within keep ranges
  console.log('[hybrid] === SYNTH POSITIONS CHECK ===')
  synthChunks.forEach((synth, i) => {
    const synthStartMs = synth.replacement.start_ms + SYNTH_POSITION_BUFFER_MS
    const synthEndMs = synthStartMs + synth.synth_duration_ms
    const inKeepRange = keepRanges.some(k => synthStartMs >= k.start_ms && synthEndMs <= k.end_ms)
    console.log(`[hybrid]   Synth ${i} ("${synth.replacement.replacement_text}"): starts ${synthStartMs}ms, ${synth.synth_duration_ms}ms, ends at ${synthEndMs}ms - ${inKeepRange ? 'INSIDE' : 'OUTSIDE'} keep ranges`)
  })

  const segmentsDir = path.join(workDir, 'segments')
  if (!fs.existsSync(segmentsDir)) {
    fs.mkdirSync(segmentsDir, { recursive: true })
  }

  const segmentPaths: string[] = []

  for (let i = 0; i < keepRanges.length; i++) {
    const range = keepRanges[i]
    const segmentPath = path.join(segmentsDir, `segment-${i}.mp4`)
    const start_sec = range.start_ms / 1000
    const duration_sec = (range.end_ms - range.start_ms) / 1000

    console.log(`[hybrid] Extracting segment ${i + 1}/${keepRanges.length}: ${start_sec.toFixed(2)}s - ${(start_sec + duration_sec).toFixed(2)}s`)

    // Extract video segment with corresponding hybrid audio
    await runFFmpegCommand([
      '-y',
      '-ss', start_sec.toString(),
      '-t', duration_sec.toString(),
      '-i', videoAsset.file_path,
      '-ss', start_sec.toString(),
      '-t', duration_sec.toString(),
      '-i', hybridAudioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      segmentPath
    ])

    segmentPaths.push(segmentPath)
  }

  // Step 7: Concatenate segments
  console.log('[hybrid] Step 7: Concatenating segments...')
  const outputPath = path.join(workDir, 'preview-hybrid.mp4')

  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], outputPath)
  } else {
    const concatListPath = path.join(workDir, 'segment-concat-list.txt')
    fs.writeFileSync(concatListPath, segmentPaths.map(p => `file '${p}'`).join('\n'))

    await runFFmpegCommand([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      outputPath
    ])
  }

  console.log('[hybrid] Complete!')

  // Calculate totals
  const total_target_ms = synthChunks.reduce((sum, c) => sum + c.target_duration_ms, 0)
  const total_synth_ms = synthChunks.reduce((sum, c) => sum + c.synth_duration_ms, 0)

  return {
    outputPath,
    audioTrackPath: hybridAudioPath,
    chunks: synthChunks.length,
    total_target_ms,
    total_synth_ms,
    tempo_adjustments: 0  // Hybrid uses fitAudioToDuration internally
  }
}

// ============================================================================
// DELETE-ONLY MODE - Time-compress without TTS
// ============================================================================

export interface DeleteOnlyReport {
  outputPath: string
  segments: number
  original_duration_ms: number
  edited_duration_ms: number
}

/**
 * Delete-only preview - cuts out remove_ranges from video+audio without TTS
 * Used when user has deletions but no word replacements
 */
export async function renderDeleteOnlyPreview(
  videoAsset: VideoAsset,
  edl: EdlV1,
  dspFilterChain: string | null,
  workDir: string
): Promise<DeleteOnlyReport> {
  // Create work directory
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true })
  }

  const effectiveRemoves = buildEffectiveRemoveRanges(edl, videoAsset.duration_ms)
  const keepRanges = invertToKeepRanges(effectiveRemoves, videoAsset.duration_ms)

  console.log('[delete-only] Starting delete-only preview...')
  console.log('[delete-only] Remove ranges:', effectiveRemoves.length)
  console.log('[delete-only] Keep ranges:', keepRanges.length)

  if (keepRanges.length === 0) {
    throw new Error('No content to preview - all segments removed')
  }

  const segmentsDir = path.join(workDir, 'segments')
  if (!fs.existsSync(segmentsDir)) {
    fs.mkdirSync(segmentsDir, { recursive: true })
  }

  const segmentPaths: string[] = []

  // Extract each keep range as a segment
  for (let i = 0; i < keepRanges.length; i++) {
    const range = keepRanges[i]
    const segmentPath = path.join(segmentsDir, `segment-${i}.mp4`)
    const start_sec = range.start_ms / 1000
    const duration_sec = (range.end_ms - range.start_ms) / 1000

    console.log(`[delete-only] Extracting segment ${i + 1}/${keepRanges.length}: ${start_sec.toFixed(2)}s - ${(start_sec + duration_sec).toFixed(2)}s`)

    // Build FFmpeg args - with or without DSP filter
    const args = [
      '-y',
      '-ss', start_sec.toString(),
      '-t', duration_sec.toString(),
      '-i', videoAsset.file_path
    ]

    if (dspFilterChain) {
      args.push('-af', dspFilterChain)
    }

    args.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '192k',
      segmentPath
    )

    await runFFmpegCommand(args)
    segmentPaths.push(segmentPath)
  }

  // Concatenate segments
  console.log('[delete-only] Concatenating segments...')
  const outputPath = path.join(workDir, 'preview-delete-only.mp4')

  if (segmentPaths.length === 1) {
    fs.copyFileSync(segmentPaths[0], outputPath)
  } else {
    const concatListPath = path.join(workDir, 'concat-list.txt')
    fs.writeFileSync(concatListPath, segmentPaths.map(p => `file '${p}'`).join('\n'))

    await runFFmpegCommand([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      outputPath
    ])
  }

  // Calculate edited duration
  const edited_duration_ms = keepRanges.reduce((sum, r) => sum + (r.end_ms - r.start_ms), 0)

  console.log('[delete-only] Complete!')
  console.log(`[delete-only] Original: ${videoAsset.duration_ms}ms, Edited: ${edited_duration_ms}ms`)

  return {
    outputPath,
    segments: keepRanges.length,
    original_duration_ms: videoAsset.duration_ms,
    edited_duration_ms
  }
}
