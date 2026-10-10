/**
 * dsh-cad-design — parametric CAD tools for the DeepSeek Harness.
 *
 * Registers cad_doctor / cad_validate / cad_render / cad_export plus the
 * cadquery-design skill. Backends are adapters behind a capability-routing
 * registry; `Config.backendPriority` reorders routing and each adapter has
 * an `enabled` switch, so users steer which CAD engine serves a request.
 * @module dsh-cad-design
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { CadAdapter } from './adapters/types.ts'
import { AdapterRegistry } from './adapters/registry.ts'
import { CadQueryAdapter } from './adapters/cadquery/index.ts'
import { EzdxfAdapter } from './adapters/ezdxf/index.ts'
import { Config, DEFAULT_TIMEOUT_SECONDS } from './config.ts'
import { applyCadDoctor } from './tools/doctor.ts'
import { applyCadValidate } from './tools/validate.ts'
import { applyCadRender } from './tools/render.ts'
import { applyCadExport } from './tools/export.ts'
import { applyCadConvert } from './tools/convert.ts'
import {
  CADQUERY_DESIGN_SKILL,
  CADQUERY_DESIGN_SKILL_DESCRIPTION,
  CADQUERY_DESIGN_SKILL_NAME,
} from './skills/cadquery-design.ts'
import {
  EZDXF_DRAFTING_SKILL,
  EZDXF_DRAFTING_SKILL_DESCRIPTION,
  EZDXF_DRAFTING_SKILL_NAME,
} from './skills/ezdxf-drafting.ts'

export const name = 'dsh-cad-design'
// attachments and llm are OPTIONAL services: cad_render probes them with
// ctx.get() and degrades to text when absent. Never hard-inject them.
export const inject = ['tools', 'skills']

export { Config }
export type { Config as DshCadConfig } from './config.ts'
export { AdapterRegistry } from './adapters/registry.ts'
export type { CadAdapter, CadCapabilities, CadJob, CadJobResult, CadFormat } from './adapters/types.ts'

/**
 * Build the adapter set for one config: every known backend, filtered by its
 * enabled switch, ordered by backendPriority (unlisted ids keep this order).
 * Future adapters (OpenSCAD, FreeCAD, commercial bridges) append here.
 */
export function buildAdapters(config: Config): CadAdapter[] {
  const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
  const pythonOptions = (section: { enabled?: boolean; pythonPath?: string } | undefined) => ({
    ...(section?.pythonPath !== undefined && section.pythonPath !== ''
      ? { pythonPath: section.pythonPath }
      : {}),
    timeoutSeconds,
  })
  const factories = new Map<string, () => CadAdapter>([
    ['cadquery', () => new CadQueryAdapter(pythonOptions(config.cadquery))],
    ['ezdxf', () => new EzdxfAdapter(pythonOptions(config.ezdxf))],
  ])

  const sections: Record<string, { enabled?: boolean } | undefined> = {
    cadquery: config.cadquery,
    ezdxf: config.ezdxf,
  }
  const enabled = (id: string): boolean => sections[id]?.enabled !== false

  const priority = config.backendPriority ?? []
  const orderedIds = [
    ...priority.filter(id => factories.has(id)),
    ...[...factories.keys()].filter(id => !priority.includes(id)),
  ]

  const adapters: CadAdapter[] = []
  for (const id of orderedIds) {
    if (!enabled(id)) continue
    adapters.push((factories.get(id) as () => CadAdapter)())
  }
  return adapters
}

export function apply(ctx: Context, config: Config = {}): void {
  const registry = new AdapterRegistry()
  for (const adapter of buildAdapters(config)) {
    registry.register(adapter)
  }

  const deps = { ctx, registry, config }
  applyCadDoctor(deps)
  applyCadValidate(deps)
  applyCadRender(deps)
  applyCadExport(deps)
  applyCadConvert(deps)

  if (config.enableSkill !== false) {
    ctx.skills.register({
      name: CADQUERY_DESIGN_SKILL_NAME,
      description: CADQUERY_DESIGN_SKILL_DESCRIPTION,
      content: CADQUERY_DESIGN_SKILL,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    ctx.skills.register({
      name: EZDXF_DRAFTING_SKILL_NAME,
      description: EZDXF_DRAFTING_SKILL_DESCRIPTION,
      content: EZDXF_DRAFTING_SKILL,
      source: 'runtime',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  }
}
