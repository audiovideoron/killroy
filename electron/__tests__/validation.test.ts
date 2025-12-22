import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

/**
 * Tests for media file path validation
 *
 * Verifies that validateMediaPath() properly checks:
 * - Path is absolute
 * - File exists
 * - File is readable
 * - File is a regular file (not directory)
 * - Extension is supported
 */

// Mock types matching electron/main.ts implementation
type PathValidationFailure =
  | 'NOT_ABSOLUTE'
  | 'NOT_FOUND'
  | 'NOT_READABLE'
  | 'NOT_FILE'
  | 'UNSUPPORTED_TYPE'

type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; reason: PathValidationFailure; message: string }

const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm',
  '.m4v', '.flv', '.wmv', '.mpg', '.mpeg',
  '.3gp', '.ogv', '.ts', '.mts', '.m2ts'
])

// Extracted validation logic for testing (mirrors electron/main.ts)
function validateMediaPath(filePath: string): PathValidationResult {
  if (!path.isAbsolute(filePath)) {
    return {
      ok: false,
      reason: 'NOT_ABSOLUTE',
      message: `Path must be absolute: ${filePath}`
    }
  }

  let stats: fs.Stats
  try {
    stats = fs.statSync(filePath)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        reason: 'NOT_FOUND',
        message: `File not found: ${filePath}`
      }
    }
    if (err.code === 'EACCES') {
      return {
        ok: false,
        reason: 'NOT_READABLE',
        message: `Permission denied: ${filePath}`
      }
    }
    return {
      ok: false,
      reason: 'NOT_READABLE',
      message: `Cannot access file: ${err.message}`
    }
  }

  if (!stats.isFile()) {
    return {
      ok: false,
      reason: 'NOT_FILE',
      message: `Path is not a regular file: ${filePath}`
    }
  }

  try {
    fs.accessSync(filePath, fs.constants.R_OK)
  } catch {
    return {
      ok: false,
      reason: 'NOT_READABLE',
      message: `File is not readable: ${filePath}`
    }
  }

  const ext = path.extname(filePath).toLowerCase()
  if (!SUPPORTED_MEDIA_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_TYPE',
      message: `Unsupported file type: ${ext}. Supported: ${Array.from(SUPPORTED_MEDIA_EXTENSIONS).join(', ')}`
    }
  }

  return { ok: true, path: filePath }
}

describe('Media path validation', () => {
  let testDir: string
  let testFile: string

  beforeEach(() => {
    // Create temporary test directory and file
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-test-'))
    testFile = path.join(testDir, 'test-video.mp4')
    fs.writeFileSync(testFile, 'fake video content')
  })

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe('Absolute path requirement', () => {
    it('rejects relative paths', () => {
      const result = validateMediaPath('relative/path/video.mp4')

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('NOT_ABSOLUTE')
        expect(result.message).toContain('must be absolute')
      }
    })

    it('accepts absolute paths', () => {
      const result = validateMediaPath(testFile)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe(testFile)
      }
    })
  })

  describe('File existence', () => {
    it('rejects non-existent files', () => {
      const nonExistent = path.join(testDir, 'does-not-exist.mp4')
      const result = validateMediaPath(nonExistent)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('NOT_FOUND')
        expect(result.message).toContain('not found')
      }
    })

    it('accepts existing files', () => {
      const result = validateMediaPath(testFile)

      expect(result.ok).toBe(true)
    })
  })

  describe('File type checking', () => {
    it('rejects directories', () => {
      const result = validateMediaPath(testDir)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('NOT_FILE')
        expect(result.message).toContain('not a regular file')
      }
    })

    it('accepts regular files', () => {
      const result = validateMediaPath(testFile)

      expect(result.ok).toBe(true)
    })
  })

  describe('Extension validation', () => {
    it('rejects unsupported extensions', () => {
      const textFile = path.join(testDir, 'document.txt')
      fs.writeFileSync(textFile, 'text content')

      const result = validateMediaPath(textFile)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('UNSUPPORTED_TYPE')
        expect(result.message).toContain('Unsupported file type')
        expect(result.message).toContain('.txt')
      }
    })

    it('accepts supported video extensions', () => {
      const supportedExts = ['.mp4', '.mov', '.mkv', '.avi', '.webm']

      for (const ext of supportedExts) {
        const videoFile = path.join(testDir, `video${ext}`)
        fs.writeFileSync(videoFile, 'video content')

        const result = validateMediaPath(videoFile)

        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.path).toBe(videoFile)
        }
      }
    })

    it('handles case-insensitive extensions', () => {
      const upperFile = path.join(testDir, 'VIDEO.MP4')
      fs.writeFileSync(upperFile, 'video content')

      const result = validateMediaPath(upperFile)

      expect(result.ok).toBe(true)
    })
  })

  describe('Readability checks', () => {
    it('accepts readable files', () => {
      const result = validateMediaPath(testFile)

      expect(result.ok).toBe(true)
    })

    it('handles permission errors gracefully', () => {
      // This test is platform-dependent, skip on systems where chmod doesn't work
      if (process.platform === 'win32') {
        return // Skip on Windows
      }

      const restrictedFile = path.join(testDir, 'restricted.mp4')
      fs.writeFileSync(restrictedFile, 'content')
      fs.chmodSync(restrictedFile, 0o000) // Remove all permissions

      const result = validateMediaPath(restrictedFile)

      // Clean up before assertion (restore permissions)
      fs.chmodSync(restrictedFile, 0o644)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reason).toBe('NOT_READABLE')
      }
    })
  })

  describe('Edge cases', () => {
    it('handles paths with spaces', () => {
      const spacedFile = path.join(testDir, 'video with spaces.mp4')
      fs.writeFileSync(spacedFile, 'content')

      const result = validateMediaPath(spacedFile)

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.path).toBe(spacedFile)
      }
    })

    it('handles paths with special characters', () => {
      const specialFile = path.join(testDir, 'video_file-2024(final).mp4')
      fs.writeFileSync(specialFile, 'content')

      const result = validateMediaPath(specialFile)

      expect(result.ok).toBe(true)
    })

    it('handles paths with unicode characters', () => {
      const unicodeFile = path.join(testDir, 'vidéo-文件.mp4')
      fs.writeFileSync(unicodeFile, 'content')

      const result = validateMediaPath(unicodeFile)

      expect(result.ok).toBe(true)
    })
  })

  describe('Error message quality', () => {
    it('provides clear message for non-existent files', () => {
      const missing = path.join(testDir, 'missing.mp4')
      const result = validateMediaPath(missing)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain(missing)
        expect(result.message.toLowerCase()).toContain('not found')
      }
    })

    it('provides clear message for unsupported types', () => {
      const textFile = path.join(testDir, 'file.txt')
      fs.writeFileSync(textFile, 'content')
      const result = validateMediaPath(textFile)

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message).toContain('.txt')
        expect(result.message).toContain('Unsupported')
        // Should list supported types
        expect(result.message).toContain('.mp4')
      }
    })
  })
})
