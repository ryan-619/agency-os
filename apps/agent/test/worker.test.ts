/**
 * The worker can be imported without being started.
 *
 * `apps/agent/src/index.ts` used to BE the worker and call `main()` at module
 * scope, so importing it booted a health server, a pool and an advisory lock
 * against whatever DATABASE_URL said and, on failure, called
 * `process.exit(1)` out from under the importer. That is why the voice
 * service was split into `index.ts` (the service) and `main.ts` (starting
 * it), and why the agent now has `worker.ts` (the worker) behind `index.ts`
 * (starting it) — the entry keeps its name because the image, the package
 * scripts and `tools/run-worker.sh` all start it by that name.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Server } from 'node:net'

describe('worker.ts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('imports without listening, exiting, or taking a signal', async () => {
    const listen = vi.spyOn(Server.prototype, 'listen')
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit was called by an import')
    }) as never)
    const signals = { SIGTERM: process.listenerCount('SIGTERM'), SIGINT: process.listenerCount('SIGINT') }

    const worker = await import('../src/worker.js')

    expect(typeof worker.startWorker).toBe('function')
    expect(listen).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(process.listenerCount('SIGTERM')).toBe(signals.SIGTERM)
    expect(process.listenerCount('SIGINT')).toBe(signals.SIGINT)
  })

  /**
   * The process is the entrypoint's: its signals and its exit code. A
   * `process.exit` inside the worker is the old shape coming back by another
   * route — a test that started it would be killed by its own shutdown.
   */
  it('leaves the process to index.ts', () => {
    const read = (file: string) =>
      readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
    const worker = read('worker.ts')
    expect(worker).not.toMatch(/process\.exit\b/)
    expect(worker).not.toMatch(/process\.on\(/)
    expect(worker).not.toMatch(/\bloadEnv\(/)
    const entry = read('index.ts')
    expect(entry).toMatch(/startWorker\(/)
    expect(entry).toMatch(/process\.on\('SIGTERM'/)
  })
})
