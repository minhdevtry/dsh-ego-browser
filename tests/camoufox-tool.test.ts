import { describe, expect, it, vi } from 'vitest'
import { registerCamoufoxTool, type CamoufoxToolEngine } from '../src/camoufox/tools.ts'

function setup(enabled: boolean, result: Record<string, unknown> = { ok: true }) {
  const engine: CamoufoxToolEngine = {
    execute: vi.fn(async () => result),
    status: vi.fn(() => ({ ok: true, running: false })),
    dispose: vi.fn(async () => {}),
  }
  let tool: any
  registerCamoufoxTool(t => { tool = t }, engine, () => enabled)
  return { engine, tool }
}

describe('ego_camoufox tool seam', () => {
  it('does not launch or execute a disabled backend', async () => {
    const { engine, tool } = setup(false)
    const result = await tool.execute({ action: 'open', url: 'https://example.com' }, {})
    expect(result).toMatchObject({ ok: false, code: 'DISABLED' })
    expect(engine.execute).not.toHaveBeenCalled()
  })

  it('reports disabled status without launching', async () => {
    const { engine, tool } = setup(false)
    const result = await tool.execute({ action: 'status' }, {})
    expect(result).toMatchObject({ ok: true, enabled: false, running: false })
    expect(engine.execute).not.toHaveBeenCalled()
  })

  it('delegates an enabled action to the engine', async () => {
    const { engine, tool } = setup(true, { ok: true, title: 'Example' })
    const args = { action: 'open', url: 'https://example.com' }
    const result = await tool.execute(args, {})
    expect(engine.execute).toHaveBeenCalledWith('open', args)
    expect(result).toMatchObject({ ok: true, enabled: true, title: 'Example' })
  })

  it('redacts secret-bearing keys and proxy credentials before returning results', async () => {
    const { tool } = setup(true, {
      ok: false,
      error: 'proxy http://alice:super-secret@proxy.test:8080 failed',
      nested: { password: 'pw', accessToken: 'at', cf_clearance: 'cf', harmless: 'kept' },
    })
    const result = await tool.execute({ action: 'open', url: 'https://example.com' }, {})
    expect(result.error).not.toContain('super-secret')
    expect(result.nested).toEqual({ password: '<redacted>', accessToken: '<redacted>', cf_clearance: '<redacted>', harmless: 'kept' })
  })

  it('uses the observation wrapper when supplied', async () => {
    const engine: CamoufoxToolEngine = {
      execute: vi.fn(async () => ({ ok: true })),
      status: vi.fn(() => ({ ok: true })),
      dispose: async () => {},
    }
    let tool: any
    const wrap = vi.fn(async (_args, _exec, run) => run())
    registerCamoufoxTool(t => { tool = t }, engine, () => true, wrap)
    await tool.execute({ action: 'status' }, { signal: undefined })
    expect(wrap).toHaveBeenCalledOnce()
    expect(engine.status).toHaveBeenCalledOnce()
  })
})
