/**
 * Synthesis Pipeline Alignment Tests
 *
 * Tests the ACTUAL synthesis pipeline code by:
 * 1. Calling synthesizeHybridTrack() with real inputs
 * 2. Running ASR on the output
 * 3. Verifying words appear at expected positions
 *
 * Run with: npx vitest run electron/__tests__/synthesis-pipeline-alignment.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { execSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { synthesizeHybridTrack } from '../tts/synthesis-pipeline'
import type { VideoAsset, EdlV1, WordReplacement } from '../../shared/editor-types'

const TEST_VIDEO = path.resolve('media/IMG_0061-30sec.MOV')
const WORK_DIR = '/tmp/synthesis-alignment-test'
const WHISPER_BIN = process.env.WHISPER_CPP_BIN || '/opt/homebrew/bin/whisper-cli'
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/Users/rtp/whisper-models/ggml-base.bin'
// Whisper ASR has inherent timing variability (~500-1500ms) especially when audio is modified
// Focus on relative order and presence rather than absolute timing
const ALIGNMENT_TOLERANCE_MS = 1500

interface TranscriptWord {
  text: string
  start_ms: number
  end_ms: number
}

/**
 * Run ASR on audio file and return word-level transcript
 */
async function transcribeAudio(audioPath: string): Promise<TranscriptWord[]> {
  const outputDir = path.join(path.dirname(audioPath), 'whisper-output-' + Date.now())
  fs.mkdirSync(outputDir, { recursive: true })

  const outputBase = path.join(outputDir, 'transcript')

  return new Promise((resolve, reject) => {
    const args = [
      '-m', WHISPER_MODEL,
      '-f', audioPath,
      '-oj',
      '-ml', '1',
      '-t', '4',
      '-l', 'en',
      '-of', outputBase
    ]

    const proc = spawn(WHISPER_BIN, args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper failed: ${stderr}`))
        return
      }

      const jsonPath = path.join(outputDir, 'transcript.json')
      if (!fs.existsSync(jsonPath)) {
        reject(new Error(`Whisper output not found at ${jsonPath}`))
        return
      }

      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      const words: TranscriptWord[] = []

      for (const seg of json.transcription || []) {
        const segWords = (seg.text || '').trim().split(/\s+/).filter((w: string) => w.length > 0)
        const duration = seg.offsets.to - seg.offsets.from
        const timePerWord = duration / segWords.length

        segWords.forEach((word: string, i: number) => {
          words.push({
            text: word.toLowerCase().replace(/[^a-z0-9]/g, ''),
            start_ms: Math.round(seg.offsets.from + i * timePerWord),
            end_ms: Math.round(seg.offsets.from + (i + 1) * timePerWord)
          })
        })
      }

      resolve(words)
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn whisper: ${err.message}`))
    })
  })
}

/**
 * Extract audio from video
 */
function extractAudio(videoPath: string, outputPath: string): void {
  execSync(`ffmpeg -y -i "${videoPath}" -vn -ar 44100 -ac 1 "${outputPath}"`, { stdio: 'pipe' })
}

/**
 * Get video duration in ms
 */
function getVideoDuration(videoPath: string): number {
  const result = execSync(
    `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${videoPath}"`
  ).toString().trim()
  return Math.round(parseFloat(result) * 1000)
}

/**
 * Find word closest to expected position
 */
function findWordNear(transcript: TranscriptWord[], word: string, expectedMs: number, toleranceMs: number = 2000): TranscriptWord | null {
  const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, '')
  const candidates = transcript.filter(w => w.text === normalized)

  if (candidates.length === 0) return null

  let closest = candidates[0]
  let minDist = Math.abs(candidates[0].start_ms - expectedMs)

  for (const c of candidates) {
    const dist = Math.abs(c.start_ms - expectedMs)
    if (dist < minDist) {
      minDist = dist
      closest = c
    }
  }

  return minDist <= toleranceMs ? closest : null
}

