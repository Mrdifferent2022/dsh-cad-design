import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One tool call's scratch directory layout. */
export interface CadWorkDir {
  /** Absolute per-call directory, e.g. <cwd>/.dsh/cad/20261009-153000-123-ab12cd. */
  readonly dir: string
  readonly scriptPath: string
  readonly jobPath: string
  readonly svgPath: string
  readonly pngPath: string
}

/**
 * Create a unique per-call working directory. Every call gets its own
 * timestamped directory so concurrent calls never collide and artifacts stay
 * inspectable after the call.
 */
export async function createWorkDir(baseDir: string, code: string): Promise<CadWorkDir> {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\..+$/, '')
  const suffix = Math.random().toString(36).slice(2, 8)
  const dir = join(baseDir, `${stamp}-${suffix}`)
  await mkdir(dir, { recursive: true })
  const work: CadWorkDir = {
    dir,
    scriptPath: join(dir, 'model.py'),
    jobPath: join(dir, 'job.json'),
    svgPath: join(dir, 'preview.svg'),
    pngPath: join(dir, 'preview.png'),
  }
  await writeFile(work.scriptPath, code, 'utf-8')
  return work
}

/**
 * Resolve the artifact base directory for one call: explicit config wins,
 * then the session workspace, then the process cwd.
 */
export function resolveBaseDir(configured: string | undefined, sessionCwd: string | undefined): string {
  if (configured !== undefined && configured.trim() !== '') return configured
  return join(sessionCwd ?? process.cwd(), '.dsh', 'cad')
}
