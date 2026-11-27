// Embedded Camoufox display (Phase B of the Camoufox-only redesign).
//
// Runs a REAL headed Camoufox on a private Xvfb display and exposes it as an
// interactive noVNC stream, so the DSH panel can embed the browser directly
// (one browser, no Chrome middleman). Rootless: x11vnc is an extracted .deb run
// with LD_LIBRARY_PATH; noVNC assets are static files.
//
// Stack: Xvfb -> headed Camoufox -> x11vnc -> WebSocket<->TCP proxy -> noVNC.
// The agent controls the same browser through the exposed Playwright `page`.
//
// Original adapter; no Camoufox/x11vnc/noVNC code is copied into this file.

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { Browser, Page } from 'playwright-core'

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
  /** Base dir holding the rootless x11vnc + noVNC assets. */
  assetsDir?: string
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function defaultAssetsDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'ego-camoufox')
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function findFreeDisplay(start = 99): Promise<string> {
  for (let n = start; n < start + 40; n++) {
    const display = `:${n}`
    const inUse = await new Promise<boolean>(resolve => {
      const p = spawn('xdpyinfo', ['-display', display], { stdio: 'ignore' })
      p.on('exit', c => resolve(c === 0))
      p.on('error', () => resolve(false))
    })
    if (!inUse) return display
  }
  throw new Error('No free X display number found for the embedded browser.')
}

