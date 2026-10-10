import type { AdapterStatus, CadAdapter, CadCapabilities, CadJob, CadJobResult } from '../types.ts'
import { detectPythonBackend } from '../../util/python.ts'
import { runPythonRunnerJob } from '../../util/runner.ts'

export interface CadQueryAdapterOptions {
  /** Explicit python.exe path; empty = auto-detect (py launcher, PATH). */
  readonly pythonPath?: string
  readonly timeoutSeconds: number
}

const INSTALL_HINT = 'Install Python 3.10+ and run: pip install cadquery '
  + '(conda: conda install -c conda-forge cadquery). '
  + 'Optional: pip install matplotlib for raster PNG previews.'

/**
 * CadQuery backend: Python parametric modeling on the OpenCASCADE kernel.
 * Native STEP/IGES export makes it the primary mechanical-engineering
 * backend; the runner protocol keeps stdout reserved for one JSON line.
 */
export class CadQueryAdapter implements CadAdapter {
  readonly id = 'cadquery'
  readonly displayName = 'CadQuery (OpenCASCADE)'
  readonly capabilities: CadCapabilities = {
    parametricModeling: { language: 'python', headless: true, dimensions: '3d' },
    renderPreview: { raster: true },
    exportFormats: ['step', 'iges', 'stl', '3mf'],
    importFormats: ['step', 'brep'],
    analysis: true,
  }

  constructor(private readonly options: CadQueryAdapterOptions) {}

  async detect(signal: AbortSignal): Promise<AdapterStatus> {
    return detectPythonBackend(this.options.pythonPath, 'cadquery', INSTALL_HINT, signal)
  }

  async run(job: CadJob, signal: AbortSignal): Promise<CadJobResult> {
    const status = await this.detect(signal)
    if (!status.available || status.executablePath === undefined) {
      throw new Error(
        `CadQuery backend is not available: ${status.missingReason ?? 'unknown reason'}. ${status.installHint ?? ''} Run cad_doctor for a full capability check.`.trim(),
      )
    }
    return runPythonRunnerJob('CadQuery', 'cadquery_runner.py', status.executablePath, this.options.timeoutSeconds, job, signal)
  }
}
