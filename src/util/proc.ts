import { spawn } from 'node:child_process'

export interface RunProcessOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

export interface RunProcessResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly aborted: boolean
}

/** Cap captured stdout/stderr so a runaway script cannot exhaust memory. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

/** Thrown when the caller's abort signal fires; tools must honor exec.signal. */
export class AbortedError extends Error {
  constructor() {
    super('operation aborted')
    this.name = 'AbortedError'
  }
}

/**
 * Spawn a child process (never through a shell — Windows paths with spaces
 * stay safe), capture UTF-8 output up to a cap, and resolve on close.
 *
 * Termination semantics:
 * - timeout → kill the process, then `taskkill /T /F` the tree on Windows;
 * - `signal` abort → same tree kill, and the promise REJECTS with
 *   AbortedError so tool bodies propagate cancellation.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<RunProcessResult> {
  if (options.signal.aborted) return Promise.reject(new AbortedError())

  return new Promise((resolve, reject) => {
    const proc = spawn(command, [...args], {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      env: options.env ?? process.env,
      windowsHide: true,
      // Never shell: true — arguments must not be re-parsed.
      shell: false,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    proc.stdout.setEncoding('utf-8')
    proc.stderr.setEncoding('utf-8')
    proc.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk
    })
    proc.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk
    })

    const killTree = (): void => {
      try {
        proc.kill()
      } catch {
        // already exited
      }
      // Windows: kill the process tree as a safety net — CadQuery can spawn
      // grandchildren (OCCT threads aside, user scripts may subprocess).
      if (process.platform === 'win32' && proc.pid !== undefined) {
        try {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          }).unref()
        } catch {
          // best effort
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, options.timeoutMs)

    const onAbort = (): void => {
      killTree()
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new AbortedError())
      }
    }
    options.signal.addEventListener('abort', onAbort, { once: true })

    const finish = (result: RunProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    proc.on('error', (error) => {
      finish({
        code: -1,
        stdout,
        stderr: `${stderr}\n[spawn error: ${error.message}]`,
        timedOut: false,
        aborted: false,
      })
    })

    proc.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut, aborted: false })
    })
  })
}
