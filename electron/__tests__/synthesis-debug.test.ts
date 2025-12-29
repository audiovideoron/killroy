/**
 * Synthesis Pipeline Debug Test
 *
 * Automated test to verify word replacement doesn't eat adjacent words.
 * Run with: npx vitest run electron/__tests__/synthesis-debug.test.ts
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

const TEST_VIDEO = 'media/IMG_0061-30sec.MOV'
const WORK_DIR = '/tmp/synthesis-debug-test'

// Helper to run FFmpeg and get volume at a specific position
function getVolumeAt(audioPath: string, startSec: number, durationSec: number): number {
  const cmd = `ffmpeg -i "${audioPath}" -ss ${startSec} -t ${durationSec} -af "volumedetect" -f null /dev/null 2>&1 | grep "mean_volume" | sed 's/.*mean_volume: //' | sed 's/ dB//'`
  const result = execSync(cmd, { encoding: 'utf-8' }).trim()
  return parseFloat(result)
}

// Helper to probe audio duration
function getAudioDuration(audioPath: string): number {
  const cmd = `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${audioPath}"`
  const result = execSync(cmd, { encoding: 'utf-8' }).trim()
  return parseFloat(result)
}

// Helper to extract audio from video
function extractAudio(videoPath: string, outputPath: string): void {
  execSync(`ffmpeg -y -i "${videoPath}" -vn -ar 44100 -ac 1 "${outputPath}"`, { stdio: 'pipe' })
}

// Helper to silence a region
function silenceRegion(inputPath: string, outputPath: string, startMs: number, endMs: number): void {
  const startSec = startMs / 1000
  const endSec = endMs / 1000
  const filter = `volume=enable='between(t,${startSec},${endSec})':volume=0`
  execSync(`ffmpeg -y -i "${inputPath}" -af "${filter}" "${outputPath}"`, { stdio: 'pipe' })
}

describe('Synthesis Adjacent Word Preservation', () => {
  const workDir = WORK_DIR

  beforeAll(() => {
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true })
    }
  })

  it('should NOT silence words before a replacement', () => {
    // Simulate: "the other" where "other" is at 16920-17620ms
    // "the" should be at ~16500-16920ms
    // When we silence "other" (16920-17620ms), "the" should remain audible

    const testAudio = path.join(workDir, 'test-audio.wav')
    const silencedAudio = path.join(workDir, 'silenced-audio.wav')

    // Extract audio from test video
    extractAudio(TEST_VIDEO, testAudio)

    // Silence the replacement region (simulating "other" at 16920-17620ms)
    silenceRegion(testAudio, silencedAudio, 16920, 17620)

    // Check volume at position where "the" should be (16500-16920ms)
    const originalVolume = getVolumeAt(testAudio, 16.5, 0.4)
    const silencedVolume = getVolumeAt(silencedAudio, 16.5, 0.4)

    console.log(`Original volume at 16.5-16.9s: ${originalVolume} dB`)
    console.log(`Silenced volume at 16.5-16.9s: ${silencedVolume} dB`)

    // Volume difference should be minimal (< 3dB) - "the" should still be there
    const volumeDiff = Math.abs(originalVolume - silencedVolume)
    expect(volumeDiff).toBeLessThan(3)

    // The silenced region (16.92-17.62s) should be much quieter
    const silencedRegionVolume = getVolumeAt(silencedAudio, 16.92, 0.7)
    console.log(`Silenced region (16.92-17.62s): ${silencedRegionVolume} dB`)

    // Silenced region should be much quieter than original
    expect(silencedRegionVolume).toBeLessThan(originalVolume - 20)
  })

  it('should preserve audio before replacement in final output', () => {
    // This test checks the full pipeline output
    const previewPath = '/var/folders/k5/jd5z06210n74l21wjc2ll9hm0000gn/T/synth-1766938716610/preview-hybrid.mp4'

    if (!fs.existsSync(previewPath)) {
      console.log('Skipping - no preview file from recent synthesis')
      return
    }

    // Position 16.5s in original -> 13.46s in output (after removing 3.04s intro)
    const outputPosition = 16.5 - 3.04 // = 13.46s

    const volume = getVolumeAt(previewPath, outputPosition, 0.4)
    console.log(`Preview volume at ${outputPosition}s: ${volume} dB`)

    // Should have audible audio (not silence)
    expect(volume).toBeGreaterThan(-50) // -50dB would be essentially silent
  })
})

describe('Timestamp Analysis', () => {
  it('should identify word boundaries around replacement', () => {
    // Analyze the audio to find where speech starts/stops
    const testAudio = path.join(WORK_DIR, 'test-audio.wav')

    if (!fs.existsSync(testAudio)) {
      extractAudio(TEST_VIDEO, testAudio)
    }

    // Check volume in 100ms windows around the replacement boundary
    console.log('\n=== Volume analysis around 16920ms (replacement start) ===')
    for (let t = 16.0; t <= 17.5; t += 0.1) {
      const vol = getVolumeAt(testAudio, t, 0.1)
      const marker = (t >= 16.92 && t < 17.62) ? ' [REPLACEMENT ZONE]' : ''
      console.log(`${t.toFixed(1)}s: ${vol.toFixed(1)} dB${marker}`)
    }
  })
})
