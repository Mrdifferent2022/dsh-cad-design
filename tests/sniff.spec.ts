import { describe, expect, it } from 'vitest'
import { sniffBackend } from '../src/util/sniff.ts'

describe('sniffBackend', () => {
  it('detects ezdxf imports', () => {
    expect(sniffBackend('import ezdxf\nresult = ezdxf.new()\n')).toBe('ezdxf')
    expect(sniffBackend('from ezdxf import new\n')).toBe('ezdxf')
    expect(sniffBackend('from ezdxf.enums import TextEntityAlignment\n')).toBe('ezdxf')
  })

  it('detects cadquery imports', () => {
    expect(sniffBackend('import cadquery as cq\nresult = cq.Workplane("XY").box(1,1,1)\n')).toBe('cadquery')
    expect(sniffBackend('from cadquery import Workplane\n')).toBe('cadquery')
  })

  it('returns undefined when no known CAD library is imported', () => {
    expect(sniffBackend('import math\nprint(math.pi)\n')).toBeUndefined()
    expect(sniffBackend('')).toBeUndefined()
  })

  it('ignores mentions in comments and strings', () => {
    expect(sniffBackend('# use ezdxf for this\nimport cadquery as cq\n')).toBe('cadquery')
    // A bare mention without the import keyword is not a signal.
    expect(sniffBackend('print("ezdxf")\n')).toBeUndefined()
  })
})
