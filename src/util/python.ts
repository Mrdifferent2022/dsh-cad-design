import { runProcess } from './proc.ts'
import type { AdapterStatus } from '../adapters/types.ts'

/** A resolved Python interpreter that can import a given module. */
export interface PythonResolution {
  readonly executable: string
  readonly version?: string
}

const PROBE_TIMEOUT_MS = 30_000

/**
 * Candidate Python launchers, in probe order. On Windows the `py` launcher is
 * the most reliable entry (it knows every registered install); bare `python`
 * can resolve to the Microsoft Store stub, which exits 9009 without a real
 * interpreter — the version probe below filters that out.
 */
function pythonCandidates(configuredPath?: string): string[] {
  const candidates: string[] = []
  if (configuredPath !== undefined && configuredPath.trim() !== '') {
    candidates.push(configuredPath)
  }
  if (process.env['DSH_CAD_PYTHON'] !== undefined && process.env['DSH_CAD_PYTHON'] !== '') {
    candidates.push(process.env['DSH_CAD_PYTHON'])
  }
  if (process.platform === 'win32') candidates.push('py')
  candidates.push('python', 'python3')
  return candidates
}

/** Probe one candidate with `--version`; returns undefined when unusable. */
async function probePython(executable: string, args: readonly string[], signal: AbortSignal): Promise<PythonResolution | undefined> {
  try {
    const result = await runProcess(executable, [...args, '--version'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
    })
    if (result.code !== 0) return undefined
    const version = (result.stdout.trim() || result.stderr.trim()).replace(/^Python\s+/i, '')
    if (version === '') return undefined
    return { executable: args.length > 0 ? `${executable} ${args.join(' ')}` : executable, version }
  } catch {
    return undefined
  }
}

/**
 * Resolve a working Python interpreter. `py` is probed as `py -3` so the
 * returned command line is directly spawnable as (executable, prefixArgs).
 */
export async function findPython(
  configuredPath: string | undefined,
  signal: AbortSignal,
): Promise<PythonResolution | undefined> {
  for (const candidate of pythonCandidates(configuredPath)) {
    // The Windows launcher needs `-3` to select a real interpreter.
    const args = candidate === 'py' ? ['-3'] : []
    const found = await probePython(candidate, args, signal)
    if (found !== undefined) return found
  }
  return undefined
}

/** Split a resolved executable string back into (command, prefix args). */
export function splitPythonCommand(executable: string): { command: string; prefixArgs: string[] } {
  if (executable === 'py -3') return { command: 'py', prefixArgs: ['-3'] }
  return { command: executable, prefixArgs: [] }
}

/**
 * Shared detect() body for Python-backed adapters: resolve an interpreter,
 * then require that it can import the backend module. Never throws.
 */
export async function detectPythonBackend(
  configuredPath: string | undefined,
  moduleName: string,
  installHint: string,
  signal: AbortSignal,
): Promise<AdapterStatus> {
  const python = await findPython(configuredPath, signal)
  if (python === undefined) {
    return {
      available: false,
      installHint,
      missingReason: 'no working Python interpreter found (tried configured path, DSH_CAD_PYTHON, py launcher, python, python3)',
    }
  }
  const moduleCheck = await checkPythonModule(python.executable, moduleName, signal)
  if (!moduleCheck.ok) {
    return {
      available: false,
      executablePath: python.executable,
      ...(python.version !== undefined ? { version: `Python ${python.version}` } : {}),
      installHint,
      missingReason: `${moduleName} is not importable: ${moduleCheck.error ?? 'unknown error'}`,
    }
  }
  return {
    available: true,
    executablePath: python.executable,
    version: `${moduleName} ${moduleCheck.version ?? 'unknown'} / Python ${python.version ?? 'unknown'}`,
  }
}

/**
 * Check that `python -c "import <module>"` works and harvest the module's
 * `__version__` when it exposes one.
 */
export async function checkPythonModule(
  executable: string,
  moduleName: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const { command, prefixArgs } = splitPythonCommand(executable)
  try {
    const result = await runProcess(command, [
      ...prefixArgs,
      '-c',
      `import ${moduleName}; print(getattr(${moduleName}, "__version__", ""))`,
    ], {
      timeoutMs: PROBE_TIMEOUT_MS,
      signal,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim().split('\n').pop() ?? `exit ${String(result.code)}` }
    }
    const version = result.stdout.trim().split('\n').pop()
    return version !== undefined && version !== '' ? { ok: true, version } : { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
