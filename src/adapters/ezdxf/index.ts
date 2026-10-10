import type { AdapterStatus, CadAdapter, CadCapabilities, CadJob, CadJobResult } from '../types.ts'
import { detectPythonBackend } from '../../util/python.ts'
import { runPythonRunnerJob } from '../../util/runner.ts'

export interface EzdxfAdapterOptions {
  /** Explicit python.exe path; empty = auto-detect (py launcher, PATH). */
  readonly pythonPath?: string
  readonly timeoutSeconds: number
}

const INSTALL_HINT = 'Install Python 3.10+ and run: pip install ezdxf matplotlib '
  + '(matplotlib powers the drawing previews).'

/**
 * ezdxf backend: Python 2D engineering drafting, reading and writing DXF —
 * the neutral exchange format every CAD/CAM tool (AutoCAD, ZWCAD, GstarCAD,
 * SolidWorks drawings, laser cutters) accepts. The runner repairs common
 * LLM-script DXF defects before saving (missing TEXT align_point) and remaps
 * CJK-less fonts for previews.
 */
export class EzdxfAdapter implements CadAdapter {
  readonly id = 'ezdxf'
  readonly displayName = 'ezdxf (2D DXF drafting)'
  readonly capabilities: CadCapabilities = {
    parametricModeling: { language: 'python', headless: true, dimensions: '2d' },
    renderPreview: { raster: true },
    exportFormats: ['dxf'],
    importFormats: ['dxf'],
    analysis: true,
  }

  constructor(private readonly options: EzdxfAdapterOptions) {}

  async detect(signal: AbortSignal): Promise<AdapterStatus> {
    return detectPythonBackend(this.options.pythonPath, 'ezdxf', INSTALL_HINT, signal)
  }

  async run(job: CadJob, signal: AbortSignal): Promise<CadJobResult> {
    const status = await this.detect(signal)
    if (!status.available || status.executablePath === undefined) {
      throw new Error(
        `ezdxf backend is not available: ${status.missingReason ?? 'unknown reason'}. ${status.installHint ?? ''} Run cad_doctor for a full capability check.`.trim(),
      )
    }
    return runPythonRunnerJob('ezdxf', 'ezdxf_runner.py', status.executablePath, this.options.timeoutSeconds, job, signal)
  }
}
