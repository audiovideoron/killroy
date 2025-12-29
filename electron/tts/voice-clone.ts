/**
 * Voice Cloning Module
 * Extracts voice sample from video and creates a cloned voice via ElevenLabs API
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { spawn } from 'child_process'
import fetch from 'node-fetch'
import FormData from 'form-data'

const ELEVENLABS_VOICES_API = 'https://api.elevenlabs.io/v1/voices/add'

// Sample extraction settings
const SAMPLE_START_SEC = 10
const SAMPLE_DURATION_SEC = 20

export interface VoiceCloneResult {
  success: boolean
  voice_id?: string
  voice_name?: string
  error?: string
}

/**
 * Extract a clean voice sample from video using FFmpeg
 * Target: mono, 16kHz, normalized WAV
 */
async function extractVoiceSample(videoPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', SAMPLE_START_SEC.toString(),
      '-t', SAMPLE_DURATION_SEC.toString(),
      '-i', videoPath,
      '-vn',           // no video
      '-ac', '1',      // mono
      '-ar', '16000',  // 16kHz (safe for voice cloning)
      '-af', 'loudnorm', // normalize levels
      outputPath
    ]

    const proc = spawn('ffmpeg', args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFmpeg sample extraction failed: ${stderr.slice(-500)}`))
      } else {
        resolve()
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`FFmpeg not found. Please install ffmpeg: ${err.message}`))
    })
  })
}

/**
 * Call ElevenLabs Add Voice API with the sample
 */
async function addVoiceToElevenLabs(
  samplePath: string,
  voiceName: string
): Promise<{ voice_id: string }> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY is not set')
  }

  const form = new FormData()
  form.append('name', voiceName)
  form.append('files', fs.createReadStream(samplePath), {
    filename: 'voice-sample.wav',
    contentType: 'audio/wav'
  })

  const res = await fetch(ELEVENLABS_VOICES_API, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      ...form.getHeaders()
    },
    body: form
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`ElevenLabs Add Voice failed (${res.status}): ${errText.slice(0, 200)}`)
  }

  const data = await res.json() as { voice_id: string }

  if (!data.voice_id) {
    throw new Error('ElevenLabs response missing voice_id')
  }

  return { voice_id: data.voice_id }
}

/**
 * Persist voice_id to .envrc file
 */
export function persistVoiceId(voiceId: string, projectRoot: string): void {
  const envrcPath = path.join(projectRoot, '.envrc')
  const varLine = `export ELEVENLABS_VOICE_ID="${voiceId}"`

  let content = ''
  if (fs.existsSync(envrcPath)) {
    content = fs.readFileSync(envrcPath, 'utf-8')
  }

  // Check if ELEVENLABS_VOICE_ID already exists
  const voiceIdPattern = /^export ELEVENLABS_VOICE_ID=.*$/m

  if (voiceIdPattern.test(content)) {
    // Replace existing line
    content = content.replace(voiceIdPattern, varLine)
  } else {
    // Append new line (ensure newline before if file doesn't end with one)
    if (content.length > 0 && !content.endsWith('\n')) {
      content += '\n'
    }
    content += varLine + '\n'
  }

  fs.writeFileSync(envrcPath, content)

  // Also update process.env for immediate use
  process.env.ELEVENLABS_VOICE_ID = voiceId
}

/**
 * Load voice ID from .envrc file (for app restarts)
 * Electron doesn't source shell scripts, so we parse it manually
 */
export function loadVoiceIdFromEnvrc(projectRoot: string): void {
  const envrcPath = path.join(projectRoot, '.envrc')
  if (!fs.existsSync(envrcPath)) {
    return
  }

  try {
    const content = fs.readFileSync(envrcPath, 'utf-8')
    const match = content.match(/^export ELEVENLABS_VOICE_ID="([^"]+)"$/m)
    if (match && match[1]) {
      process.env.ELEVENLABS_VOICE_ID = match[1]
      console.log('[voice-clone] Loaded voice ID from .envrc:', match[1])
    }
  } catch {
    // Ignore read errors
  }
}

/**
 * Get configured voice ID from environment or local settings
 * Falls back to default if not configured
 */
export function getConfiguredVoiceId(defaultVoiceId: string): string {
  const envVoiceId = process.env.ELEVENLABS_VOICE_ID
  if (envVoiceId && envVoiceId.trim().length > 0) {
    return envVoiceId.trim()
  }
  return defaultVoiceId
}

/**
 * Main voice cloning function
 * Extracts sample from video and creates cloned voice
 */
export async function cloneVoiceFromVideo(
  videoPath: string,
  projectRoot: string
): Promise<VoiceCloneResult> {
  // Generate voice name with timestamp
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
  const voiceName = `Video Clone ${timestamp}`

  // Create temp directory for sample
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-clone-'))
  const samplePath = path.join(tmpDir, 'sample.wav')

  try {
    // Step 1: Extract sample
    console.log('[voice-clone] Extracting voice sample...')
    await extractVoiceSample(videoPath, samplePath)

    // Verify sample was created
    if (!fs.existsSync(samplePath)) {
      throw new Error('Sample extraction produced no output')
    }

    // Step 2: Upload to ElevenLabs
    console.log('[voice-clone] Creating voice in ElevenLabs...')
    const { voice_id } = await addVoiceToElevenLabs(samplePath, voiceName)

    // Step 3: Persist voice_id
    console.log('[voice-clone] Saving voice_id to .envrc and process.env...')
    persistVoiceId(voice_id, projectRoot)

    console.log(`[voice-clone] Success! Voice "${voiceName}" created with ID: ${voice_id}`)
    console.log('[voice-clone] process.env.ELEVENLABS_VOICE_ID is now:', process.env.ELEVENLABS_VOICE_ID)

    return {
      success: true,
      voice_id,
      voice_name: voiceName
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[voice-clone] Error:', message)
    return {
      success: false,
      error: message
    }
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(samplePath)) {
        fs.unlinkSync(samplePath)
      }
      fs.rmdirSync(tmpDir)
    } catch {
      // Ignore cleanup errors
    }
  }
}
