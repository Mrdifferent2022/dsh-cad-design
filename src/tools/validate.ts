import { defineTool } from '@deepseek-ai/dsh-tools'
import { prepareWorkDir, requireAdapter, type CadToolDeps } from './shared.ts'

/** Lossless JSON value (kept local to avoid a dsh-session type dependency). */
export type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike }

/** A facts object with undefined fields stripped, safe for the JSON schema. */
export function factsToJson(facts: object): Record<string, JsonLike> {
  return JSON.parse(JSON.stringify(facts)) as Record<string, JsonLike>
}

/**
 * `cad_validate`: fast check of CadQuery modeling code. Domain failures
 * (syntax errors, missing `result`, invalid geometry) come back as
 * `valid: false` — throwing is reserved for infrastructure failures.
 */
export function applyCadValidate(deps: CadToolDeps): void {
  deps.ctx.tools.register(defineTool({
    name: 'cad_validate',
    description: 'Validate CadQuery Python modeling code without rendering a preview. Prefer cad_render for design iteration — it executes, validates, AND previews in one call; use cad_validate only for a quick syntax/geometry check when no preview is wanted. Returns valid:false with errors for bad code or invalid solids — fix the code and retry. Requires the script to assign the model to a top-level `result` variable.',
    parameters: {
      code: { type: 'string', required: true, description: 'CadQuery Python source. Must assign the final model to a top-level `result` variable (Workplane/Shape/list), or define `model()`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true },
          facts: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' }, required: true },
          echo: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => {
        const lines: string[] = [value.valid ? '✓ code and geometry are valid' : '✗ geometry is INVALID']
        if (value.facts !== undefined) lines.push(`facts: ${JSON.stringify(value.facts)}`)
        for (const warning of value.warnings) lines.push(`warning: ${warning}`)
        for (const line of value.echo) lines.push(`echo: ${line}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.code.trim() === '') throw new Error('code must be a non-empty CadQuery script')
      const adapter = await requireAdapter(deps, { kind: 'model' }, exec.signal)
      const work = await prepareWorkDir(deps, exec, args.code)
      const result = await adapter.run({
        mode: 'validate',
        code: args.code,
        workDir: work.dir,
      }, exec.signal)
      return {
        valid: result.valid ?? false,
        ...result.facts !== undefined ? { facts: factsToJson(result.facts) } : {},
        warnings: [...result.warnings],
        echo: [...result.echo],
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Validate CAD code', kind: 'read' }),
  }))
}
