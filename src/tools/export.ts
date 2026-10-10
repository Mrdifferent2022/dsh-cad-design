import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FORMAT_BY_EXTENSION, type CadFormat } from '../adapters/types.ts'
import { sniffBackend } from '../util/sniff.ts'
import { prepareWorkDir, requireAdapter, type CadToolDeps } from './shared.ts'
import { factsToJson } from './validate.ts'

const EXPORT_FORMATS = ['step', 'iges', 'stl', '3mf', 'dxf'] as const satisfies readonly CadFormat[]

const DEFAULT_EXTENSION: Readonly<Record<(typeof EXPORT_FORMATS)[number], string>> = {
  step: '.step',
  iges: '.iges',
  stl: '.stl',
  '3mf': '.3mf',
  dxf: '.dxf',
}

/** Resolve the final output path, appending the format extension when missing. */
function resolveOutputPath(rawPath: string, format: (typeof EXPORT_FORMATS)[number]): string {
  const match = /\.([a-z0-9]+)$/i.exec(rawPath)
  const ext = match?.[1]?.toLowerCase()
  if (ext === undefined) return `${rawPath}${DEFAULT_EXTENSION[format]}`
  const claimed = FORMAT_BY_EXTENSION[ext]
  if (claimed !== undefined && claimed !== format) {
    throw new Error(`output_path extension ".${ext}" claims ${claimed} but format is ${format}; use a matching extension or omit it`)
  }
  return rawPath
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * `cad_export`: execute modeling code and export a manufacturing exchange
 * file. STEP is the primary mechanical format; IGES serves legacy CAM;
 * STL/3MF serve 3D printing; DXF serves 2D drawings and laser/plasma cutting.
 */
export function applyCadExport(deps: CadToolDeps): void {
  deps.ctx.tools.register(defineTool({
    name: 'cad_export',
    description: 'Export CAD Python code to a manufacturing file: STEP (machining/assembly exchange), IGES (legacy CAM), STL or 3MF (3D printing) from CadQuery 3D code; DXF (2D drawings, laser/plasma cutting) from ezdxf code. Validate the design with cad_render first. The result already contains the absolute output path, byte size, and geometry facts — do NOT re-verify the file with shell commands. Refuses to overwrite an existing file unless overwrite is true. The script must assign the model/drawing to a top-level `result` variable.',
    parameters: {
      code: { type: 'string', required: true, description: 'CadQuery or ezdxf Python source. Must assign the final model/drawing to a top-level `result` variable (Workplane/Shape/list, or ezdxf Drawing/modelspace), or define `model()`.' },
      format: { type: 'string', enum: [...EXPORT_FORMATS], required: true, description: 'Export format. STEP for machining and CAD exchange, STL/3MF for 3D printing, IGES for legacy CAM, DXF for 2D drawings/cutting (ezdxf code).' },
      output_path: { type: 'string', required: true, description: 'Absolute output path. The format extension is appended when missing; an existing file is never silently overwritten.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing output_path. Default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          format: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          facts: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `✓ exported ${value.format.toUpperCase()}: ${value.outputPath} (${String(value.bytes)} bytes)`,
        ]
        if (value.facts !== undefined) lines.push(`facts: ${JSON.stringify(value.facts)}`)
        for (const warning of value.warnings) lines.push(`warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => ({
        outputPath: value.outputPath,
        format: value.format,
        bytes: value.bytes,
      }),
    },
    // Concurrent exports to DIFFERENT paths are safe; the registry serializes
    // identical calls anyway and each job runs in its own work directory.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.code.trim() === '') throw new Error('code must be a non-empty CadQuery or ezdxf script')
      if (!isAbsolute(args.output_path)) {
        throw new Error('output_path must be an absolute path')
      }
      const outputPath = resolveOutputPath(args.output_path, args.format)
      if (!args.overwrite && await fileExists(outputPath)) {
        throw new Error(`output file already exists: ${outputPath}; pass overwrite: true to replace it`)
      }

      const adapter = await requireAdapter(deps, { kind: 'export', format: args.format }, exec.signal)
      // Fail fast with a clear message when the code targets a different
      // backend than the export format routes to (e.g. CadQuery code → DXF).
      const sniffed = sniffBackend(args.code)
      if (sniffed !== undefined && sniffed !== adapter.id) {
        throw new Error(
          `format ${args.format} is served by the "${adapter.id}" backend, but this code targets "${sniffed}". Use ${sniffed === 'cadquery' ? 'STEP/IGES/STL/3MF for CadQuery code' : 'DXF for ezdxf code'}.`,
        )
      }
      const work = await prepareWorkDir(deps, exec, args.code)
      const result = await adapter.run({
        mode: 'export',
        code: args.code,
        workDir: work.dir,
        outputPath,
      }, exec.signal)

      return {
        outputPath: result.outputPath ?? outputPath,
        format: args.format,
        bytes: result.bytes ?? 0,
        ...result.facts !== undefined ? { facts: factsToJson(result.facts) } : {},
        warnings: [...result.warnings],
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Export CAD ${args.format.toUpperCase()}`,
      kind: 'other',
      locations: [{ path: args.output_path }],
    }),
  }))
}
