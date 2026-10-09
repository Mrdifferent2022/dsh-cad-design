import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRunnerOutput, runnerPath } from '../src/util/runner.ts'
import { runProcess } from '../src/util/proc.ts'

describe('parseRunnerOutput', () => {
  it('parses a clean single JSON line', () => {
    expect(parseRunnerOutput('{"success":true}\n')).toEqual({ success: true })
  })

  it('scans from the end past banners and noise', () => {
    const stdout = [
      'OCCT banner line',
      'some warning printed by a library',
      '{"success":true,"facts":{"solids":1}}',
      '',
    ].join('\n')
    expect(parseRunnerOutput(stdout)).toEqual({ success: true, facts: { solids: 1 } })
  })

  it('prefers the LAST json line when several appear', () => {
    const stdout = '{"echoed":1}\n{"success":false,"error":"boom"}\n'
    expect(parseRunnerOutput(stdout)).toEqual({ success: false, error: 'boom' })
  })

  it('returns undefined when nothing parses', () => {
    expect(parseRunnerOutput('not json at all\n[1,2,3]\n')).toBeUndefined()
    expect(parseRunnerOutput('')).toBeUndefined()
  })

  it('skips json arrays and non-object values', () => {
    expect(parseRunnerOutput('[1,2]\n42\n"str"\n')).toBeUndefined()
  })
})

describe('runnerPath', () => {
  it('resolves the bundled cadquery runner relative to the package root', () => {
    const path = runnerPath('cadquery_runner.py')
    expect(path.replaceAll('\\', '/')).toMatch(/runners\/cadquery_runner\.py$/)
    expect(existsSync(path)).toBe(true)
  })
})

describe('runProcess', () => {
  it('captures stdout and exit code', async () => {
    const result = await runProcess(process.execPath, ['-e', 'console.log("hello")'], {
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hello')
    expect(result.timedOut).toBe(false)
  })

  it('rejects with AbortedError when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runProcess(process.execPath, ['-e', '1'], {
      timeoutMs: 10_000,
      signal: controller.signal,
    })).rejects.toThrow('operation aborted')
  })

  it('kills a process that exceeds its timeout', async () => {
    const started = Date.now()
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      timeoutMs: 500,
      signal: new AbortController().signal,
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)
})
