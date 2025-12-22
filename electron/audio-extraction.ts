/**
 * Audio Extraction for ASR
 */

import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

/**
 * Extract mono WAV from video file
 * Returns path to extracted WAV file
 */
export async function extractAudioForASR(
  videoPath: string,
  outputDir: string
): Promise<string> {
  const baseName = path.basename(videoPath, path.extname(videoPath))
  const outputPath = path.join(outputDir, `${baseName}-audio.wav`)

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  return new Promise((resolve, reject) => {
    const args = [
      '-y', // Overwrite
      '-i', videoPath,
      '-vn', // No video
      '-acodec', 'pcm_s16le', // PCM 16-bit
      '-ar', '16000', // 16kHz sample rate (standard for ASR)
      '-ac', '1', // Mono
      outputPath
    ]

    const proc = spawn('ffmpeg', args)
    let stderr = ''

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg audio extraction failed: ${stderr}`))
      }
      resolve(outputPath)
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`))
    })
  })
}

/**
 * Cleanup extracted audio file
 */
export function cleanupAudioFile(audioPath: string): void {
  if (fs.existsSync(audioPath)) {
    fs.unlinkSync(audioPath)
  }
}
