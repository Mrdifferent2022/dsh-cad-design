import type { AdapterStatus, CadAdapter, CapabilityRequest } from './types.ts'

/** One registry row: adapter plus its last probe result. */
export interface AdapterEntry {
  readonly adapter: CadAdapter
  readonly status: AdapterStatus
}

/**
 * Process-local adapter registry with capability routing.
 *
 * Detection results are cached for the plugin lifetime (backend installations
 * do not change mid-session; `invalidate()` exists for future config reloads).
 * Routing returns the first AVAILABLE adapter that satisfies the request, in
 * registration order — `backendPriority` config reorders registration, so
 * priority is a config concern, not a routing concern.
 */
export class AdapterRegistry {
  private readonly adapters: CadAdapter[] = []
  private readonly statusCache = new Map<string, AdapterStatus>()

  /** Register an adapter; duplicate ids throw. */
  register(adapter: CadAdapter): void {
    if (this.adapters.some(existing => existing.id === adapter.id)) {
      throw new Error(`dsh-cad-design: duplicate adapter id "${adapter.id}"`)
    }
    this.adapters.push(adapter)
  }

  /** All registered adapters in priority (registration) order. */
  list(): readonly CadAdapter[] {
    return this.adapters
  }

  /** Drop cached probe results (e.g. after the user installs a backend). */
  invalidate(): void {
    this.statusCache.clear()
  }

  /** Probe one adapter with caching; never throws. */
  async detect(adapter: CadAdapter, signal: AbortSignal): Promise<AdapterStatus> {
    const cached = this.statusCache.get(adapter.id)
    if (cached !== undefined) return cached
    const status = await adapter.detect(signal)
    this.statusCache.set(adapter.id, status)
    return status
  }

  /** Probe every adapter (the `cad_doctor` capability matrix). */
  async detectAll(signal: AbortSignal): Promise<AdapterEntry[]> {
    const entries: AdapterEntry[] = []
    for (const adapter of this.adapters) {
      entries.push({ adapter, status: await this.detect(adapter, signal) })
    }
    return entries
  }

  /**
   * Pick the first available adapter satisfying a capability request.
   * Returns undefined when nothing qualifies — the caller renders the
   * "no backend" error with a cad_doctor pointer.
   */
  async route(request: CapabilityRequest, signal: AbortSignal): Promise<CadAdapter | undefined> {
    for (const adapter of this.adapters) {
      if (!satisfies(adapter, request)) continue
      const status = await this.detect(adapter, signal)
      if (status.available) return adapter
    }
    return undefined
  }
}

/** Pure capability match, independent of machine availability. */
export function satisfies(adapter: CadAdapter, request: CapabilityRequest): boolean {
  if (request.backend !== undefined && adapter.id !== request.backend) return false
  const caps = adapter.capabilities
  switch (request.kind) {
    case 'model':
      return caps.parametricModeling !== undefined
    case 'preview':
      return caps.renderPreview !== undefined
    case 'export':
      return caps.exportFormats.includes(request.format)
  }
}
