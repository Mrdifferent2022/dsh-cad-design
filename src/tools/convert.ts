import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { FORMAT_BY_EXTENSION } from '../adapters/types.ts'
import { prepareWorkDir, requireAdapter, type CadToolDeps } from './shared.ts'
import { factsToJson } from './validate.ts'

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Map a path's extension to a format, or throw listing what we know. */
function formatOf(path: string, role: string) {
  const match = /\.([a-z0-9]+)$/i.exec(path)
  const ext = match?.[1]?.toLowerCase()
  const format = ext !== undefined ? FORMAT_BY_EXTENSION[ext] : undefined
  if (format === undefined) {
    throw new Error(
      `${role} path has no recognized CAD extension: ${path}. Known: ${Object.keys(FORMAT_BY_EXTENSION).join(', ')}`,
    )
  }
  return format
}

/**
 * `cad_convert`: file→file format conversion, routed to the first backend
 * that reads the input format and writes the output format. CadQuery covers
 * STEP/BREP → STEP/IGES/STL/3MF; ezdxf covers DXF → DXF repair/normalize
 * passes (tolerant read, audit, TEXT repairs, rewrite).
 */
export function applyCadConvert(deps: CadToolDeps): void {
  deps.ctx.tools.register(defineTool({
    name: 'cad_convert',
    description: 'Convert a CAD file from one format to another (extensions select the formats): STEP/BREP → STEP/IGES/STL/3MF via CadQuery, DXF → DXF repair-and-normalize via ezdxf. The result contains the absolute output path and byte size — do NOT re-verify with shell commands. Refuses to overwrite unless overwrite is true.',
    parameters: {
      input_path: { type: 'string', required: true, description: 'Absolute path of the source CAD file; the extension selects the input format.' },
      output_path: { type: 'string', required: true, description: 'Absolute path of the target file; the extension selects the output format.' },
      overwrite: { type: 'boolean', description: 'Allow replacing an existing output_path. Default false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outputPath: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          backend: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          facts: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `✓ converted ${value.from.toUpperCase()} → ${value.to.toUpperCase()} (${value.backend}): ${value.outputPath} (${String(value.bytes)} bytes)`,
        ]
        if (value.facts !== undefined) lines.push(`facts: ${JSON.stringify(value.facts)}`)
        for (const warning of value.warnings) lines.push(`warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => ({
        outputPath: value.outputPath,
        format: value.to,
        bytes: value.bytes,
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!isAbsolute(args.input_path) || !isAbsolute(args.output_path)) {
        throw new Error('input_path and output_path must be absolute paths')
      }
      if (args.input_path === args.output_path) {
        throw new Error('input_path and output_path must differ')
      }
      if (!await fileExists(args.input_path)) {
        throw new Error(`input file not found: ${args.input_path}`)
      }
      const from = formatOf(args.input_path, 'input')
      const to = formatOf(args.output_path, 'output')
      if (!args.overwrite && await fileExists(args.output_path)) {
        throw new Error(`output file already exists: ${args.output_path}; pass overwrite: true to replace it`)
      }

      const adapter = await requireAdapter(deps, { kind: 'convert', from, to }, exec.signal)
      const work = await prepareWorkDir(deps, exec, '')
      const result = await adapter.run({
        mode: 'convert',
        code: '',
        workDir: work.dir,
        inputPath: args.input_path,
        outputPath: args.output_path,
      }, exec.signal)

      return {
        outputPath: result.outputPath ?? args.output_path,
        from,
        to,
        backend: adapter.id,
        bytes: result.bytes ?? 0,
        ...result.facts !== undefined ? { facts: factsToJson(result.facts) } : {},
        warnings: [...result.warnings],
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Convert CAD file',
      kind: 'other',
      locations: [{ path: args.input_path }, { path: args.output_path }],
    }),
  }))
}
