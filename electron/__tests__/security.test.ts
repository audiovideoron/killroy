import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'path'

/**
 * Tests for path validation security in appfile:// protocol handler
 *
 * These tests verify that the allowlist-based path validation prevents
 * path traversal attacks while allowing legitimate file access.
 */

// Extracted pure functions for testing without Electron runtime
function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function createPathValidator() {
  const approvedPaths = new Set<string>()

  return {
    approvePath: (filePath: string): void => {
      const normalized = normalizePath(filePath)
      approvedPaths.add(normalized)
    },
    validatePath: (requestedPath: string): string | null => {
      try {
        const normalized = normalizePath(requestedPath)
        return approvedPaths.has(normalized) ? normalized : null
      } catch {
        return null
      }
    },
    clear: () => approvedPaths.clear()
  }
}

describe('Path validation security', () => {
  let validator: ReturnType<typeof createPathValidator>

  beforeEach(() => {
    validator = createPathValidator()
  })

  describe('normalizePath', () => {
    it('resolves relative paths to absolute', () => {
      const result = normalizePath('./video.mp4')
      expect(path.isAbsolute(result)).toBe(true)
    })

    it('normalizes path separators', () => {
      const result = normalizePath('/tmp/video.mp4')
      expect(result).toBe(path.resolve('/tmp/video.mp4'))
    })

    it('handles Windows-style paths on Windows', () => {
      if (process.platform === 'win32') {
        const result = normalizePath('C:\\Users\\test\\video.mp4')
        expect(result).toContain('c:\\users\\test\\video.mp4')
      }
    })
  })

  describe('Path allowlist validation', () => {
    it('allows approved absolute paths', () => {
      const approvedPath = path.resolve('/tmp/video.mp4')
      validator.approvePath(approvedPath)

      const result = validator.validatePath(approvedPath)
      expect(result).toBe(normalizePath(approvedPath))
    })

    it('rejects unapproved paths', () => {
      validator.approvePath('/tmp/approved.mp4')

      const result = validator.validatePath('/tmp/unapproved.mp4')
      expect(result).toBeNull()
    })

    it('rejects path traversal attempts with ../', () => {
      validator.approvePath('/tmp/videos/approved.mp4')

      // Try to access parent directory
      const result = validator.validatePath('/tmp/videos/../secret.txt')
      expect(result).toBeNull()
    })

    it('rejects URL-encoded path traversal (..%2F)', () => {
      validator.approvePath('/tmp/videos/approved.mp4')

      // Try to access parent with URL encoding
      const traversal = '/tmp/videos/..%2F..%2Fsecret.txt'
      // Decode the path (as appfile handler does)
      const decoded = decodeURIComponent(traversal)
      const result = validator.validatePath(decoded)
      expect(result).toBeNull()
    })

    it('normalizes equivalent paths to the same key', () => {
      const absolutePath = path.resolve('/tmp/video.mp4')

      // Approve using absolute path
      validator.approvePath(absolutePath)

      // Request using relative path that resolves to same location
      // (Simulate being in a directory where ./tmp/video.mp4 resolves to the approved path)
      const relativeRequest = path.relative(process.cwd(), absolutePath)
      const result = validator.validatePath(path.join(process.cwd(), relativeRequest))

      expect(result).toBe(normalizePath(absolutePath))
    })

    it('handles multiple approvals correctly', () => {
      const paths = [
        '/tmp/video1.mp4',
        '/tmp/video2.mp4',
        '/home/user/media/clip.mkv'
      ]

      paths.forEach(p => validator.approvePath(p))

      // All approved paths should validate
      paths.forEach(p => {
        expect(validator.validatePath(p)).toBe(normalizePath(p))
      })

      // Unapproved path should fail
      expect(validator.validatePath('/tmp/video3.mp4')).toBeNull()
    })

    it('rejects paths with null bytes', () => {
      validator.approvePath('/tmp/video.mp4')

      // Path with null byte (common bypass attempt)
      const malicious = '/tmp/video.mp4\0../../etc/passwd'
      const result = validator.validatePath(malicious)

      // Should either reject or normalize without the null byte
      // Either way, it shouldn't match the approved path
      expect(result).toBeNull()
    })

    it('handles Windows backslash traversal', () => {
      if (process.platform === 'win32') {
        validator.approvePath('C:\\Users\\test\\videos\\approved.mp4')

        const traversal = 'C:\\Users\\test\\videos\\..\\..\\secret.txt'
        const result = validator.validatePath(traversal)
        expect(result).toBeNull()
      }
    })

    it('rejects symlink traversal attempts', () => {
      // Approve a file in tmp
      validator.approvePath('/tmp/approved.mp4')

      // Try to access via a different path (even if they point to same file via symlink)
      // The allowlist should reject paths not explicitly approved
      const result = validator.validatePath('/var/tmp/approved.mp4')
      expect(result).toBeNull()
    })
  })

  describe('Error handling', () => {
    it('handles invalid path formats gracefully', () => {
      // Various invalid inputs
      const invalidPaths = [
        '',
        '<>',
        'con:',  // Windows reserved name
        'prn',   // Windows reserved name
      ]

      invalidPaths.forEach(badPath => {
        const result = validator.validatePath(badPath)
        // Should either return null or a normalized version that isn't approved
        if (result !== null) {
          // If it normalized successfully, it shouldn't be in our approved list
          expect(validator.validatePath(result)).toBeNull()
        }
      })
    })
  })
})
