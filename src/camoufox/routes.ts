// HTTP routes for the embedded Camoufox panel. Registered on the host webServer
// with the same dsh-auth cookie trust fence as the other /api/ego/* routes.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EmbeddedCamoufox } from './embedded.ts'

interface WebServerLike { register: (opts: { kind: string; path: string; handler?: (req: unknown, res: unknown) => unknown }) => () => void }
interface CtxLike { get?: (name: string) => unknown; effect?: (fn: () => () => void, label?: string) => void }

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

export function registerCamoufoxRoutes(ctx: CtxLike, embedded: EmbeddedCamoufox): void {
  const rawServer = ctx.get?.('webServer') as WebServerLike | undefined
  if (!rawServer || typeof rawServer.register !== 'function') return
  const isTrusted = (req: IncomingMessage): boolean => /(?:^|;\s*)dsh-auth-[^=]+=/.test(String(req.headers.cookie ?? ''))
  const guard = (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => async (req: unknown, resRaw: unknown) => {
    const res = resRaw as ServerResponse
    if (!isTrusted(req as IncomingMessage)) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
    return handler(req as IncomingMessage, res)
  }
  const disposers: Array<() => void> = []
  const reg = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    disposers.push(rawServer.register({ kind: 'exact', path, handler: guard(handler) }))
  }

  reg('/api/ego/camoufox', async (_req, res) => { sendJson(res, 200, await embedded.getInfo()) })
  reg('/api/ego/camoufox/start', async (_req, res) => {
    try { sendJson(res, 200, { ok: true, ...(await embedded.ensureStarted()) }) }
    catch (e) { sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) }) }
  })
  reg('/api/ego/camoufox/stop', async (_req, res) => { await embedded.stop(); sendJson(res, 200, { ok: true }) })
  reg('/api/ego/camoufox/control', async (req, res) => {
    const body = await readBody(req)
    const mode = body.mode === 'agent' ? 'agent' : 'manual'
    embedded.setControlMode(mode)
    sendJson(res, 200, { ok: true, controlMode: mode })
  })
  reg('/api/ego/camoufox/navigate', async (req, res) => {
    const body = await readBody(req)
    const r = await embedded.navigate(String(body.url ?? ''))
    sendJson(res, 200, r)
  })

  ctx.effect?.(() => () => { for (const d of disposers) { try { d() } catch {} } }, 'ego-browser: camoufox routes')
}
