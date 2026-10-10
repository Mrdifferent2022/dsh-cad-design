import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CadQueryAdapter } from '../src/adapters/cadquery/index.ts'
import { createWorkDir } from '../src/util/workdir.ts'

/**
 * End-to-end tests against a real Python + CadQuery install.
 * The whole file skips when the backend is not detectable.
 */
const adapter = new CadQueryAdapter({ timeoutSeconds: 240 })
const status = await adapter.detect(new AbortController().signal)

describe.skipIf(!status.available)('cadquery e2e (real backend)', () => {
  it('detect reports a version', () => {
    expect(status.available).toBe(true)
    expect(status.version).toMatch(/cadquery/)
  })

  it('validate accepts a simple box', async () => {
    const work = await makeWork('result = cq.Workplane("XY").box(10, 20, 5)\n')
    try {
      const result = await adapter.run(
        { mode: 'validate', code: '', workDir: work.dir },
        new AbortController().signal,
      )
      expect(result.valid).toBe(true)
      expect(result.facts?.solids).toBe(1)
      expect(result.facts?.volume_mm3).toBe(1000)
      expect(result.facts?.bbox_mm?.size).toEqual([10, 20, 5])
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('validate flags a script without result', async () => {
    const work = await makeWork('box = cq.Workplane("XY").box(1, 1, 1)\n')
    try {
      await expect(adapter.run(
        { mode: 'validate', code: '', workDir: work.dir },
        new AbortController().signal,
      )).rejects.toThrow(/result/)
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('render produces an SVG preview (and PNG when a rasterizer is installed)', async () => {
    const work = await makeWork(
      'result = cq.Workplane("XY").box(10, 10, 10).faces(">Z").hole(4)\n',
    )
    try {
      const result = await adapter.run(
        { mode: 'render', code: '', workDir: work.dir, svgPath: work.svgPath, pngPath: work.pngPath },
        new AbortController().signal,
      )
      expect(result.svgPath).toBe(work.svgPath)
      // PNG requires cairosvg or svglib+reportlab; when neither is installed
      // the runner must say so instead of failing the render.
      if (result.pngPath === undefined) {
        expect(result.warnings.join('\n')).toMatch(/PNG preview skipped/)
      } else {
        expect(result.pngPath).toBe(work.pngPath)
      }
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('export writes a STEP file', async () => {
    const work = await makeWork('result = cq.Workplane("XY").box(8, 8, 8)\n')
    const outputPath = join(work.dir, 'part.step')
    try {
      const result = await adapter.run(
        { mode: 'export', code: '', workDir: work.dir, outputPath },
        new AbortController().signal,
      )
      expect(result.outputPath).toBe(outputPath)
      expect(result.bytes).toBeGreaterThan(1000)
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('convert turns a STEP file into STL', async () => {
    const work = await makeWork('result = cq.Workplane("XY").box(10, 10, 4)\n')
    const stepPath = join(work.dir, 'part.step')
    const stlPath = join(work.dir, 'part.stl')
    try {
      await adapter.run(
        { mode: 'export', code: '', workDir: work.dir, outputPath: stepPath },
        new AbortController().signal,
      )
      const result = await adapter.run(
        { mode: 'convert', code: '', workDir: work.dir, inputPath: stepPath, outputPath: stlPath },
        new AbortController().signal,
      )
      expect(result.outputPath).toBe(stlPath)
      expect(result.bytes).toBeGreaterThan(100)
      expect(result.facts?.volume_mm3).toBe(400)
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('handles a non-ASCII (CJK) work directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-cad-零件-'))
    const code = 'import cadquery as cq\nresult = cq.Workplane("XY").box(3, 3, 3)\n'
    const work = await createWorkDir(base, code)
    try {
      const result = await adapter.run(
        { mode: 'validate', code, workDir: work.dir },
        new AbortController().signal,
      )
      expect(result.valid).toBe(true)
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

async function makeWork(code: string) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cad-e2e-'))
  return createWorkDir(base, `import cadquery as cq\n${code}`)
}
