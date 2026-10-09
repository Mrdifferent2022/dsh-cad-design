import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { AdapterRegistry } from '../adapters/registry.ts'
import type { CadAdapter, CapabilityRequest } from '../adapters/types.ts'
import type { Config } from '../config.ts'
import { DEFAULT_TIMEOUT_SECONDS } from '../config.ts'
import { createWorkDir, resolveBaseDir, type CadWorkDir } from '../util/workdir.ts'

/** Services every cad tool closes over. */
export interface CadToolDeps {
  readonly ctx: Context
  readonly registry: AdapterRegistry
  readonly config: Config
}

/** Resolve an adapter for a capability or throw with a cad_doctor pointer. */
export async function requireAdapter(
  deps: CadToolDeps,
  request: CapabilityRequest,
  signal: AbortSignal,
): Promise<CadAdapter> {
  const adapter = await deps.registry.route(request, signal)
  if (adapter === undefined) {
    throw new Error(
      'no available CAD backend satisfies this request. Run cad_doctor to see what this machine supports and how to install a backend.',
    )
  }
  return adapter
}

/** Per-call scratch directory with the modeling script already written. */
export async function prepareWorkDir(
  deps: CadToolDeps,
  exec: ToolRunContext,
  code: string,
): Promise<CadWorkDir> {
  const sessionCwd = exec.agent?.session.header.cwd
  const baseDir = resolveBaseDir(deps.config.workDir, sessionCwd)
  return createWorkDir(baseDir, code)
}

export function timeoutSeconds(deps: CadToolDeps): number {
  return deps.config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS
}

/**
 * Whether the CURRENT model route can consume an image result. Mirrors the
 * read_image gate in dsh-tool-fs, but non-fatal: any uncertainty degrades to
 * a text-only result instead of refusing the call.
 */
export async function isImageCapableRoute(deps: CadToolDeps, exec: ToolRunContext): Promise<boolean> {
  try {
    const routed = exec.agent?.session.requestHeader()?.config
    const provider = routed?.provider ?? exec.agent?.options.provider
    const model = routed?.model ?? exec.agent?.options.model
    const llm = deps.ctx.get('llm')
    if (provider === undefined || model === undefined || llm === undefined) return false
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    return info.inputModalities !== undefined && info.inputModalities.includes('image')
  } catch {
    return false
  }
}

/** The plain-JSON image record carried inside a tool's canonical value. */
export interface ImageValue {
  attachmentId: string
  mediaType: 'image/png'
  bytes: number
  width: number
  height: number
  name?: string
}

/** Strip an attachment reference to its schema-declared JSON shape. */
export function imageValueFromRef(ref: ImageAttachmentRef): ImageValue {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: 'image/png',
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...ref.name === undefined ? {} : { name: ref.name },
  }
}
