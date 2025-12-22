import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

/**
 * Tests for temp file lifecycle management
 *
 * Verifies that:
 * - getTempRoot creates and returns app temp directory
 * - createJobTempDir creates job-specific subdirectories
 * - cleanupJobTempDir removes job directories
 * - PRESERVE_TEMP_FILES env var prevents cleanup
 * - cleanupStaleJobDirs removes old directories
 */

// Mock implementations matching electron/main.ts

function getTempRoot(): string {
  const appTempRoot = path.join(os.tmpdir(), 'audio-pro')
  if (!fs.existsSync(appTempRoot)) {
    fs.mkdirSync(appTempRoot, { recursive: true })
  }
  return appTempRoot
}

function createJobTempDir(jobId: string): string {
  const tempRoot = getTempRoot()
  const jobTempDir = path.join(tempRoot, `job-${jobId}`)
  if (!fs.existsSync(jobTempDir)) {
    fs.mkdirSync(jobTempDir, { recursive: true })
  }
  return jobTempDir
}

function cleanupJobTempDir(jobId: string, tempDir?: string): void {
  if (process.env.PRESERVE_TEMP_FILES === 'true') {
    return
  }

  const jobTempDir = tempDir || path.join(getTempRoot(), `job-${jobId}`)
  if (!fs.existsSync(jobTempDir)) return

  try {
    fs.rmSync(jobTempDir, { recursive: true, force: true })
  } catch (err) {
    console.error(`Failed to clean up job temp directory ${jobTempDir}:`, err)
  }
}

function cleanupStaleJobDirs(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
  if (process.env.PRESERVE_TEMP_FILES === 'true') {
    return
  }

  const tempRoot = getTempRoot()
  if (!fs.existsSync(tempRoot)) return

  try {
    const entries = fs.readdirSync(tempRoot, { withFileTypes: true })
    const now = Date.now()

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue

      const dirPath = path.join(tempRoot, entry.name)
      try {
        const stats = fs.statSync(dirPath)
        const ageMs = now - stats.mtimeMs

        if (ageMs >= maxAgeMs) {
          fs.rmSync(dirPath, { recursive: true, force: true })
        }
      } catch (err) {
        console.error(`Failed to check/remove directory ${entry.name}:`, err)
      }
    }
  } catch (err) {
    console.error('Failed to scan temp root for stale directories:', err)
  }
}

