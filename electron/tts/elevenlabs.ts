import * as fs from 'fs'
import * as path from 'path'
import fetch from 'node-fetch'

const ELEVENLABS_API = 'https://api.elevenlabs.io/v1/text-to-speech'

/**
 * Detect audio type from Content-Type header or payload bytes
 */
function detectAudioType(contentType: string | null, buffer: Buffer): 'mp3' | 'wav' {
  // Check Content-Type header first
  if (contentType) {
    if (contentType.includes('audio/mpeg') || contentType.includes('audio/mp3')) {
      return 'mp3'
    }
    if (contentType.includes('audio/wav') || contentType.includes('audio/wave')) {
      return 'wav'
    }
  }

  // Sniff payload bytes
  // MP3: starts with ID3 (0x49 0x44 0x33) or frame sync (0xFF 0xFB/0xFF 0xFA/0xFF 0xF3)
  if (buffer.length >= 3) {
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
      return 'mp3' // ID3 tag
    }
    if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
      return 'mp3' // MP3 frame sync
    }
  }

  // WAV: starts with RIFF....WAVE
  if (buffer.length >= 12) {
    const riff = buffer.slice(0, 4).toString('ascii')
    const wave = buffer.slice(8, 12).toString('ascii')
    if (riff === 'RIFF' && wave === 'WAVE') {
      return 'wav'
    }
  }

  // Default to mp3 (ElevenLabs default)
  return 'mp3'
}

/**
 * Replace file extension if it doesn't match detected type
 */
function fixExtension(filePath: string, detectedType: 'mp3' | 'wav'): string {
  const ext = path.extname(filePath).toLowerCase()
  const correctExt = `.${detectedType}`

  if (ext !== correctExt) {
    return filePath.replace(/\.[^.]+$/, correctExt)
  }
  return filePath
}

export async function synthesizeWithElevenLabs(
  text: string,
  voiceId: string,
  outPath: string
): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set')

  const apiUrl = `${ELEVENLABS_API}/${voiceId}`
  console.log(`[elevenlabs] API call: POST ${apiUrl}`)
  console.log(`[elevenlabs] voiceId: ${voiceId}`)
  console.log(`[elevenlabs] text: "${text.substring(0, 50)}..."`)

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2'
    })
  })

  if (!res.ok) {
    const err = await res.text()
    console.error(`[elevenlabs] API ERROR: ${res.status} ${err}`)
    throw new Error(`ElevenLabs failed: ${res.status} ${err}`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type')
  const detectedType = detectAudioType(contentType, buffer)
  const finalPath = fixExtension(outPath, detectedType)

  console.log(`[elevenlabs] SUCCESS: ${buffer.length} bytes, type=${detectedType}, saved to ${finalPath}`)

  fs.writeFileSync(finalPath, buffer)
  return finalPath
}
