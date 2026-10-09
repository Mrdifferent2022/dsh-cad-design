import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CadToolDeps } from './shared.ts'

/**
 * `cad_doctor`: probe every registered backend and report the capability
 * matrix. Every other cad tool's "backend missing" error points here.
 */
export function applyCadDoctor(deps: CadToolDeps): void {
  deps.ctx.tools.register(defineTool({
    name: 'cad_doctor',
    description: 'Check which CAD backends (CadQuery, future OpenSCAD/FreeCAD/commercial CAD bridges) are available on this machine. Reports a capability matrix: parametric modeling, preview rendering, export formats (STEP/IGES/STL/3MF), and geometry analysis, plus install hints for anything missing. Call this first when a cad_* tool reports no available backend.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          backends: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                displayName: { type: 'string', required: true },
                available: { type: 'boolean', required: true },
                modelingLanguage: { type: 'string' },
                exportFormats: { type: 'array', items: { type: 'string' }, required: true },
                executablePath: { type: 'string' },
                version: { type: 'string' },
                installHint: { type: 'string' },
                missingReason: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.backends.map(backend => {
          const head = `${backend.available ? '✓' : '✗'} ${backend.displayName} [${backend.id}]`
          const details: string[] = []
          if (backend.version !== undefined) details.push(`  version: ${backend.version}`)
          if (backend.executablePath !== undefined) details.push(`  executable: ${backend.executablePath}`)
          if (backend.modelingLanguage !== undefined) details.push(`  modeling: ${backend.modelingLanguage}`)
          details.push(`  export formats: ${backend.exportFormats.length > 0 ? backend.exportFormats.join(', ') : '(none)'}`)
          if (!backend.available) {
            if (backend.missingReason !== undefined) details.push(`  missing: ${backend.missingReason}`)
            if (backend.installHint !== undefined) details.push(`  install: ${backend.installHint}`)
          }
          return [head, ...details].join('\n')
        }).join('\n\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const entries = await deps.registry.detectAll(exec.signal)
      return {
        backends: entries.map(({ adapter, status }) => ({
          id: adapter.id,
          displayName: adapter.displayName,
          available: status.available,
          ...adapter.capabilities.parametricModeling !== undefined
            ? { modelingLanguage: adapter.capabilities.parametricModeling.language }
            : {},
          exportFormats: [...adapter.capabilities.exportFormats],
          ...status.executablePath !== undefined ? { executablePath: status.executablePath } : {},
          ...status.version !== undefined ? { version: status.version } : {},
          ...status.installHint !== undefined && !status.available ? { installHint: status.installHint } : {},
          ...status.missingReason !== undefined && !status.available ? { missingReason: status.missingReason } : {},
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check CAD backends', kind: 'read' }),
  }))
}
