import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EzdxfAdapter } from '../src/adapters/ezdxf/index.ts'
import { createWorkDir } from '../src/util/workdir.ts'

/**
 * End-to-end tests against a real Python + ezdxf install.
 * The whole file skips when the backend is not detectable.
 */
const adapter = new EzdxfAdapter({ timeoutSeconds: 120 })
const status = await adapter.detect(new AbortController().signal)

describe.skipIf(!status.available)('ezdxf e2e (real backend)', () => {
  it('detect reports a version', () => {
    expect(status.available).toBe(true)
    expect(status.version).toMatch(/ezdxf/)
  })

  it('validate accepts a drawing with entities', async () => {
    const work = await makeWork(
      'result = doc = ezdxf.new()\n'
      + 'msp = doc.modelspace()\n'
      + 'doc.layers.add("OUTLINE", color=7)\n'
      + 'msp.add_circle((0, 0), 40, dxfattribs={"layer": "OUTLINE"})\n'
      + 'msp.add_line((-50, 0), (50, 0), dxfattribs={"layer": "OUTLINE"})\n',
    )
    try {
      const result = await adapter.run(
        { mode: 'validate', code: '', workDir: work.dir },
        new AbortController().signal,
      )
      expect(result.valid).toBe(true)
      expect(result.facts?.entities).toBe(2)
      expect(result.facts?.layers).toContain('OUTLINE')
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('validate flags a drawing with 0 entities as invalid (domain result)', async () => {
    const work = await makeWork('result = ezdxf.new()\n')
    try {
      const result = await adapter.run(
        { mode: 'validate', code: '', workDir: work.dir },
        new AbortController().signal,
      )
      expect(result.valid).toBe(false)
      expect(result.warnings.join('\n')).toMatch(/0 entities/)
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('repairs aligned TEXT missing align_point and reports texts_fixed', async () => {
    const work = await makeWork(
      'result = doc = ezdxf.new()\n'
      + 'msp = doc.modelspace()\n'
      + 't = msp.add_text("Ø40 H7", height=3.5)\n'
      // The classic LLM defect: alignment set without set_placement().
      + 't.dxf.halign = 1\nt.dxf.valign = 3\n'
      + 'msp.add_line((0, 0), (80, 0))\n',
    )
    try {
      const result = await adapter.run(
        { mode: 'validate', code: '', workDir: work.dir },
        new AbortController().signal,
      )
      expect(result.valid).toBe(true)
      expect(result.facts?.texts_fixed).toBe(1)
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('render produces SVG and PNG previews, CJK text included', async () => {
    const work = await makeWork(
      'result = doc = ezdxf.new()\n'
      + 'msp = doc.modelspace()\n'
      + 'doc.styles.add("CN", font="simsun.ttc")\n'
      + 'msp.add_circle((0, 0), 40)\n'
      + 'msp.add_text("技术要求", height=5, dxfattribs={"style": "CN"})\n',
    )
    try {
      const result = await adapter.run(
        { mode: 'render', code: '', workDir: work.dir, svgPath: work.svgPath, pngPath: work.pngPath },
        new AbortController().signal,
      )
      expect(result.svgPath).toBe(work.svgPath)
      expect(result.pngPath).toBe(work.pngPath)
      expect(result.facts?.entities).toBe(2)
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('export writes a DXF file', async () => {
    const work = await makeWork(
      'result = doc = ezdxf.new()\n'
      + 'msp = doc.modelspace()\n'
      + 'msp.add_lwpolyline([(0, 0), (80, 0), (80, 60), (0, 60)], close=True)\n',
    )
    const outputPath = join(work.dir, 'drawing.dxf')
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

  it('convert rewrites a DXF (repair pass applies TEXT fixes)', async () => {
    const work = await makeWork(
      'result = doc = ezdxf.new()\n'
      + 'msp = doc.modelspace()\n'
      + 't = msp.add_text("修复测试", height=3.5)\n'
      + 't.dxf.halign = 1\n'
      + 'msp.add_circle((0, 0), 25)\n',
    )
    const inputPath = join(work.dir, 'in.dxf')
    const outputPath = join(work.dir, 'out.dxf')
    try {
      await adapter.run(
        { mode: 'export', code: '', workDir: work.dir, outputPath: inputPath },
        new AbortController().signal,
      )
      const result = await adapter.run(
        { mode: 'convert', code: '', workDir: work.dir, inputPath, outputPath },
        new AbortController().signal,
      )
      expect(result.outputPath).toBe(outputPath)
      expect(result.bytes).toBeGreaterThan(1000)
      expect(result.facts?.entities).toBe(2)
    } finally {
      await rm(work.dir, { recursive: true, force: true })
    }
  })

  it('handles a non-ASCII (CJK) work directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-cad-图纸-'))
    const code = 'import ezdxf\nresult = doc = ezdxf.new()\ndoc.modelspace().add_circle((0, 0), 10)\n'
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
  const base = await mkdtemp(join(tmpdir(), 'dsh-cad-dxf-e2e-'))
  return createWorkDir(base, `import ezdxf\n${code}`)
}
