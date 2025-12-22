import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

/**
 * Tests for temporary directory path helper
 *
 * Verifies that temp directory creation is packaging-safe and uses
 * system temp directory instead of process.cwd()
 */

// Mock version of getTempDir for testing (mirrors electron/main.ts implementation)
function getTempDir(baseTempPath: string = os.tmpdir()): string {
  const appTempDir = path.join(baseTempPath, 'audio-pro-previews')

  if (!fs.existsSync(appTempDir)) {
    fs.mkdirSync(appTempDir, { recursive: true })
  }

  return appTempDir
}

describe('Temp directory path helper', () => {
  let testTempBase: string
  let createdDirs: string[] = []

  beforeEach(() => {
    // Create a test-specific temp directory to avoid polluting system temp
    testTempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-pro-test-'))
    createdDirs = []
  })

  afterEach(() => {
    // Clean up all created directories
    for (const dir of createdDirs) {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    }
    // Clean up test temp base
    if (fs.existsSync(testTempBase)) {
      fs.rmSync(testTempBase, { recursive: true, force: true })
    }
  })

  describe('getTempDir', () => {
    it('returns an absolute path', () => {
      const result = getTempDir(testTempBase)
      createdDirs.push(result)

      expect(path.isAbsolute(result)).toBe(true)
    })

    it('path is under system temp directory', () => {
      const result = getTempDir(testTempBase)
      createdDirs.push(result)

      expect(result).toContain(testTempBase)
    })

    it('creates app-specific subdirectory', () => {
      const result = getTempDir(testTempBase)
      createdDirs.push(result)

      expect(result).toContain('audio-pro-previews')
      expect(path.basename(result)).toBe('audio-pro-previews')
    })

    it('creates directory if it does not exist', () => {
      const result = getTempDir(testTempBase)
      createdDirs.push(result)

      expect(fs.existsSync(result)).toBe(true)
      expect(fs.statSync(result).isDirectory()).toBe(true)
    })

    it('returns same path on multiple calls', () => {
      const result1 = getTempDir(testTempBase)
      const result2 = getTempDir(testTempBase)
      createdDirs.push(result1)

      expect(result1).toBe(result2)
    })

    it('does not throw if directory already exists', () => {
      const result1 = getTempDir(testTempBase)
      createdDirs.push(result1)

      // Second call should succeed without error
      expect(() => {
        const result2 = getTempDir(testTempBase)
        expect(result2).toBe(result1)
      }).not.toThrow()
    })

    it('created directory is writable', () => {
      const tempDir = getTempDir(testTempBase)
      createdDirs.push(tempDir)

      // Try to write a test file
      const testFile = path.join(tempDir, 'test.txt')
      expect(() => {
        fs.writeFileSync(testFile, 'test content')
      }).not.toThrow()

      expect(fs.existsSync(testFile)).toBe(true)

      // Clean up test file
      fs.unlinkSync(testFile)
    })

    it('does not use process.cwd()', () => {
      const result = getTempDir(testTempBase)
      createdDirs.push(result)

      // Verify path does not contain current working directory
      const cwd = process.cwd()
      expect(result).not.toContain(cwd)
    })
  })

  describe('Cleanup behavior', () => {
    it('can remove all files from temp directory', () => {
      const tempDir = getTempDir(testTempBase)
      createdDirs.push(tempDir)

      // Create test files
      const file1 = path.join(tempDir, 'preview1.mp4')
      const file2 = path.join(tempDir, 'preview2.mp4')
      fs.writeFileSync(file1, 'content1')
      fs.writeFileSync(file2, 'content2')

      expect(fs.existsSync(file1)).toBe(true)
      expect(fs.existsSync(file2)).toBe(true)

      // Simulate cleanup (mirrors app.on('will-quit') handler)
      const files = fs.readdirSync(tempDir)
      for (const file of files) {
        const filePath = path.join(tempDir, file)
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath)
        }
      }

      // Verify files were removed
      expect(fs.existsSync(file1)).toBe(false)
      expect(fs.existsSync(file2)).toBe(false)

      // Directory should still exist but be empty
      expect(fs.existsSync(tempDir)).toBe(true)
      expect(fs.readdirSync(tempDir).length).toBe(0)
    })

    it('can remove directory after cleanup', () => {
      const tempDir = getTempDir(testTempBase)
      createdDirs.push(tempDir)

      // Create and remove files
      const testFile = path.join(tempDir, 'test.mp4')
      fs.writeFileSync(testFile, 'content')
      fs.unlinkSync(testFile)

      // Remove directory
      fs.rmdirSync(tempDir)

      expect(fs.existsSync(tempDir)).toBe(false)
      // Remove from cleanup list since we already deleted it
      createdDirs = createdDirs.filter(d => d !== tempDir)
    })
  })
})