describe('Temp lifecycle management', () => {
  let originalPreserveFlag: string | undefined
  let testTempRoot: string

  beforeEach(() => {
    // Save original env var
    originalPreserveFlag = process.env.PRESERVE_TEMP_FILES
    delete process.env.PRESERVE_TEMP_FILES

    // Get temp root for testing
    testTempRoot = getTempRoot()
  })

  afterEach(() => {
    // Restore original env var
    if (originalPreserveFlag !== undefined) {
      process.env.PRESERVE_TEMP_FILES = originalPreserveFlag
    } else {
      delete process.env.PRESERVE_TEMP_FILES
    }

    // Clean up test directories
    if (fs.existsSync(testTempRoot)) {
      const entries = fs.readdirSync(testTempRoot)
      for (const entry of entries) {
        if (entry.startsWith('job-test-')) {
          const dirPath = path.join(testTempRoot, entry)
          fs.rmSync(dirPath, { recursive: true, force: true })
        }
      }
    }
  })

  describe('getTempRoot', () => {
    it('creates and returns app temp directory', () => {
      const tempRoot = getTempRoot()

      expect(tempRoot).toContain('audio-pro')
      expect(fs.existsSync(tempRoot)).toBe(true)
    })

    it('returns same directory on multiple calls', () => {
      const tempRoot1 = getTempRoot()
      const tempRoot2 = getTempRoot()

      expect(tempRoot1).toBe(tempRoot2)
    })

    it('creates directory if it does not exist', () => {
      const tempRoot = getTempRoot()

      // Remove directory
      if (fs.existsSync(tempRoot)) {
        fs.rmSync(tempRoot, { recursive: true, force: true })
      }

      // Call again - should recreate
      const tempRoot2 = getTempRoot()

      expect(fs.existsSync(tempRoot2)).toBe(true)
      expect(tempRoot2).toBe(tempRoot)
    })
  })

  describe('createJobTempDir', () => {
    it('creates job-specific subdirectory', () => {
      const jobId = 'test-job-123'
      const jobTempDir = createJobTempDir(jobId)

      expect(jobTempDir).toContain('job-test-job-123')
      expect(fs.existsSync(jobTempDir)).toBe(true)
    })

    it('creates directory under temp root', () => {
      const jobId = 'test-job-456'
      const jobTempDir = createJobTempDir(jobId)
      const tempRoot = getTempRoot()

      expect(jobTempDir).toBe(path.join(tempRoot, `job-${jobId}`))
    })

    it('is idempotent - safe to call multiple times', () => {
      const jobId = 'test-job-789'
      const jobTempDir1 = createJobTempDir(jobId)
      const jobTempDir2 = createJobTempDir(jobId)

      expect(jobTempDir1).toBe(jobTempDir2)
      expect(fs.existsSync(jobTempDir1)).toBe(true)
    })

    it('creates independent directories for different jobs', () => {
      const jobId1 = 'test-job-aaa'
      const jobId2 = 'test-job-bbb'

      const jobTempDir1 = createJobTempDir(jobId1)
      const jobTempDir2 = createJobTempDir(jobId2)

      expect(jobTempDir1).not.toBe(jobTempDir2)
      expect(fs.existsSync(jobTempDir1)).toBe(true)
      expect(fs.existsSync(jobTempDir2)).toBe(true)
    })
  })

  describe('cleanupJobTempDir', () => {
    it('removes job directory', () => {
      const jobId = 'test-cleanup-1'
      const jobTempDir = createJobTempDir(jobId)

      expect(fs.existsSync(jobTempDir)).toBe(true)

      cleanupJobTempDir(jobId)

      expect(fs.existsSync(jobTempDir)).toBe(false)
    })

    it('accepts explicit tempDir parameter', () => {
      const jobId = 'test-cleanup-2'
      const jobTempDir = createJobTempDir(jobId)

      cleanupJobTempDir(jobId, jobTempDir)

      expect(fs.existsSync(jobTempDir)).toBe(false)
    })

    it('is safe to call on non-existent directory', () => {
      const jobId = 'test-nonexistent'

      expect(() => {
        cleanupJobTempDir(jobId)
      }).not.toThrow()
    })

    it('respects PRESERVE_TEMP_FILES env var', () => {
      process.env.PRESERVE_TEMP_FILES = 'true'

      const jobId = 'test-preserve'
      const jobTempDir = createJobTempDir(jobId)

      cleanupJobTempDir(jobId)

      // Directory should still exist
      expect(fs.existsSync(jobTempDir)).toBe(true)

      // Cleanup manually
      delete process.env.PRESERVE_TEMP_FILES
      cleanupJobTempDir(jobId)
    })

    it('removes directory with files inside', () => {
      const jobId = 'test-cleanup-3'
      const jobTempDir = createJobTempDir(jobId)

      // Create a file inside
      const testFile = path.join(jobTempDir, 'test.txt')
      fs.writeFileSync(testFile, 'test content')

      expect(fs.existsSync(testFile)).toBe(true)

      cleanupJobTempDir(jobId)

      expect(fs.existsSync(jobTempDir)).toBe(false)
      expect(fs.existsSync(testFile)).toBe(false)
    })
  })

  describe('cleanupStaleJobDirs', () => {
    it('removes directories older than maxAgeMs', () => {
      const jobId = 'test-stale-1'
      const jobTempDir = createJobTempDir(jobId)

      // Artificially age the directory by changing mtime
      const oldTime = Date.now() - (25 * 60 * 60 * 1000)  // 25 hours ago
      fs.utimesSync(jobTempDir, new Date(oldTime), new Date(oldTime))

      cleanupStaleJobDirs(24 * 60 * 60 * 1000)  // 24 hour threshold

      expect(fs.existsSync(jobTempDir)).toBe(false)
    })

    it('keeps directories younger than maxAgeMs', () => {
      const jobId = 'test-fresh-1'
      const jobTempDir = createJobTempDir(jobId)

      // This directory is fresh (just created)
      cleanupStaleJobDirs(24 * 60 * 60 * 1000)

      expect(fs.existsSync(jobTempDir)).toBe(true)

      // Cleanup
      cleanupJobTempDir(jobId)
    })

    it('respects PRESERVE_TEMP_FILES env var', () => {
      process.env.PRESERVE_TEMP_FILES = 'true'

      const jobId = 'test-stale-preserve'
      const jobTempDir = createJobTempDir(jobId)

      // Age the directory
      const oldTime = Date.now() - (25 * 60 * 60 * 1000)
      fs.utimesSync(jobTempDir, new Date(oldTime), new Date(oldTime))

      cleanupStaleJobDirs(24 * 60 * 60 * 1000)

      // Directory should still exist
      expect(fs.existsSync(jobTempDir)).toBe(true)

      // Cleanup manually
      delete process.env.PRESERVE_TEMP_FILES
      cleanupJobTempDir(jobId)
    })

    it('only removes job directories (job-* prefix)', () => {
      const jobId = 'test-stale-2'
      const jobTempDir = createJobTempDir(jobId)

      // Create a non-job directory
      const otherDir = path.join(testTempRoot, 'other-dir')
      fs.mkdirSync(otherDir)

      // Age both directories
      const oldTime = Date.now() - (25 * 60 * 60 * 1000)
      fs.utimesSync(jobTempDir, new Date(oldTime), new Date(oldTime))
      fs.utimesSync(otherDir, new Date(oldTime), new Date(oldTime))

      cleanupStaleJobDirs(24 * 60 * 60 * 1000)

      // Job directory should be removed
      expect(fs.existsSync(jobTempDir)).toBe(false)

      // Other directory should remain
      expect(fs.existsSync(otherDir)).toBe(true)

      // Cleanup
      fs.rmSync(otherDir, { recursive: true, force: true })
    })

    it('handles multiple stale directories', () => {
      const jobId1 = 'test-stale-multi-1'
      const jobId2 = 'test-stale-multi-2'
      const jobId3 = 'test-fresh-multi'

      const jobTempDir1 = createJobTempDir(jobId1)
      const jobTempDir2 = createJobTempDir(jobId2)
      const jobTempDir3 = createJobTempDir(jobId3)

      // Age first two
      const oldTime = Date.now() - (25 * 60 * 60 * 1000)
      fs.utimesSync(jobTempDir1, new Date(oldTime), new Date(oldTime))
      fs.utimesSync(jobTempDir2, new Date(oldTime), new Date(oldTime))

      cleanupStaleJobDirs(24 * 60 * 60 * 1000)

      // Stale directories removed
      expect(fs.existsSync(jobTempDir1)).toBe(false)
      expect(fs.existsSync(jobTempDir2)).toBe(false)

      // Fresh directory remains
      expect(fs.existsSync(jobTempDir3)).toBe(true)

      // Cleanup
      cleanupJobTempDir(jobId3)
    })
  })

  describe('Edge cases', () => {
    it('cleanupJobTempDir handles directory with subdirectories', () => {
      const jobId = 'test-nested'
      const jobTempDir = createJobTempDir(jobId)

      // Create nested structure
      const subDir = path.join(jobTempDir, 'subdir')
      fs.mkdirSync(subDir)
      fs.writeFileSync(path.join(subDir, 'file.txt'), 'content')

      cleanupJobTempDir(jobId)

      expect(fs.existsSync(jobTempDir)).toBe(false)
    })

    it('cleanupStaleJobDirs with maxAgeMs=0 removes all job directories', async () => {
      const jobId = 'test-immediate'
      const jobTempDir = createJobTempDir(jobId)

      // Wait 1ms to ensure ageMs > 0
      await new Promise(resolve => setTimeout(resolve, 1))

      cleanupStaleJobDirs(0)  // Remove everything

      expect(fs.existsSync(jobTempDir)).toBe(false)
    })

    it('cleanupStaleJobDirs handles missing temp root gracefully', () => {
      const tempRoot = getTempRoot()

      // Remove temp root
      if (fs.existsSync(tempRoot)) {
        fs.rmSync(tempRoot, { recursive: true, force: true })
      }

      // Should not throw
      expect(() => {
        cleanupStaleJobDirs()
      }).not.toThrow()
    })
  })
})
