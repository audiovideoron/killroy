/**
 * Media Metadata Extraction via ffprobe
 */

import { spawn } from 'child_process'
import type { VideoAsset } from '../shared/editor-types'
import { v4 as uuidv4 } from 'uuid'
import { validateMediaPath } from './path-validation'

interface FfprobeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  sample_rate?: string
  duration?: string
}

interface FfprobeFormat {
  duration?: string
}

interface FfprobeOutput {
  streams?: FfprobeStream[]
  format?: FfprobeFormat
}

/**
 * Parse fractional frame rate string (e.g., "30000/1001") to decimal fps
 */
function parseFrameRate(rFrameRate: string): number {
  const parts = rFrameRate.split('/')
  if (parts.length === 2) {
    const numerator = parseInt(parts[0], 10)
    const denominator = parseInt(parts[1], 10)
    return numerator / denominator
  }
  return parseFloat(rFrameRate)
}

/**
 * Extract video metadata using ffprobe
 */
export async function extractVideoMetadata(filePath: string): Promise<VideoAsset> {
  // Validate path before processing
  const validation = validateMediaPath(filePath)
  if (!validation.ok) {
    throw new Error(validation.message)
  }

  const TIMEOUT_MS = 30000 // 30 seconds

  let proc: ReturnType<typeof spawn> | null = null

  const metadataPromise = new Promise<VideoAsset>((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      filePath
    ]

    proc = spawn('ffprobe', args)
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffprobe exited with code ${code}: ${stderr}`))
      }

      try {
        const output: FfprobeOutput = JSON.parse(stdout)

        if (!output.streams || output.streams.length === 0) {
          return reject(new Error('No streams found in video file'))
        }

        // Find video and audio streams
        const videoStream = output.streams.find((s) => s.codec_type === 'video')
        const audioStream = output.streams.find((s) => s.codec_type === 'audio')

        if (!videoStream) {
          return reject(new Error('No video stream found'))
        }

        // Duration from format or video stream
        const durationStr =
          output.format?.duration ||
          videoStream.duration ||
          '0'
        const duration_ms = Math.round(parseFloat(durationStr) * 1000)

        // FPS from video stream
        const fps = videoStream.r_frame_rate
          ? parseFrameRate(videoStream.r_frame_rate)
          : 30

        // Sample rate from audio stream (default 48000 if no audio)
        const sample_rate = audioStream?.sample_rate
          ? parseInt(audioStream.sample_rate, 10)
          : 48000

        // Video dimensions
        const width = videoStream.width || 1920
        const height = videoStream.height || 1080

        const asset: VideoAsset = {
          video_id: uuidv4(),
          file_path: filePath,
          duration_ms,
          fps: Math.round(fps * 100) / 100, // Round to 2 decimals
          sample_rate,
          width,
          height
        }

        resolve(asset)
      } catch (error) {
        reject(new Error(`Failed to parse ffprobe output: ${error}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn ffprobe: ${err.message}`))
    })
  })

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      if (proc && !proc.killed) {
        proc.kill('SIGTERM')
      }
      reject(new Error(`ffprobe timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
  })

  return Promise.race([metadataPromise, timeoutPromise])
}
