import { fileURLToPath } from 'node:url'

/**
 * Parse the single JSON line a runner prints on stdout. Banners or leaked
 * output may precede it, so scan from the END for the first line that parses
 * as a JSON object (ported from beaglar's parseRunnerOutput).
 */
export function parseRunnerOutput(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split(/\r?\n/).filter(line => line.trim() !== '')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = (lines[i] as string).trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // keep scanning
    }
  }
  return undefined
}

/**
 * Absolute path to a bundled runner script. Works from both `lib/` (built,
 * published) and `src/` (--patch development) because both sit one directory
 * below the package root, and `runners/` is a package-root sibling.
 */
export function runnerPath(fileName: string): string {
  return fileURLToPath(new URL(`../../runners/${fileName}`, import.meta.url))
}
