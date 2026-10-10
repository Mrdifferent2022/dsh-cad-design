/**
 * Sniff which backend a modeling script targets from its imports.
 *
 * The runner contract requires the script to import its CAD library, so a
 * top-level `import ezdxf` / `from cadquery import ...` is a reliable signal.
 * Returns the adapter id, or undefined when no known library is imported —
 * the caller then falls back to capability routing in priority order.
 */
export function sniffBackend(code: string): string | undefined {
  if (/^\s*(import\s+ezdxf|from\s+ezdxf[\s.])/m.test(code)) return 'ezdxf'
  if (/^\s*(import\s+cadquery|from\s+cadquery[\s.])/m.test(code)) return 'cadquery'
  return undefined
}
