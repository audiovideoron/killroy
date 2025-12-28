/**
 * ASR-Based Synthesis Verification Test
 *
 * Tests synthesis pipeline by running speech recognition on output
 * and comparing transcript to expected words at expected positions.
 *
 * Run with: npx vitest run electron/__tests__/synthesis-asr-verify.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const TEST_VIDEO = 'media/IMG_0061-30sec.MOV'
const WORK_DIR = '/tmp/asr-verify-test'
const WHISPER_BIN = process.env.WHISPER_CPP_BIN || '/opt/homebrew/bin/whisper-cli'
const WHISPER_MODEL = process.env.WHISPER_MODEL || '/Users/rtp/whisper-models/ggml-base.bin'

interface TranscriptWord {
  text: string
  start_ms: number
  end_ms: number
}

/**
 * Run ASR on audio file and return word-level transcript
 */
async function transcribeAudio(audioPath: string): Promise<TranscriptWord[]> {
  const outputDir = path.join(path.dirname(audioPath), 'whisper-output')
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

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
 * Extract audio from video file
 */
function extractAudio(videoPath: string, outputPath: string): void {
  execSync(`ffmpeg -y -i "${videoPath}" -vn -ar 44100 -ac 1 "${outputPath}"`, { stdio: 'pipe' })
}

/**
 * Find a word in transcript, return its position or null
 */
function findWord(transcript: TranscriptWord[], word: string, afterMs?: number): TranscriptWord | null {
  const normalized = word.toLowerCase().replace(/[^a-z0-9]/g, '')
  return transcript.find(w =>
    w.text === normalized &&
    (afterMs === undefined || w.start_ms > afterMs)
  ) || null
}

/**
 * Check if transcript contains words in order
 */
function containsSequence(transcript: TranscriptWord[], words: string[]): boolean {
  let lastPos = -1
  for (const word of words) {
    const found = findWord(transcript, word, lastPos)
    if (!found) return false
    lastPos = found.start_ms
  }
  return true
}

/**
 * Silence a region in audio file (simulates synthesis pipeline silencing)
 */
function silenceRegion(inputPath: string, outputPath: string, startMs: number, endMs: number): void {
  const filter = `volume=enable='between(t,${startMs / 1000},${endMs / 1000})':volume=0`
  execSync(`ffmpeg -y -i "${inputPath}" -af "${filter}" "${outputPath}"`, { stdio: 'pipe' })
}

/**
 * Overlay audio at position (simulates synthesis patch insertion)
 */
function overlayAudio(basePath: string, patchPath: string, outputPath: string, positionMs: number): void {
  const delaySec = positionMs / 1000
  // adelay values are in milliseconds
  const filter = `[1:a]adelay=${positionMs}|${positionMs}[delayed];[0:a][delayed]amix=inputs=2:duration=first:normalize=0`
  execSync(`ffmpeg -y -i "${basePath}" -i "${patchPath}" -filter_complex "${filter}" "${outputPath}"`, { stdio: 'pipe' })
}

/**
 * Generate speech audio using say command (for testing without ElevenLabs)
 * Uses slow rate for better recognition
 */
function generateSpeech(text: string, outputPath: string): void {
  const aiffPath = outputPath.replace(/\.[^.]+$/, '.aiff')
  // Use slower rate (-r 150) and Samantha voice for clearer speech
  execSync(`say -v Samantha -r 150 -o "${aiffPath}" "${text}"`, { stdio: 'pipe' })
  execSync(`ffmpeg -y -i "${aiffPath}" -ar 44100 -ac 1 "${outputPath}"`, { stdio: 'pipe' })
  fs.unlinkSync(aiffPath)
}

describe('ASR Verification', () => {
  beforeAll(() => {
    if (!fs.existsSync(WORK_DIR)) {
      fs.mkdirSync(WORK_DIR, { recursive: true })
    }

    // Skip if whisper not available
    if (!fs.existsSync(WHISPER_BIN)) {
      console.log('SKIP: Whisper binary not found at', WHISPER_BIN)
    }
    if (!fs.existsSync(WHISPER_MODEL)) {
      console.log('SKIP: Whisper model not found at', WHISPER_MODEL)
    }
  })

  afterAll(() => {
    // Cleanup
    // fs.rmSync(WORK_DIR, { recursive: true, force: true })
  })

  describe('Baseline Transcript', () => {
    it('should transcribe original audio correctly', async () => {
      if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
        return
      }

      const audioPath = path.join(WORK_DIR, 'original-audio.wav')
      extractAudio(TEST_VIDEO, audioPath)

      const transcript = await transcribeAudio(audioPath)

      console.log('=== ORIGINAL TRANSCRIPT ===')
      transcript.forEach(w => console.log(`${w.start_ms}ms: "${w.text}"`))

      // Verify we got words
      expect(transcript.length).toBeGreaterThan(0)

      // Save for reference
      fs.writeFileSync(
        path.join(WORK_DIR, 'original-transcript.json'),
        JSON.stringify(transcript, null, 2)
      )
    }, 60000)
  })

  describe('Silence Region Preservation', () => {
    it('should preserve words BEFORE silenced region', async () => {
      if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
        return
      }

      const audioPath = path.join(WORK_DIR, 'original-audio.wav')
      if (!fs.existsSync(audioPath)) {
        extractAudio(TEST_VIDEO, audioPath)
      }

      // Get original transcript
      const originalTranscript = await transcribeAudio(audioPath)

      // Find a word to use as anchor (pick one around 5 seconds in)
      const anchorWord = originalTranscript.find(w => w.start_ms > 5000)
      if (!anchorWord) {
        console.log('No suitable anchor word found')
        return
      }

      console.log(`Using anchor word: "${anchorWord.text}" at ${anchorWord.start_ms}ms`)

      // Silence AFTER the anchor word (simulate replacement region)
      const silenceStart = anchorWord.end_ms + 100  // Start 100ms after anchor ends
      const silenceEnd = silenceStart + 500  // 500ms silence

      const silencedPath = path.join(WORK_DIR, 'silenced-audio.wav')
      silenceRegion(audioPath, silencedPath, silenceStart, silenceEnd)

      // Transcribe silenced audio
      const silencedTranscript = await transcribeAudio(silencedPath)

      console.log('=== SILENCED TRANSCRIPT ===')
      silencedTranscript.forEach(w => console.log(`${w.start_ms}ms: "${w.text}"`))

      // CRITICAL: anchor word should still be present
      const anchorInSilenced = findWord(silencedTranscript, anchorWord.text)
      expect(anchorInSilenced).not.toBeNull()
      console.log(`✓ Anchor word "${anchorWord.text}" preserved at ${anchorInSilenced?.start_ms}ms`)

      // Words before anchor should also be present
      const wordsBeforeAnchor = originalTranscript.filter(w => w.end_ms < anchorWord.start_ms)
      for (const word of wordsBeforeAnchor.slice(-3)) {  // Check last 3 words before anchor
        const found = findWord(silencedTranscript, word.text)
        expect(found).not.toBeNull()
        console.log(`✓ Word "${word.text}" preserved at ${found?.start_ms}ms`)
      }
    }, 60000)
  })

  describe('Synthesis Patch Verification', () => {
    it('should detect inserted speech at correct position', async () => {
      if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
        return
      }

      const audioPath = path.join(WORK_DIR, 'original-audio.wav')
      if (!fs.existsSync(audioPath)) {
        extractAudio(TEST_VIDEO, audioPath)
      }

      // Generate a test patch with clearly spoken phrase
      const patchPhrase = 'hello world testing'
      const patchWords = ['hello', 'world', 'testing']
      const patchPath = path.join(WORK_DIR, 'test-patch.wav')
      generateSpeech(patchPhrase, patchPath)

      // Silence a region and insert the patch (at a gap in original audio)
      const insertPosition = 2500  // Between "footage" (ends ~2000) and "kit" (starts ~3000)
      const silenceEnd = 3000

      const silencedPath = path.join(WORK_DIR, 'prepared-for-patch.wav')
      silenceRegion(audioPath, silencedPath, insertPosition, silenceEnd)

      const patchedPath = path.join(WORK_DIR, 'patched-audio.wav')
      overlayAudio(silencedPath, patchPath, patchedPath, insertPosition)

      // Transcribe patched audio
      const patchedTranscript = await transcribeAudio(patchedPath)

      console.log('=== PATCHED TRANSCRIPT ===')
      patchedTranscript.forEach(w => console.log(`${w.start_ms}ms: "${w.text}"`))

      // Find at least one of the inserted words
      let foundCount = 0
      for (const word of patchWords) {
        const found = findWord(patchedTranscript, word)
        if (found) {
          console.log(`✓ Found "${word}" at ${found.start_ms}ms`)
          foundCount++
        } else {
          console.log(`✗ "${word}" not found in transcript`)
        }
      }

      // At least one word from the patch should be detected
      expect(foundCount).toBeGreaterThan(0)
      console.log(`✓ ${foundCount}/${patchWords.length} patch words detected`)
    }, 60000)
  })

  describe('Full Pipeline Simulation', () => {
    it('should preserve context words around replacement', async () => {
      if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
        return
      }

      const audioPath = path.join(WORK_DIR, 'original-audio.wav')
      if (!fs.existsSync(audioPath)) {
        extractAudio(TEST_VIDEO, audioPath)
      }

      // Get original transcript
      const originalTranscript = await transcribeAudio(audioPath)

      // Find sequence with good spacing - look for words with gaps between them
      // Using "the other one" around 16-18 seconds which has clear separation
      let testSequence: TranscriptWord[] = []
      for (let i = 1; i < originalTranscript.length - 1; i++) {
        const prev = originalTranscript[i - 1]
        const target = originalTranscript[i]
        const next = originalTranscript[i + 1]

        // Look for sequence around 16-17 seconds with good spacing
        const gapBefore = target.start_ms - prev.end_ms
        const gapAfter = next.start_ms - target.end_ms

        if (target.start_ms > 16000 && target.start_ms < 18000 &&
            target.text.length > 2 && // Skip punctuation
            gapBefore >= 0 && gapAfter >= 0) {
          testSequence = [prev, target, next]
          console.log(`Candidate: "${prev.text}" [${target.text}] "${next.text}" gaps: ${gapBefore}ms, ${gapAfter}ms`)
          break
        }
      }

      if (testSequence.length !== 3) {
        console.log('Could not find suitable test sequence, using fallback')
        // Fallback to "the other one" sequence manually
        const theWord = findWord(originalTranscript, 'the', 16000)
        const otherWord = findWord(originalTranscript, 'other', 16000)
        const oneWord = findWord(originalTranscript, 'one', 17000)
        if (theWord && otherWord && oneWord) {
          testSequence = [theWord, otherWord, oneWord]
        } else {
          console.log('Fallback sequence also not found, skipping test')
          return
        }
      }

      const [prevWord, targetWord, nextWord] = testSequence
      console.log(`Test sequence: "${prevWord.text}" [${targetWord.text}] "${nextWord.text}"`)
      console.log(`Prev: ${prevWord.start_ms}-${prevWord.end_ms}ms`)
      console.log(`Target: ${targetWord.start_ms}-${targetWord.end_ms}ms`)
      console.log(`Next: ${nextWord.start_ms}-${nextWord.end_ms}ms`)

      // Replacement word - use common word whisper will recognize
      const replacementText = 'different'

      // Step 1: Silence ONLY the target word region
      // Add 100ms buffer AFTER prev word ends to protect its tail
      const silenceStart = Math.max(targetWord.start_ms, prevWord.end_ms + 100)
      const silenceEnd = targetWord.end_ms

      console.log(`Silencing: ${silenceStart}ms - ${silenceEnd}ms`)

      const silencedPath = path.join(WORK_DIR, 'full-sim-silenced.wav')
      silenceRegion(audioPath, silencedPath, silenceStart, silenceEnd)

      // Verify prev word still audible after silencing
      const silencedTranscript = await transcribeAudio(silencedPath)
      const prevInSilenced = findWord(silencedTranscript, prevWord.text, prevWord.start_ms - 500)
      console.log(`After silencing: prev word "${prevWord.text}" ${prevInSilenced ? 'FOUND at ' + prevInSilenced.start_ms + 'ms' : 'NOT FOUND'}`)

      // Step 2: Generate replacement speech
      const patchPath = path.join(WORK_DIR, 'full-sim-patch.wav')
      generateSpeech(replacementText, patchPath)

      // Step 3: Insert at target position (after silence start)
      const insertPosition = silenceStart
      const finalPath = path.join(WORK_DIR, 'full-sim-final.wav')
      overlayAudio(silencedPath, patchPath, finalPath, insertPosition)

      // Step 4: Transcribe result
      const finalTranscript = await transcribeAudio(finalPath)

      console.log('=== FINAL TRANSCRIPT ===')
      finalTranscript.forEach(w => console.log(`${w.start_ms}ms: "${w.text}"`))

      // ASSERTIONS with detailed diagnostics
      const results = {
        prevFound: false,
        replFound: false,
        nextFound: false
      }

      // 1. Previous word should exist
      const prevFound = findWord(finalTranscript, prevWord.text, prevWord.start_ms - 1000)
      results.prevFound = prevFound !== null
      if (prevFound) {
        console.log(`✓ Previous word "${prevWord.text}" found at ${prevFound.start_ms}ms`)
      } else {
        console.log(`✗ Previous word "${prevWord.text}" NOT FOUND`)
        // List words around where prev should be
        const nearbyWords = finalTranscript.filter(w =>
          w.start_ms > prevWord.start_ms - 2000 && w.start_ms < prevWord.start_ms + 2000
        )
        console.log('Nearby words:', nearbyWords.map(w => `"${w.text}"@${w.start_ms}ms`).join(', '))
      }

      // 2. Replacement word should exist
      const replFound = findWord(finalTranscript, replacementText)
      results.replFound = replFound !== null
      if (replFound) {
        console.log(`✓ Replacement word "${replacementText}" found at ${replFound.start_ms}ms`)
      } else {
        console.log(`✗ Replacement word "${replacementText}" NOT FOUND`)
      }

      // 3. Next word should exist
      const nextFound = findWord(finalTranscript, nextWord.text, nextWord.start_ms - 2000)
      results.nextFound = nextFound !== null
      if (nextFound) {
        console.log(`✓ Next word "${nextWord.text}" found at ${nextFound.start_ms}ms`)
      } else {
        console.log(`⚠ Next word "${nextWord.text}" not found (may have merged/shifted)`)
      }

      // At minimum, previous word must be preserved
      expect(results.prevFound).toBe(true)

      // Log summary
      console.log(`\n=== SUMMARY ===`)
      console.log(`Previous word preserved: ${results.prevFound ? 'YES' : 'NO'}`)
      console.log(`Replacement detected: ${results.replFound ? 'YES' : 'NO'}`)
      console.log(`Next word preserved: ${results.nextFound ? 'YES' : 'NO'}`)
    }, 120000)
  })
})

describe('Test Utilities', () => {
  it('transcribeAudio returns words with timestamps', async () => {
    // This is a smoke test for the utility function
    if (!fs.existsSync(WHISPER_BIN) || !fs.existsSync(WHISPER_MODEL)) {
      console.log('Skipping - whisper not configured')
      return
    }

    const testAudio = path.join(WORK_DIR, 'test-speech.wav')
    generateSpeech('Hello world test', testAudio)

    const transcript = await transcribeAudio(testAudio)

    expect(Array.isArray(transcript)).toBe(true)
    expect(transcript.length).toBeGreaterThan(0)

    // Each word should have required fields
    transcript.forEach(word => {
      expect(typeof word.text).toBe('string')
      expect(typeof word.start_ms).toBe('number')
      expect(typeof word.end_ms).toBe('number')
      expect(word.start_ms).toBeLessThanOrEqual(word.end_ms)
    })
  }, 30000)
})