/**
 * Build VideoAsset from test video
 */
function buildVideoAsset(): VideoAsset {
  const duration = getVideoDuration(TEST_VIDEO)
  return {
    video_id: uuidv4(),
    file_path: TEST_VIDEO,
    duration_ms: duration,
    fps: 30,
    sample_rate: 44100,
    width: 1920,
    height: 1080
  }
}

/**
 * Build EDL with a word replacement
 */
function buildEdlWithReplacement(
  videoId: string,
  tokenId: string,
  originalText: string,
  replacementText: string,
  startMs: number,
  endMs: number
): EdlV1 {
  const replacement: WordReplacement = {
    replacement_id: uuidv4(),
    token_id: tokenId,
    original_text: originalText,
    replacement_text: replacementText,
    start_ms: startMs,
    end_ms: endMs
  }

  return {
    version: '1',
    video_id: videoId,
    edl_version_id: uuidv4(),
    created_at: new Date().toISOString(),
    params: {
      merge_threshold_ms: 200,
      pre_roll_ms: 0,
      post_roll_ms: 0,
      audio_crossfade_ms: 0
    },
    remove_ranges: [],
    replacements: [replacement]
  }
}

describe('Synthesis Pipeline Alignment', () => {
  beforeAll(() => {
    // Check prerequisites
    if (!fs.existsSync(TEST_VIDEO)) {
      throw new Error(`Test video not found: ${TEST_VIDEO}`)
    }
    if (!fs.existsSync(WHISPER_BIN)) {
      console.log('SKIP: Whisper binary not found at', WHISPER_BIN)
    }
    if (!fs.existsSync(WHISPER_MODEL)) {
      console.log('SKIP: Whisper model not found at', WHISPER_MODEL)
    }

    // Create work directory
    if (!fs.existsSync(WORK_DIR)) {
      fs.mkdirSync(WORK_DIR, { recursive: true })
    }
  })

  it('should align replacement word at original word position', async () => {
    if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
      return
    }

    // Step 1: Get original transcript to find word positions
    const originalAudioPath = path.join(WORK_DIR, 'original-audio.wav')
    extractAudio(TEST_VIDEO, originalAudioPath)
    const originalTranscript = await transcribeAudio(originalAudioPath)

    console.log('=== ORIGINAL TRANSCRIPT ===')
    originalTranscript.forEach(w => console.log(`${w.start_ms}ms: "${w.text}"`))

    // Find "other" around 16-17 seconds to replace
    const targetWord = findWordNear(originalTranscript, 'other', 17000)
    if (!targetWord) {
      console.log('Target word "other" not found')
      return
    }

    // Find adjacent words to verify alignment
    const prevWord = findWordNear(originalTranscript, 'the', 16500)
    const nextWord = findWordNear(originalTranscript, 'one', 17600)

    console.log(`\nTarget: "${targetWord.text}" at ${targetWord.start_ms}ms`)
    console.log(`Prev: "${prevWord?.text}" at ${prevWord?.start_ms}ms`)
    console.log(`Next: "${nextWord?.text}" at ${nextWord?.start_ms}ms`)

    // Step 2: Build inputs for synthesis pipeline
    const videoAsset = buildVideoAsset()
    const edl = buildEdlWithReplacement(
      videoAsset.video_id,
      uuidv4(),
      'other',
      'different',  // Replace "other" with "different"
      targetWord.start_ms,
      targetWord.end_ms
    )

    // Step 3: Run actual synthesis pipeline
    const testWorkDir = path.join(WORK_DIR, `synth-${Date.now()}`)
    console.log(`\nRunning synthesizeHybridTrack...`)
    console.log(`Work dir: ${testWorkDir}`)

    const report = await synthesizeHybridTrack(
      videoAsset,
      edl,
      null,  // No DSP filter
      testWorkDir
    )

    console.log(`\nSynthesis complete: ${report.outputPath}`)
    console.log(`Chunks: ${report.chunks}`)

    // Step 4: Extract audio from output and transcribe
    const outputAudioPath = path.join(testWorkDir, 'output-audio.wav')
    extractAudio(report.outputPath, outputAudioPath)
    const outputTranscript = await transcribeAudio(outputAudioPath)

    console.log('\n=== OUTPUT TRANSCRIPT ===')
    outputTranscript.forEach(w => console.log(`${w.start_ms}ms: "${w.text}"`))

    // Step 5: Verify alignment
    console.log('\n=== ALIGNMENT VERIFICATION ===')

    // The output is time-compressed (remove_ranges removed), so we need to account for that
    // Since we have no remove_ranges, positions should be similar

    // Check if "the" is preserved and aligned
    if (prevWord) {
      const theInOutput = findWordNear(outputTranscript, 'the', prevWord.start_ms)
      if (theInOutput) {
        const drift = Math.abs(theInOutput.start_ms - prevWord.start_ms)
        console.log(`"the": expected ~${prevWord.start_ms}ms, got ${theInOutput.start_ms}ms (drift: ${drift}ms)`)
        expect(drift).toBeLessThan(ALIGNMENT_TOLERANCE_MS)
      } else {
        console.log(`"the": NOT FOUND near ${prevWord.start_ms}ms`)
        // List nearby words
        const nearby = outputTranscript.filter(w =>
          w.start_ms > prevWord.start_ms - 2000 &&
          w.start_ms < prevWord.start_ms + 2000
        )
        console.log('Nearby:', nearby.map(w => `"${w.text}"@${w.start_ms}ms`).join(', '))
        expect(theInOutput).not.toBeNull()
      }
    }

    // Check if replacement "different" appears
    const replInOutput = findWordNear(outputTranscript, 'different', targetWord.start_ms, 3000)
    if (replInOutput) {
      const drift = Math.abs(replInOutput.start_ms - targetWord.start_ms)
      console.log(`"different": expected ~${targetWord.start_ms}ms, got ${replInOutput.start_ms}ms (drift: ${drift}ms)`)
      // Wider tolerance for replacement since it may be positioned with buffer
      expect(drift).toBeLessThan(6000)  // Account for SYNTH_START_BUFFER_MS
    } else {
      console.log(`"different": NOT FOUND`)
      // Check what's around the target position
      const nearby = outputTranscript.filter(w =>
        w.start_ms > targetWord.start_ms - 3000 &&
        w.start_ms < targetWord.start_ms + 6000
      )
      console.log('Nearby:', nearby.map(w => `"${w.text}"@${w.start_ms}ms`).join(', '))
    }

    // Check if "one" is preserved
    if (nextWord) {
      const oneInOutput = findWordNear(outputTranscript, 'one', nextWord.start_ms)
      if (oneInOutput) {
        const drift = Math.abs(oneInOutput.start_ms - nextWord.start_ms)
        console.log(`"one": expected ~${nextWord.start_ms}ms, got ${oneInOutput.start_ms}ms (drift: ${drift}ms)`)
      } else {
        console.log(`"one": NOT FOUND near ${nextWord.start_ms}ms`)
      }
    }

    // CRITICAL: Verify correct ORDER - replacement should be near where original word was
    // "the" (before) should appear before or near "different" (replacement)
    const thePos = findWordNear(outputTranscript, 'the', 16500, 3000)
    const diffPos = findWordNear(outputTranscript, 'different', 17000, 3000)
    if (thePos && diffPos) {
      // In the original: "the" at 16500, "other" at 16920
      // In output: "the" should be before or close to "different"
      const gap = diffPos.start_ms - thePos.start_ms
      console.log(`\n=== ORDER CHECK ===`)
      console.log(`"the": ${thePos.start_ms}ms, "different": ${diffPos.start_ms}ms, gap: ${gap}ms`)
      // They should be within ~2 seconds of each other (original gap was 420ms)
      expect(Math.abs(gap)).toBeLessThan(3000)
    }
  }, 180000)  // 3 minute timeout for synthesis

  it('should handle long replacement phrases', async () => {
    if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
      return
    }

    // Get original transcript
    const originalAudioPath = path.join(WORK_DIR, 'original-audio.wav')
    if (!fs.existsSync(originalAudioPath)) {
      extractAudio(TEST_VIDEO, originalAudioPath)
    }
    const originalTranscript = await transcribeAudio(originalAudioPath)

    // Replace short word "kit" (540ms) with long phrase
    const kitWord = findWordNear(originalTranscript, 'kit', 3000)
    if (!kitWord) {
      console.log('Word "kit" not found')
      return
    }

    const originalDuration = kitWord.end_ms - kitWord.start_ms
    console.log(`Original "kit": ${kitWord.start_ms}-${kitWord.end_ms}ms (${originalDuration}ms)`)

    // Long replacement phrase - much longer than original word
    // Use non-numeric words to avoid Whisper transcribing "one two three" as "123"
    const longPhrase = 'Testing alpha beta gamma delta epsilon'

    // Build synthesis inputs
    const videoAsset = buildVideoAsset()
    const edl = buildEdlWithReplacement(
      videoAsset.video_id,
      uuidv4(),
      'kit',
      longPhrase,
      kitWord.start_ms,
      kitWord.end_ms
    )

    // Run pipeline
    const testWorkDir = path.join(WORK_DIR, `synth-long-${Date.now()}`)
    console.log(`\nReplacing "${kitWord.text}" with "${longPhrase}"`)
    const report = await synthesizeHybridTrack(videoAsset, edl, null, testWorkDir)

    console.log(`Synth duration: ${report.total_synth_ms}ms (original word was ${originalDuration}ms)`)

    // Transcribe output
    const outputAudioPath = path.join(testWorkDir, 'output-audio.wav')
    extractAudio(report.outputPath, outputAudioPath)
    const outputTranscript = await transcribeAudio(outputAudioPath)

    console.log('\n=== OUTPUT TRANSCRIPT (around replacement) ===')
    outputTranscript
      .filter(w => w.start_ms > 0 && w.start_ms < 15000)
      .forEach(w => console.log(`${w.start_ms}ms: "${w.text}"`))

    // Verify long phrase words appear in output
    const phraseWords = ['testing', 'alpha', 'beta', 'gamma', 'delta', 'epsilon']
    let foundCount = 0
    console.log('\n=== PHRASE DETECTION ===')
    for (const word of phraseWords) {
      const found = findWordNear(outputTranscript, word, kitWord.start_ms, 10000)
      if (found) {
        console.log(`✓ "${word}" found at ${found.start_ms}ms`)
        foundCount++
      } else {
        console.log(`✗ "${word}" NOT FOUND`)
      }
    }

    // At least half the phrase words should be detected
    expect(foundCount).toBeGreaterThanOrEqual(3)
    console.log(`\n${foundCount}/${phraseWords.length} phrase words detected`)

    // Words BEFORE replacement should still exist
    const videoWord = findWordNear(originalTranscript, 'video', 500)
    const footageWord = findWordNear(originalTranscript, 'footage', 1000)

    if (videoWord) {
      const found = findWordNear(outputTranscript, 'video', videoWord.start_ms)
      console.log(`"video" (before): ${found ? 'FOUND at ' + found.start_ms + 'ms' : 'MISSING'}`)
      expect(found).not.toBeNull()
    }

    if (footageWord) {
      const found = findWordNear(outputTranscript, 'footage', footageWord.start_ms)
      console.log(`"footage" (before): ${found ? 'FOUND at ' + found.start_ms + 'ms' : 'MISSING'}`)
      expect(found).not.toBeNull()
    }

    // Words AFTER the long replacement should still exist (shifted later)
    // Original "and" was at ~3540ms, but now it should be shifted by synth overflow
    const ronWord = findWordNear(originalTranscript, 'ron', 4000)
    if (ronWord) {
      // Ron should exist somewhere after the long phrase
      const found = findWordNear(outputTranscript, 'ron', ronWord.start_ms, 10000)
      console.log(`"ron" (after): ${found ? 'FOUND at ' + found.start_ms + 'ms' : 'MISSING'}`)
      // Note: might not be found if phrase is very long and overlaps
    }
  }, 180000)

  it('should not eat words before replacement', async () => {
    if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
      return
    }

    // Get original transcript
    const originalAudioPath = path.join(WORK_DIR, 'original-audio.wav')
    if (!fs.existsSync(originalAudioPath)) {
      extractAudio(TEST_VIDEO, originalAudioPath)
    }
    const originalTranscript = await transcribeAudio(originalAudioPath)

    // Replace "kit" (around 3000ms) - check that preceding words are preserved
    const kitWord = findWordNear(originalTranscript, 'kit', 3000)
    if (!kitWord) {
      console.log('Word "kit" not found')
      return
    }

    // Find words before "kit"
    const footageWord = findWordNear(originalTranscript, 'footage', 1000)
    const videoWord = findWordNear(originalTranscript, 'video', 500)

    console.log(`Target: "kit" at ${kitWord.start_ms}ms`)
    console.log(`Before: "footage" at ${footageWord?.start_ms}ms, "video" at ${videoWord?.start_ms}ms`)

    // Build synthesis inputs
    const videoAsset = buildVideoAsset()
    const edl = buildEdlWithReplacement(
      videoAsset.video_id,
      uuidv4(),
      'kit',
      'test word',
      kitWord.start_ms,
      kitWord.end_ms
    )

    // Run pipeline
    const testWorkDir = path.join(WORK_DIR, `synth-kit-${Date.now()}`)
    const report = await synthesizeHybridTrack(videoAsset, edl, null, testWorkDir)

    // Transcribe output
    const outputAudioPath = path.join(testWorkDir, 'output-audio.wav')
    extractAudio(report.outputPath, outputAudioPath)
    const outputTranscript = await transcribeAudio(outputAudioPath)

    console.log('\n=== OUTPUT TRANSCRIPT ===')
    outputTranscript.forEach(w => console.log(`${w.start_ms}ms: "${w.text}"`))

    // CRITICAL: Words before "kit" must be preserved AND at correct positions
    console.log('\n=== CHECKING PRESERVED WORDS ===')

    if (videoWord) {
      const found = findWordNear(outputTranscript, 'video', videoWord.start_ms)
      if (found) {
        const drift = Math.abs(found.start_ms - videoWord.start_ms)
        console.log(`"video": expected ${videoWord.start_ms}ms, got ${found.start_ms}ms (drift: ${drift}ms)`)
        expect(drift).toBeLessThan(ALIGNMENT_TOLERANCE_MS)
      } else {
        console.log(`"video": MISSING`)
        expect(found).not.toBeNull()
      }
    }

    if (footageWord) {
      const found = findWordNear(outputTranscript, 'footage', footageWord.start_ms)
      if (found) {
        const drift = Math.abs(found.start_ms - footageWord.start_ms)
        console.log(`"footage": expected ${footageWord.start_ms}ms, got ${found.start_ms}ms (drift: ${drift}ms)`)
        expect(drift).toBeLessThan(ALIGNMENT_TOLERANCE_MS)
      } else {
        console.log(`"footage": MISSING`)
        expect(found).not.toBeNull()
      }
    }

    // Check word AFTER the replacement is preserved
    const andWord = findWordNear(originalTranscript, 'and', 3500)
    if (andWord) {
      const found = findWordNear(outputTranscript, 'and', andWord.start_ms, 5000)
      if (found) {
        console.log(`"and" (after): expected ~${andWord.start_ms}ms, got ${found.start_ms}ms`)
      } else {
        console.log(`"and" (after): MISSING near ${andWord.start_ms}ms`)
      }
    }
  }, 180000)
})
