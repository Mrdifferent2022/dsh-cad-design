import { writeFile } from 'node:fs/promises'
import type { AdapterStatus, CadAdapter, CadCapabilities, CadFacts, CadJob, CadJobResult } from '../types.ts'
import { runProcess } from '../../util/proc.ts'
import { checkPythonModule, findPython, splitPythonCommand } from '../../util/python.ts'
import { parseRunnerOutput, runnerPath } from '../../util/runner.ts'

export interface CadQueryAdapterOptions {
  /** Explicit python.exe path; empty = auto-detect (py launcher, PATH). */
  readonly pythonPath?: string
  readonly timeoutSeconds: number
}

const INSTALL_HINT = 'Install Python 3.10+ and run: pip install cadquery '
  + '(conda: conda install -c conda-forge cadquery). '
  + 'Optional: pip install cairosvg for raster PNG previews.'

/**
 * CadQuery backend: Python parametric modeling on the OpenCASCADE kernel.
 * Native STEP/IGES export makes it the primary mechanical-engineering
 * backend; the runner protocol keeps stdout reserved for one JSON line.
 */
export class CadQueryAdapter implements CadAdapter {
  readonly id = 'cadquery'
  readonly displayName = 'CadQuery (OpenCASCADE)'
  readonly capabilities: CadCapabilities = {
    parametricModeling: { language: 'python', headless: true },
    renderPreview: { raster: true },
    exportFormats: ['step', 'iges', 'stl', '3mf'],
    importFormats: [],
    analysis: true,
  }

  constructor(private readonly options: CadQueryAdapterOptions) {}

  async detect(signal: AbortSignal): Promise<AdapterStatus> {
    const python = await findPython(this.options.pythonPath, signal)
    if (python === undefined) {
      return {
        available: false,
        installHint: INSTALL_HINT,
        missingReason: 'no working Python interpreter found (tried configured path, DSH_CAD_PYTHON, py launcher, python, python3)',
      }
    }
    const moduleCheck = await checkPythonModule(python.executable, 'cadquery', signal)
    if (!moduleCheck.ok) {
      return {
        available: false,
        executablePath: python.executable,
        ...(python.version !== undefined ? { version: `Python ${python.version}` } : {}),
        installHint: INSTALL_HINT,
        missingReason: `cadquery is not importable: ${moduleCheck.error ?? 'unknown error'}`,
      }
    }
    return {
      available: true,
      executablePath: python.executable,
      version: `cadquery ${moduleCheck.version ?? 'unknown'} / Python ${python.version ?? 'unknown'}`,
    }
  }

  async run(job: CadJob, signal: AbortSignal): Promise<CadJobResult> {
    const status = await this.detect(signal)
    if (!status.available || status.executablePath === undefined) {
      throw new Error(
        `CadQuery backend is not available: ${status.missingReason ?? 'unknown reason'}. ${status.installHint ?? ''} Run cad_doctor for a full capability check.`.trim(),
      )
    }

    const jobPayload: Record<string, unknown> = {
      mode: job.mode,
      script_path: scriptPathOf(job),
    }
    if (job.outputPath !== undefined) jobPayload['output_path'] = job.outputPath
    if (job.svgPath !== undefined) jobPayload['svg_out'] = job.svgPath
    if (job.pngPath !== undefined) jobPayload['png_out'] = job.pngPath
    const jobJsonPath = `${job.workDir}/job.json`
    await writeFile(jobJsonPath, JSON.stringify(jobPayload, null, 2), 'utf-8')

    const { command, prefixArgs } = splitPythonCommand(status.executablePath)
    const result = await runProcess(command, [
      ...prefixArgs,
      runnerPath('cadquery_runner.py'),
      '--job',
      jobJsonPath,
    ], {
      cwd: job.workDir,
      timeoutMs: this.options.timeoutSeconds * 1000,
      signal,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
    })

    if (result.timedOut) {
      throw new Error(
        `CadQuery job timed out after ${String(this.options.timeoutSeconds)}s; simplify the model or raise the timeoutSeconds config`,
      )
    }

    const parsed = parseRunnerOutput(result.stdout)
    if (parsed === undefined) {
      const tail = result.stderr.trim().split('\n').slice(-5).join('\n')
      throw new Error(
        `CadQuery runner produced no parseable result (exit ${String(result.code)})${tail !== '' ? `:\n${tail}` : ''}`,
      )
    }
    if (parsed['success'] !== true) {
      const message = typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown runner error'
      const trace = typeof parsed['traceback'] === 'string' ? `\n${parsed['traceback']}` : ''
      throw new Error(`CadQuery job failed: ${message}${trace}`)
    }

    return {
      ...(parsed['facts'] !== undefined ? { facts: parsed['facts'] as CadFacts } : {}),
      ...(typeof parsed['valid'] === 'boolean' ? { valid: parsed['valid'] } : {}),
      ...(typeof parsed['svg'] === 'string' ? { svgPath: parsed['svg'] } : {}),
      ...(typeof parsed['png'] === 'string' ? { pngPath: parsed['png'] } : {}),
      ...(typeof parsed['output_path'] === 'string' ? { outputPath: parsed['output_path'] } : {}),
      ...(typeof parsed['bytes'] === 'number' ? { bytes: parsed['bytes'] } : {}),
      echo: Array.isArray(parsed['echo']) ? parsed['echo'] as string[] : [],
      warnings: Array.isArray(parsed['warnings']) ? parsed['warnings'] as string[] : [],
    }
  }
}

/** The runner reads the script from disk; tools write it into the work dir. */
function scriptPathOf(job: CadJob): string {
  return `${job.workDir}/model.py`
}
