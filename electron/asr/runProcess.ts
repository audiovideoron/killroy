/**
 * Process execution helper for ASR CLI invocations
 */

import { spawn } from 'child_process'

export interface ProcessResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  error?: string
}

export interface ProcessOptions {
  timeout?: number // milliseconds
  cwd?: string
}

/**
 * Run a process and capture output
 */
export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {}
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const { timeout = 300000, cwd } = options // 5 minute default timeout

    const proc = spawn(command, args, { cwd })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
    }, timeout)

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      clearTimeout(timer)

      if (timedOut) {
        resolve({
          success: false,
          exitCode: -1,
          stdout,
          stderr,
          error: `Process timed out after ${timeout}ms`
        })
      } else {
        resolve({
          success: code === 0,
          exitCode: code || 0,
          stdout,
          stderr
        })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        success: false,
        exitCode: -1,
        stdout,
        stderr,
        error: `Failed to spawn process: ${err.message}`
      })
    })
  })
}