function viewerHtml(wsPort: number): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;background:#101418;overflow:hidden}
#screen{width:100%;height:100%}</style></head>
<body><div id="screen"></div>
<script type="module">
import RFB from '/novnc/core/rfb.js';
const rfb = new RFB(document.getElementById('screen'), 'ws://' + location.hostname + ':${wsPort}', {});
rfb.scaleViewport = true; rfb.resizeSession = true;
window.__rfb = rfb;
</script></body></html>`
}

export class CamoufoxDisplay {
  private opts: Required<Pick<DisplayOptions, 'width' | 'height'>> & DisplayOptions
  private children: ChildProcess[] = []
  private servers: Server[] = []
  private wss: any = null
  private browser: Browser | null = null
  private page: Page | null = null
  private info: DisplayInfo = { running: false, display: '', httpPort: 0, wsPort: 0, viewerUrl: '' }
  private starting: Promise<DisplayInfo> | null = null
  private fillTimer: ReturnType<typeof setInterval> | null = null
  private lastFillSize = ''

  constructor(options: DisplayOptions = {}) {
    this.opts = { ...options, width: options.width ?? 1280, height: options.height ?? 900 }
  }

  getInfo(): DisplayInfo { return { ...this.info } }
  getPage(): Page | null { return this.page }
  getBrowser(): Browser | null { return this.browser }

  async start(): Promise<DisplayInfo> {
    if (this.info.running) return this.getInfo()
    if (this.starting) return this.starting
    this.starting = this.doStart().finally(() => { this.starting = null })
    return this.starting
  }

  private async doStart(): Promise<DisplayInfo> {
    const assets = this.opts.assetsDir ?? defaultAssetsDir()
    const x11vncBin = path.join(assets, 'x11vnc', 'usr', 'bin', 'x11vnc')
    const x11vncLibs = path.join(assets, 'x11vnc', 'usr', 'lib', 'x86_64-linux-gnu')
    const novncDir = path.join(assets, 'novnc')
    if (!existsSync(x11vncBin)) throw new Error(`x11vnc not found at ${x11vncBin}. Install the rootless x11vnc assets first.`)
    if (!existsSync(path.join(novncDir, 'core', 'rfb.js'))) throw new Error(`noVNC assets not found at ${novncDir}.`)

    const display = await findFreeDisplay()
    const vncPort = await freePort()
    const wsPort = await freePort()
    const httpPort = await freePort()
    const width = this.opts.width, height = this.opts.height
    // x11vnc requires a width that is a multiple of 4.
    const adjWidth = Math.floor(width / 4) * 4

    this.run('Xvfb', [display, '-screen', '0', `${adjWidth}x${height}x24`, '-nolisten', 'tcp'])
    if (!(await this.waitDisplay(display))) throw new Error('Xvfb failed to start for the embedded browser.')

    this.run(x11vncBin, ['-display', display, '-rfbport', String(vncPort), '-nopw', '-forever', '-shared', '-listen', '127.0.0.1', '-noxdamage', '-xrandr', '-quiet'], { LD_LIBRARY_PATH: x11vncLibs })
    await sleep(700)

    // WebSocket <-> TCP proxy (noVNC speaks binary RFB over WebSocket).
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1', handleProtocols: (p: Set<string>) => (p.has('binary') ? 'binary' : false) })
    this.wss = wss
    wss.on('connection', (ws: any) => {
      const tcp = net.connect(vncPort, '127.0.0.1')
      ws.on('message', (d: Buffer) => tcp.write(d))
      tcp.on('data', (d: Buffer) => ws.send(d))
      tcp.on('close', () => ws.close())
      tcp.on('error', () => ws.close())
      ws.on('close', () => tcp.destroy())
    })

    // HTTP server: the noVNC viewer page + static noVNC assets.
    const server = createServer(async (req, res) => {
      try {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        if (pathname === '/' || pathname === '/viewer.html') {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          res.end(viewerHtml(wsPort)); return
        }
        if (pathname.startsWith('/novnc/')) {
          const file = path.join(novncDir, pathname.replace('/novnc/', ''))
          if (!file.startsWith(novncDir) || !existsSync(file)) { res.statusCode = 404; res.end('not found'); return }
          res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
          res.end(await readFile(file)); return
        }
        res.statusCode = 404; res.end('not found')
      } catch (e) { res.statusCode = 500; res.end(String(e)) }
    })
    this.servers.push(server)
    await new Promise<void>(r => server.listen(httpPort, '127.0.0.1', r))

    // Headed Camoufox on the private display.
    const { Camoufox } = await import('camoufox')
    const launchOpts: Record<string, unknown> = {
      headless: false,
      humanize: this.opts.humanize ?? false,
      enable_cache: false,
      window: [adjWidth, height],
      env: { ...process.env, DISPLAY: display },
    }
    if (this.opts.proxy) launchOpts.proxy = { server: this.opts.proxy }
    if (this.opts.geoip) launchOpts.geoip = true
    this.browser = await Camoufox(launchOpts) as Browser
    this.page = await this.browser.newPage()
    await this.page.goto('about:blank').catch(() => {})

    // Keep the browser window filling the (resizable) X display so the panel
    // shows a full-bleed browser instead of letterboxed black bars.
    this.startWindowFill(assets, display)

    this.info = { running: true, display, httpPort, wsPort, viewerUrl: `http://127.0.0.1:${httpPort}/` }
    return this.getInfo()
  }

  private startWindowFill(assets: string, display: string): void {
    const xdotool = path.join(assets, 'xdotool', 'usr', 'bin', 'xdotool')
    const libs = path.join(assets, 'xdotool', 'usr', 'lib', 'x86_64-linux-gnu')
    if (!existsSync(xdotool)) return
    const env = { ...process.env, DISPLAY: display, LD_LIBRARY_PATH: libs }
    const exec = (args: string[]): Promise<string> => new Promise(resolve => {
      const p = spawn(xdotool, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', d => { out += d })
      p.on('exit', () => resolve(out.trim()))
      p.on('error', () => resolve(''))
    })
    const dims = (): Promise<string> => new Promise(resolve => {
      const p = spawn('xdpyinfo', ['-display', display], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      p.stdout.on('data', d => { out += d })
      p.on('exit', () => {
        const m = out.match(/dimensions:\s+(\d+)x(\d+)/)
        resolve(m ? `${m[1]}x${m[2]}` : '')
      })
      p.on('error', () => resolve(''))
    })
    const tick = async () => {
      if (!this.info.running) return
      const size = await dims()
      if (!size || size === this.lastFillSize) return
      this.lastFillSize = size
      const [w, h] = size.split('x')
      let ids = (await exec(['search', '--classname', 'Navigator'])).split('\n').filter(Boolean)
      if (ids.length === 0) ids = (await exec(['search', '--class', 'camoufox'])).split('\n').filter(Boolean)
      for (const id of ids) {
        await exec(['windowsize', id, w, h])
        await exec(['windowmove', id, '0', '0'])
      }
    }
    void tick()
    this.fillTimer = setInterval(() => { void tick() }, 800)
    this.fillTimer.unref?.()
  }

  private run(cmd: string, args: string[], env: Record<string, string> = {}): ChildProcess {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    p.stdout?.on('data', () => {})
    p.stderr?.on('data', () => {})
    this.children.push(p)
    return p
  }

  private async waitDisplay(display: string, timeoutMs = 8000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise<boolean>(resolve => {
        const p = spawn('xdpyinfo', ['-display', display], { stdio: 'ignore' })
        p.on('exit', c => resolve(c === 0))
        p.on('error', () => resolve(false))
      })
      if (ok) return true
      await sleep(200)
    }
    return false
  }

  async stop(): Promise<void> {
    this.info.running = false
    if (this.fillTimer) { clearInterval(this.fillTimer); this.fillTimer = null }
    this.lastFillSize = ''
    try { if (this.browser) await this.browser.close() } catch {}
    this.browser = null; this.page = null
    try { if (this.wss) this.wss.close() } catch {}
    this.wss = null
    for (const s of this.servers) { try { s.close() } catch {} }
    this.servers = []
    for (const p of [...this.children].reverse()) { try { p.kill('SIGTERM') } catch {} }
    await sleep(400)
    for (const p of this.children) { try { p.kill('SIGKILL') } catch {} }
    this.children = []
    this.info = { running: false, display: '', httpPort: 0, wsPort: 0, viewerUrl: '' }
  }
}
