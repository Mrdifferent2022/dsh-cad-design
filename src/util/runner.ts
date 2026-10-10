import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { CadFacts, CadJob, CadJobResult } from '../adapters/types.ts'
import { runProcess } from './proc.ts'
import { splitPythonCommand } from './python.ts'

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

/**
 * Shared body of every Python-backend adapter's run(): write job.json, spawn
 * `python <runner> --job job.json` from the work directory, parse the single
 * result line. Domain failures (success != true) throw with the runner's
 * error and traceback; timeouts and unparseable output are infrastructure
 * failures and throw likewise.
 */
export async function runPythonRunnerJob(
  backendLabel: string,
  runnerFile: string,
  pythonExecutable: string,
  timeoutSeconds: number,
  job: CadJob,
  signal: AbortSignal,
): Promise<CadJobResult> {
  const jobPayload: Record<string, unknown> = {
    mode: job.mode,
    script_path: `${job.workDir}/model.py`,
  }
  if (job.inputPath !== undefined) jobPayload['input_path'] = job.inputPath
  if (job.outputPath !== undefined) jobPayload['output_path'] = job.outputPath
  if (job.svgPath !== undefined) jobPayload['svg_out'] = job.svgPath
  if (job.pngPath !== undefined) jobPayload['png_out'] = job.pngPath
  const jobJsonPath = `${job.workDir}/job.json`
  await writeFile(jobJsonPath, JSON.stringify(jobPayload, null, 2), 'utf-8')

  const { command, prefixArgs } = splitPythonCommand(pythonExecutable)
  const result = await runProcess(command, [
    ...prefixArgs,
    runnerPath(runnerFile),
    '--job',
    jobJsonPath,
  ], {
    cwd: job.workDir,
    timeoutMs: timeoutSeconds * 1000,
    signal,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    },
  })

  if (result.timedOut) {
    throw new Error(
      `${backendLabel} job timed out after ${String(timeoutSeconds)}s; simplify the model or raise the timeoutSeconds config`,
    )
  }

  const parsed = parseRunnerOutput(result.stdout)
  if (parsed === undefined) {
    const tail = result.stderr.trim().split('\n').slice(-5).join('\n')
    throw new Error(
      `${backendLabel} runner produced no parseable result (exit ${String(result.code)})${tail !== '' ? `:\n${tail}` : ''}`,
    )
  }
  if (parsed['success'] !== true) {
    const message = typeof parsed['error'] === 'string' ? parsed['error'] : 'unknown runner error'
    const trace = typeof parsed['traceback'] === 'string' ? `\n${parsed['traceback']}` : ''
    throw new Error(`${backendLabel} job failed: ${message}${trace}`)
  }

  return {
    ...(parsed['facts'] !== undefined ? { facts: parsed['facts'] as CadFacts } : {}),
    ...(typeof parsed['valid'] === 'boolean' ? { valid: parsed['valid'] } : {}),
    ...(typeof parsed['svg'] === 'string' ? { svgPath: parsed['svg'] } : {}),
    ...(typeof parsed['png'] === 'string' ? { pngPath: parsed['png'] } : {}),
    ...(typeof parsed['output_path'] === 'string' ? { outputPath: parsed['output_path'] } : {}),
    ...(typeof parsed['bytes'] === 'number' ? { bytes: parsed['bytes'] } : {}),
    echo: Array.isArray(parsed['echo']) ? parsed['echo'] as string[] : [],
    warnings: Array.isArray(parsed['warnings']) ? parsed['warnings'] as string[] : [],
  }
}

