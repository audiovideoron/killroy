/**
 * Manual test: Run with `npx tsx electron/tts/test-elevenlabs.ts`
 * Requires ELEVENLABS_API_KEY in environment
 */

import path from 'path'
import os from 'os'
import { synthesizeWithElevenLabs } from './elevenlabs'

const outPath = path.join(os.tmpdir(), 'elevenlabs-test.wav')

console.log('Testing ElevenLabs TTS...')
console.log('Output:', outPath)

synthesizeWithElevenLabs(
  'This is a test of ElevenLabs text to speech.',
  'EXAVITQu4vr4xnSDxMaL', // Sarah - default voice
  outPath
)
  .then(() => {
    console.log('SUCCESS: Audio written to', outPath)
    console.log('Play with: afplay', outPath)
  })
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exit(1)
  })
