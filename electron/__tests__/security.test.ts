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

function createPathValidator(maxPaths = 1000) {
  const approvedPaths = new Map<string, boolean>()

  return {
    approvePath: (filePath: string): void => {
      const normalized = normalizePath(filePath)

      // If already exists, delete and re-add to update insertion order (LRU)
      if (approvedPaths.has(normalized)) {
        approvedPaths.delete(normalized)
      }

      // Evict oldest entry if at capacity
      if (approvedPaths.size >= maxPaths) {
        const oldestKey = approvedPaths.keys().next().value
        approvedPaths.delete(oldestKey)
      }

      approvedPaths.set(normalized, true)
    },
    validatePath: (requestedPath: string): string | null => {
      try {
        const normalized = normalizePath(requestedPath)
        return approvedPaths.has(normalized) ? normalized : null
      } catch {
        return null
      }
    },
    clear: () => approvedPaths.clear(),
    size: () => approvedPaths.size
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

  describe('LRU cache eviction', () => {
    it('enforces maximum cache size limit', () => {
      const maxSize = 10
      const smallValidator = createPathValidator(maxSize)

      // Add more paths than the limit
      for (let i = 0; i < 15; i++) {
        smallValidator.approvePath(`/tmp/video${i}.mp4`)
      }

      // Cache should not exceed max size
      expect(smallValidator.size()).toBe(maxSize)
    })

    it('evicts oldest entries when limit reached', () => {
      const maxSize = 5
      const smallValidator = createPathValidator(maxSize)

      // Add paths 0-4
      for (let i = 0; i < 5; i++) {
        smallValidator.approvePath(`/tmp/video${i}.mp4`)
      }

      // All should be approved
      for (let i = 0; i < 5; i++) {
        expect(smallValidator.validatePath(`/tmp/video${i}.mp4`)).not.toBeNull()
      }

      // Add 3 more paths (should evict 0, 1, 2)
      for (let i = 5; i < 8; i++) {
        smallValidator.approvePath(`/tmp/video${i}.mp4`)
      }

      // Oldest paths should be evicted
      expect(smallValidator.validatePath('/tmp/video0.mp4')).toBeNull()
      expect(smallValidator.validatePath('/tmp/video1.mp4')).toBeNull()
      expect(smallValidator.validatePath('/tmp/video2.mp4')).toBeNull()

      // Recent paths should remain
      expect(smallValidator.validatePath('/tmp/video3.mp4')).not.toBeNull()
      expect(smallValidator.validatePath('/tmp/video4.mp4')).not.toBeNull()
      expect(smallValidator.validatePath('/tmp/video5.mp4')).not.toBeNull()
      expect(smallValidator.validatePath('/tmp/video6.mp4')).not.toBeNull()
      expect(smallValidator.validatePath('/tmp/video7.mp4')).not.toBeNull()
    })

    it('updates access order when re-approving existing path', () => {
      const maxSize = 3
      const smallValidator = createPathValidator(maxSize)

      // Add paths 0, 1, 2
      smallValidator.approvePath('/tmp/video0.mp4')
      smallValidator.approvePath('/tmp/video1.mp4')
      smallValidator.approvePath('/tmp/video2.mp4')

      // Re-approve video0 (should move it to end of queue)
      smallValidator.approvePath('/tmp/video0.mp4')

      // Add video3 (should evict video1, not video0)
      smallValidator.approvePath('/tmp/video3.mp4')

      // video1 should be evicted (it's the oldest untouched)
      expect(smallValidator.validatePath('/tmp/video1.mp4')).toBeNull()

      // video0 should still be valid (was refreshed)
      expect(smallValidator.validatePath('/tmp/video0.mp4')).not.toBeNull()
      expect(smallValidator.validatePath('/tmp/video2.mp4')).not.toBeNull()
      expect(smallValidator.validatePath('/tmp/video3.mp4')).not.toBeNull()
    })

    it('maintains cache size of 1000 by default', () => {
      const defaultValidator = createPathValidator()

      // Add 1500 paths
      for (let i = 0; i < 1500; i++) {
        defaultValidator.approvePath(`/tmp/video${i}.mp4`)
      }

      // Should cap at 1000
      expect(defaultValidator.size()).toBe(1000)

      // First 500 should be evicted
      expect(defaultValidator.validatePath('/tmp/video0.mp4')).toBeNull()
      expect(defaultValidator.validatePath('/tmp/video499.mp4')).toBeNull()

      // Last 1000 should remain
      expect(defaultValidator.validatePath('/tmp/video500.mp4')).not.toBeNull()
      expect(defaultValidator.validatePath('/tmp/video1499.mp4')).not.toBeNull()
    })

    it('handles single capacity cache correctly', () => {
      const tinyValidator = createPathValidator(1)

      tinyValidator.approvePath('/tmp/video1.mp4')
      expect(tinyValidator.validatePath('/tmp/video1.mp4')).not.toBeNull()

      tinyValidator.approvePath('/tmp/video2.mp4')
      expect(tinyValidator.validatePath('/tmp/video1.mp4')).toBeNull()
      expect(tinyValidator.validatePath('/tmp/video2.mp4')).not.toBeNull()

      expect(tinyValidator.size()).toBe(1)
    })
  })
})
