/**
 * End-to-end synthesis test with ElevenLabs STT
 * Tests: transcribe → mark replacement → synthesize → verify alignment
 */

import * as fs from 'fs'
import * as path from 'path'
import { ElevenLabsTranscriber } from '../asr/ElevenLabsTranscriber'
import { synthesizeHybridTrack } from '../tts/synthesis-pipeline'
import type { EdlV1, VideoAsset, WordReplacement } from '../../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'

async function main() {
  const videoPath = '/Users/rtp/audio_pro/media/kilroy-edited.mp4'
  const workDir = '/tmp/e2e-synthesis-test'

  // Clean up previous run
  if (fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true })
  }
  fs.mkdirSync(workDir, { recursive: true })

  console.log('=== E2E SYNTHESIS TEST ===\n')

  // Step 1: Transcribe with ElevenLabs (real word timestamps)
  console.log('Step 1: Transcribing with ElevenLabs STT...')
  const transcriber = new ElevenLabsTranscriber()
  const transcript = await transcriber.transcribe(videoPath, 'test-video')

  console.log(`\nTranscript: ${transcript.tokens.length} words`)
  console.log('First 10 words:')
  transcript.tokens.slice(0, 10).forEach((t, i) => {
    console.log(`  ${i}: [${t.start_ms}-${t.end_ms}] "${t.text}"`)
  })

  // Step 2: Pick a word to replace (let's find "audio" or "video")
  const targetWord = transcript.tokens.find(t =>
    t.text.toLowerCase().includes('audio') ||
    t.text.toLowerCase().includes('video') ||
    t.text.toLowerCase().includes('repair')
  )

  if (!targetWord) {
    console.log('\nNo suitable word found for replacement test')
    return
  }

  console.log(`\nStep 2: Selected word for replacement:`)
  console.log(`  Original: "${targetWord.text}" at ${targetWord.start_ms}-${targetWord.end_ms}ms`)

  // Step 3: Create EDL with replacement
  const replacement: WordReplacement = {
    replacement_id: uuidv4(),
    token_id: targetWord.token_id,
    original_text: targetWord.text,
    replacement_text: 'REPLACED',  // Will be synthesized
    start_ms: targetWord.start_ms,
    end_ms: targetWord.end_ms
  }

  const edl: EdlV1 = {
    version: '1',
    video_id: 'test-video',
    edl_version_id: uuidv4(),
    created_at: new Date().toISOString(),
    params: {
      merge_threshold_ms: 200,
      pre_roll_ms: 50,
      post_roll_ms: 50,
      audio_crossfade_ms: 10
    },
    remove_ranges: [],
    replacements: [replacement]
  }

  console.log(`\nStep 3: Created EDL with replacement:`)
  console.log(`  "${replacement.original_text}" → "${replacement.replacement_text}"`)
  console.log(`  Position: ${replacement.start_ms}-${replacement.end_ms}ms`)

  // Step 4: Get video metadata (simplified)
  const videoAsset: VideoAsset = {
    video_id: 'test-video',
    file_path: videoPath,
    duration_ms: 10000,  // Approximate - will be refined by pipeline
    fps: 30,
    sample_rate: 44100,
    width: 1920,
    height: 1080
  }

  // Step 5: Run synthesis
  console.log(`\nStep 4: Running hybrid synthesis...`)
  const report = await synthesizeHybridTrack(videoAsset, edl, null, workDir)

  console.log('\n=== SYNTHESIS COMPLETE ===')
  console.log(`Output: ${report.outputPath}`)
  console.log(`Chunks: ${report.chunks}`)
  console.log(`Target duration: ${report.total_target_ms}ms`)
  console.log(`Synth duration: ${report.total_synth_ms}ms`)

  // Verify output exists
  if (fs.existsSync(report.outputPath)) {
    const stats = fs.statSync(report.outputPath)
    console.log(`\nOutput file size: ${(stats.size / 1024).toFixed(1)} KB`)
    console.log('✓ Success - play the output to verify alignment')
    console.log(`  open ${report.outputPath}`)
  } else {
    console.log('\n✗ Output file not created')
  }
}

main().catch(console.error)
