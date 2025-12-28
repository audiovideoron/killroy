import fs from 'fs'
import fetch from 'node-fetch'

const ELEVENLABS_API = 'https://api.elevenlabs.io/v1/text-to-speech'

export async function synthesizeWithElevenLabs(
  text: string,
  voiceId: string,
  outPath: string
): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set')

  const res = await fetch(`${ELEVENLABS_API}/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/wav'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2'
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`ElevenLabs failed: ${res.status} ${err}`)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(outPath, buffer)
}
