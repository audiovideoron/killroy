import { protocol, BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { validateFilePath } from './path-validation'
import type { ProtocolErrorEvent } from '../shared/types'

// Reference to main window for sending error events
let mainWindowRef: BrowserWindow | null = null

/**
 * Register custom appfile:// protocol scheme as privileged.
 * Must be called before app.whenReady().
 */
export function registerAppfileScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'appfile',
      privileges: {
        stream: true,
        supportFetchAPI: true
      }
    }
  ])
}

/**
 * Emit protocol error event to renderer.
 */
function emitProtocolError(url: string, statusCode: number, message: string): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    const event: ProtocolErrorEvent = { url, statusCode, message }
    mainWindowRef.webContents.send('protocol:error', event)
    console.log('[appfile] Emitted protocol:error event:', event)
  }
}

/**
 * Handle appfile:// protocol with Range request support for video playback.
 * Security: Only serves files that have been explicitly approved via the allowlist.
 * @param mainWindow Main browser window to send error events to
 */
export function setupAppfileProtocolHandler(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow
  protocol.handle('appfile', (request) => {
    try {
      // appfile:///absolute/path?v=123 -> /absolute/path
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname)

      // Validate against allowlist
      const validatedPath = validateFilePath(filePath)
      console.log('[appfile] Protocol decision:', {
        requestedPath: filePath,
        approved: !!validatedPath,
        resolvedPath: validatedPath || '(blocked)'
      })
      if (!validatedPath) {
        console.error('[appfile] Blocked unapproved path:', filePath)
        emitProtocolError(request.url, 403, `Blocked unapproved path: ${filePath}`)
        return new Response('Forbidden', { status: 403 })
      }

      // Check file exists
      if (!fs.existsSync(validatedPath)) {
        console.error('[appfile] File not found:', validatedPath)
        emitProtocolError(request.url, 404, `File not found: ${validatedPath}`)
        return new Response('Not Found', { status: 404 })
      }

      const stat = fs.statSync(validatedPath)
      const fileSize = stat.size

      // Determine MIME type from extension
      const ext = path.extname(validatedPath).toLowerCase()
      const mimeTypes: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
        '.m4v': 'video/x-m4v',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg'
      }
      const contentType = mimeTypes[ext] || 'application/octet-stream'

      // Parse Range header
      const rangeHeader = request.headers.get('range')

      if (rangeHeader) {
        // Handle Range request (206 Partial Content)
        const parts = rangeHeader.replace(/bytes=/, '').split('-')
        const start = parseInt(parts[0], 10)
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1

        const chunkSize = (end - start) + 1
        const stream = fs.createReadStream(validatedPath, { start, end })

        console.log(`[appfile] 206 ${path.basename(validatedPath)} Range: ${start}-${end}/${fileSize}`)

        return new Response(stream as any, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize),
            'Content-Type': contentType
          }
        })
      } else {
        // Handle full file request (200 OK)
        const stream = fs.createReadStream(validatedPath)

        console.log(`[appfile] 200 ${path.basename(validatedPath)} size: ${fileSize}`)

        return new Response(stream as any, {
          status: 200,
          headers: {
            'Content-Length': String(fileSize),
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
          }
        })
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      console.error('[appfile] Protocol error:', err)
      emitProtocolError(request.url, 500, `Internal error: ${errorMessage}`)
      return new Response('Internal Server Error', { status: 500 })
    }
  })
}
