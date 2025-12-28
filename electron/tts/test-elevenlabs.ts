/**
 * Manual test: Run with `npx tsx electron/tts/test-elevenlabs.ts`
 * Requires ELEVENLABS_API_KEY in environment
 */

import path from 'path'
import os from 'os'
import { synthesizeWithElevenLabs } from './elevenlabs'
import { probeAudioDuration } from '../media-metadata'

// Request with .wav extension - will be corrected if MP3 is returned
const requestedPath = path.join(os.tmpdir(), 'elevenlabs-test.wav')

console.log('Testing ElevenLabs TTS...')
console.log('Requested:', requestedPath)

synthesizeWithElevenLabs(
  'This is a test of ElevenLabs text to speech.',
  'EXAVITQu4vr4xnSDxMaL', // Sarah - default voice
  requestedPath
)
  .then(async (finalPath) => {
    const duration_ms = await probeAudioDuration(finalPath)
    console.log('SUCCESS: Audio written to', finalPath)
    console.log('Duration:', duration_ms, 'ms')
    console.log('Play with: afplay', finalPath)
  })
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exit(1)
  })
