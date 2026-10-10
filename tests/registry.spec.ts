import { describe, expect, it } from 'vitest'
import { AdapterRegistry, satisfies } from '../src/adapters/registry.ts'
import type { AdapterStatus, CadAdapter, CadJob, CadJobResult } from '../src/adapters/types.ts'
import { buildAdapters } from '../src/index.ts'

function fakeAdapter(overrides: {
  id: string
  available?: boolean
  modeling?: boolean
  preview?: boolean
  exportFormats?: readonly ('step' | 'stl' | '3mf' | 'iges')[]
}): CadAdapter & { detectCalls: number } {
  const state = { detectCalls: 0 }
  return {
    ...state,
    get detectCalls() { return state.detectCalls },
    id: overrides.id,
    displayName: overrides.id,
    capabilities: {
      ...(overrides.modeling ? { parametricModeling: { language: 'python' as const, headless: true } } : {}),
      ...(overrides.preview ? { renderPreview: { raster: true } } : {}),
      exportFormats: overrides.exportFormats ?? [],
      importFormats: [],
    },
    async detect(_signal: AbortSignal): Promise<AdapterStatus> {
      state.detectCalls += 1
      return { available: overrides.available ?? true }
    },
    async run(_job: CadJob, _signal: AbortSignal): Promise<CadJobResult> {
      return { echo: [], warnings: [] }
    },
  }
}

describe('satisfies', () => {
  it('matches capability requests against declared capabilities', () => {
    const full = fakeAdapter({ id: 'a', modeling: true, preview: true, exportFormats: ['step'] })
    expect(satisfies(full, { kind: 'model' })).toBe(true)
    expect(satisfies(full, { kind: 'preview' })).toBe(true)
    expect(satisfies(full, { kind: 'export', format: 'step' })).toBe(true)
    expect(satisfies(full, { kind: 'export', format: 'stl' })).toBe(false)

    const bare = fakeAdapter({ id: 'b' })
    expect(satisfies(bare, { kind: 'model' })).toBe(false)
    expect(satisfies(bare, { kind: 'preview' })).toBe(false)
  })

  it('honors an explicit backend id pin', () => {
    const full = fakeAdapter({ id: 'a', modeling: true })
    expect(satisfies(full, { kind: 'model', backend: 'a' })).toBe(true)
    expect(satisfies(full, { kind: 'model', backend: 'b' })).toBe(false)
  })
})

describe('AdapterRegistry', () => {
  it('rejects duplicate adapter ids', () => {
    const registry = new AdapterRegistry()
    registry.register(fakeAdapter({ id: 'x' }))
    expect(() => registry.register(fakeAdapter({ id: 'x' }))).toThrow(/duplicate adapter id/)
  })

  it('routes to the first AVAILABLE adapter satisfying the capability', async () => {
    const registry = new AdapterRegistry()
    registry.register(fakeAdapter({ id: 'down', available: false, modeling: true }))
    registry.register(fakeAdapter({ id: 'up', available: true, modeling: true }))
    const picked = await registry.route({ kind: 'model' }, new AbortController().signal)
    expect(picked?.id).toBe('up')
  })

  it('returns undefined when no adapter qualifies', async () => {
    const registry = new AdapterRegistry()
    registry.register(fakeAdapter({ id: 'down', available: false, modeling: true }))
    await expect(registry.route({ kind: 'model' }, new AbortController().signal)).resolves.toBeUndefined()
    await expect(registry.route({ kind: 'export', format: 'step' }, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('caches detect results until invalidated', async () => {
    const registry = new AdapterRegistry()
    const adapter = fakeAdapter({ id: 'cached' })
    registry.register(adapter)
    const signal = new AbortController().signal
    await registry.detect(adapter, signal)
    await registry.detect(adapter, signal)
    expect(adapter.detectCalls).toBe(1)
    registry.invalidate()
    await registry.detect(adapter, signal)
    expect(adapter.detectCalls).toBe(2)
  })
})

describe('buildAdapters (config routing & switches)', () => {
  it('includes cadquery and ezdxf by default, cadquery first', () => {
    expect(buildAdapters({}).map(a => a.id)).toEqual(['cadquery', 'ezdxf'])
  })

  it('drops disabled backends', () => {
    expect(buildAdapters({ cadquery: { enabled: false } }).map(a => a.id)).toEqual(['ezdxf'])
    expect(buildAdapters({ ezdxf: { enabled: false } }).map(a => a.id)).toEqual(['cadquery'])
    expect(buildAdapters({ cadquery: { enabled: false }, ezdxf: { enabled: false } })).toEqual([])
  })

  it('honors backendPriority ordering and ignores unknown ids', () => {
    const adapters = buildAdapters({ backendPriority: ['openscad', 'ezdxf', 'cadquery'] })
    expect(adapters.map(a => a.id)).toEqual(['ezdxf', 'cadquery'])
  })

  it('passes the pythonPath override through', () => {
    const [adapter] = buildAdapters({ cadquery: { pythonPath: 'C:/py/python.exe' } })
    expect(adapter).toBeDefined()
    expect((adapter as unknown as { options: { pythonPath?: string } }).options.pythonPath).toBe('C:/py/python.exe')
  })
})
