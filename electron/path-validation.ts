import * as path from 'path'
import * as fs from 'fs'

/**
 * Path validation failure reasons
 */
export type PathValidationFailure =
  | 'NOT_ABSOLUTE'
  | 'NOT_FOUND'
  | 'NOT_READABLE'
  | 'NOT_FILE'
  | 'UNSUPPORTED_TYPE'

export type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; reason: PathValidationFailure; message: string }

/**
 * Supported media file extensions (video with audio tracks)
 */
const SUPPORTED_MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm',
  '.m4v', '.flv', '.wmv', '.mpg', '.mpeg',
  '.3gp', '.ogv', '.ts', '.mts', '.m2ts'
])

/**
 * Validate a user-supplied media file path before FFmpeg/ffprobe execution.
 * Checks: absolute path, existence, readability, is file, supported extension.
 *
 * @param filePath User-supplied path (must be absolute)
 * @returns Validation result with typed failure reasons
 */
export function validateMediaPath(filePath: string): PathValidationResult {
  // Must be absolute path
  if (!path.isAbsolute(filePath)) {
    return {
      ok: false,
      reason: 'NOT_ABSOLUTE',
      message: `Path must be absolute: ${filePath}`
    }
  }

  // Check file exists and get stats
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

  // Must be a regular file (not directory, symlink, etc)
  if (!stats.isFile()) {
    return {
      ok: false,
      reason: 'NOT_FILE',
      message: `Path is not a regular file: ${filePath}`
    }
  }

  // Check file is readable
  try {
    fs.accessSync(filePath, fs.constants.R_OK)
  } catch {
    return {
      ok: false,
      reason: 'NOT_READABLE',
      message: `File is not readable: ${filePath}`
    }
  }

  // Check extension is supported
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

// Security: Allowlist of approved file paths for appfile:// protocol
// Only files explicitly approved (user-selected or app-generated) can be served
// Uses LRU cache with bounded size to prevent unbounded memory growth
const MAX_APPROVED_PATHS = 1000
const approvedFilePaths = new Map<string, boolean>()

/**
 * Safely resolve and normalize a file path for comparison.
 * Handles platform-specific path separators and case sensitivity.
 */
function normalizePath(filePath: string): string {
  const resolved = path.resolve(filePath)
  // Normalize to lowercase on Windows for case-insensitive comparison
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Add a file path to the approved list for appfile:// protocol access.
 * Path is normalized to prevent bypasses via different representations.
 *
 * Implements LRU eviction: when cache exceeds MAX_APPROVED_PATHS,
 * the oldest entry is removed.
 */
export function approveFilePath(filePath: string): void {
  const normalized = normalizePath(filePath)

  // If already exists, delete and re-add to update insertion order (LRU)
  if (approvedFilePaths.has(normalized)) {
    approvedFilePaths.delete(normalized)
  }

  // Evict oldest entry if at capacity
  if (approvedFilePaths.size >= MAX_APPROVED_PATHS) {
    const oldestKey = approvedFilePaths.keys().next().value
    approvedFilePaths.delete(oldestKey)
    console.log('[security] Evicted oldest approved path:', oldestKey)
  }

  approvedFilePaths.set(normalized, true)
  console.log('[security] Approved file path:', normalized)
}

/**
 * Check if a file path is approved for appfile:// protocol access.
 * Returns the normalized path if approved, null otherwise.
 */
export function validateFilePath(requestedPath: string): string | null {
  try {
    const normalized = normalizePath(requestedPath)
    if (approvedFilePaths.has(normalized)) {
      return normalized
    }
    console.warn('[security] Rejected unapproved file path:', requestedPath)
    return null
  } catch (err) {
    console.error('[security] Path validation error:', err)
    return null
  }
}
