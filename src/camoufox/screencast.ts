// Camoufox interactive embed via Juggler screencast (no X11 / no VNC).
//
// Verified on this host: page.screencast.start({onFrame}) works with headless
// Camoufox (Playwright Firefox/Juggler). Frames (JPEG) are pushed over a WebSocket
// to a canvas viewer; human pointer/keyboard events travel back and are dispatched
// through page.mouse / page.keyboard (trusted events). Resize = setViewportSize.
// This removes the X11 focus / clipboard / resize class of bugs entirely.
//
// Native <select>/file/date widgets are drawn in the Firefox parent process and do
// not appear in a content screencast; a widget bridge is a follow-up (see research).

import { createServer, type Server } from 'node:http'
import net from 'node:net'
import type { Browser, Page, BrowserContext } from 'playwright-core'

export interface DisplayInfo {
  running: boolean
  display: string
  httpPort: number
  wsPort: number
  viewerUrl: string
}
export interface DisplayOptions {
  width?: number
  height?: number
  humanize?: boolean
  proxy?: string
  geoip?: boolean
  assetsDir?: string
  onHumanInput?: () => void
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(p)) })
    srv.on('error', reject)
  })
}

function viewerHtml(wsPort: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#101418;overflow:hidden}
#wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
canvas{outline:none;background:#fff;max-width:100%;max-height:100%}
</style></head><body><div id="wrap"><canvas id="cv" tabindex="0"></canvas></div>
<script>
const ws=new WebSocket('ws://'+location.hostname+':${wsPort}');ws.binaryType='arraybuffer';
const cv=document.getElementById('cv'),ctx=cv.getContext('2d');let vw=1280,vh=800;
ws.onopen=()=>{cv.focus();sendResize()};
ws.onmessage=async ev=>{if(typeof ev.data==='string')return;const b=await createImageBitmap(new Blob([ev.data],{type:'image/jpeg'}));if(cv.width!==b.width||cv.height!==b.height){cv.width=b.width;cv.height=b.height;vw=b.width;vh=b.height}ctx.drawImage(b,0,0);b.close()};
function send(o){if(ws.readyState===1)ws.send(JSON.stringify(o))}
function co(e){const r=cv.getBoundingClientRect();return{x:(e.clientX-r.left)*(vw/r.width),y:(e.clientY-r.top)*(vh/r.height)}}
cv.addEventListener('pointermove',e=>send({type:'mouse',action:'move',...co(e)}));
cv.addEventListener('pointerdown',e=>{cv.focus();const c=co(e);send({type:'mouse',action:'move',...c});send({type:'mouse',action:'down'})});
cv.addEventListener('pointerup',()=>send({type:'mouse',action:'up'}));
cv.addEventListener('wheel',e=>{e.preventDefault();send({type:'mouse',action:'wheel',dx:e.deltaX,dy:e.deltaY})},{passive:false});
const KM={' ':'Space','Escape':'Escape','Enter':'Enter','Backspace':'Backspace','Tab':'Tab','Delete':'Delete'};
window.addEventListener('keydown',e=>{if(document.activeElement!==cv)return;e.preventDefault();let k=KM[e.key]||e.key;const m=[];if(e.ctrlKey)m.push('Control');if(e.altKey)m.push('Alt');if(e.metaKey)m.push('Meta');if(e.shiftKey&&k.length>1)m.push('Shift');send({type:'key',action:'press',key:m.length?m.join('+')+'+'+k:k})});
let rt=null;function sendResize(){const w=document.getElementById('wrap');send({type:'resize',width:w.clientWidth,height:w.clientHeight})}
new ResizeObserver(()=>{clearTimeout(rt);rt=setTimeout(sendResize,200)}).observe(document.getElementById('wrap'));
</script></body></html>`
}

export class CamoufoxScreencast {
  private opts: DisplayOptions
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private cast: { dispose(): Promise<void> } | null = null
  private wss: any = null
  private server: Server | null = null
  private clients = new Set<any>()
  private info: DisplayInfo = { running: false, display: '', httpPort: 0, wsPort: 0, viewerUrl: '' }
  private starting: Promise<DisplayInfo> | null = null

  constructor(options: DisplayOptions = {}) { this.opts = options }
  getInfo(): DisplayInfo { return { ...this.info } }
  getPage(): Page | null { return this.page }
  getBrowser(): Browser | null { return this.browser }
  getDisplay(): string { return '' }

  async start(): Promise<DisplayInfo> {
    if (this.info.running) return this.getInfo()
    if (this.starting) return this.starting
    this.starting = this.doStart().finally(() => { this.starting = null })
    return this.starting
  }

  private async doStart(): Promise<DisplayInfo> {
    const width = this.opts.width ?? 1280, height = this.opts.height ?? 900
    const wsPort = await freePort()
    const httpPort = await freePort()
    const { Camoufox } = await import('camoufox')
    const launchOpts: Record<string, unknown> = { headless: true, humanize: this.opts.humanize ?? false, enable_cache: false }
    if (this.opts.proxy) launchOpts.proxy = { server: this.opts.proxy }
    if (this.opts.geoip) launchOpts.geoip = true
    this.browser = await Camoufox(launchOpts) as Browser
    // Firefox/Juggler rejects Chromium-only permission names (clipboard-read), so
    // do not pass permissions here; clipboard is bridged via insertText / buttons.
    this.context = await this.browser.newContext({ viewport: { width, height } })
    this.page = await this.context.newPage()
    await this.page.goto('about:blank').catch(() => {})

    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1' })
    this.wss = wss
    wss.on('connection', (ws: any) => {
      this.clients.add(ws)
      ws.on('message', (raw: Buffer) => { void this.handleInput(ws, raw) })
      ws.on('close', () => this.clients.delete(ws))
    })

    this.cast = await this.page.screencast.start({
      size: { width, height }, quality: 80,
      onFrame: ({ data }: { data: Buffer }) => { for (const c of this.clients) if (c.readyState === 1) c.send(data) },
    }) as any

    const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(viewerHtml(wsPort)) })
    this.server = server
    await new Promise<void>(r => server.listen(httpPort, '127.0.0.1', r))

    this.info = { running: true, display: '', httpPort, wsPort, viewerUrl: `http://127.0.0.1:${httpPort}/` }
    return this.getInfo()
  }

  private async handleInput(ws: any, raw: Buffer): Promise<void> {
    let m: any
    try { m = JSON.parse(raw.toString()) } catch { return }
    const page = this.page
    if (!page) return
    // Human input takes control back from the agent (server-side gate).
    if (m.type === 'mouse' || m.type === 'key') this.opts.onHumanInput?.()
    try {
      if (m.type === 'mouse') {
        if (m.action === 'move') await page.mouse.move(m.x, m.y)
        else if (m.action === 'down') await page.mouse.down()
        else if (m.action === 'up') await page.mouse.up()
        else if (m.action === 'click') await page.mouse.click(m.x, m.y)
        else if (m.action === 'wheel') await page.mouse.wheel(m.dx || 0, m.dy || 0)
      } else if (m.type === 'key') {
        if (m.action === 'type') await page.keyboard.insertText(m.text || '')
        else if (m.action === 'press') await page.keyboard.press(m.key)
      } else if (m.type === 'resize') {
        await page.setViewportSize({ width: Math.max(320, m.width | 0), height: Math.max(240, m.height | 0) })
      } else if (m.type === 'navigate') {
        await page.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      }
    } catch (e) { try { ws.send(JSON.stringify({ error: String((e as Error).message || e) })) } catch {} }
  }

  resize(w: number, h: number): void { void this.page?.setViewportSize({ width: Math.max(320, w | 0), height: Math.max(240, h | 0) }).catch(() => {}) }

  async getClipboard(): Promise<string> {
    try { return await this.page?.evaluate(() => navigator.clipboard.readText()) ?? '' } catch { return '' }
  }

  async stop(): Promise<void> {
    this.info.running = false
    try { if (this.cast) await this.cast.dispose() } catch {}
    this.cast = null
    try { if (this.wss) this.wss.close() } catch {}
    this.wss = null; this.clients.clear()
    try { if (this.server) this.server.close() } catch {}
    this.server = null
    try { if (this.browser) await this.browser.close() } catch {}
    this.browser = null; this.context = null; this.page = null
    this.info = { running: false, display: '', httpPort: 0, wsPort: 0, viewerUrl: '' }
  }
}
