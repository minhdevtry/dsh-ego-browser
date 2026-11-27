// Real-engine smoke test. Run after `pnpm exec camoufox fetch`:
//   node scripts/camoufox-smoke.mjs
// Uses a loopback fixture, so it does not depend on an external website or
// attempt to bypass a third-party challenge.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CamoufoxEngine } from '../src/camoufox/engine.ts'

const html = `<!doctype html><html><head><title>Camoufox fixture</title></head><body>
<h1>Camoufox smoke</h1>
<label>Name <input aria-label="Name" id="name"></label>
<button id="submit">Submit</button><output id="out"></output>
<script>document.getElementById('submit').addEventListener('click',()=>{document.getElementById('out').textContent='Submitted: '+document.getElementById('name').value})</script>
</body></html>`

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(html)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
const dir = await mkdtemp(join(tmpdir(), 'ego-camoufox-smoke-'))
const shot = join(dir, 'page.png')
const engine = new CamoufoxEngine(() => ({
  headless: true,
  humanize: true,
  geoip: false,
  idleTimeoutMs: 60_000,
}))

function ok(result, label) {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`)
  return result
}
function ref(snapshot, role, name) {
  const line = snapshot.split('\n').find(l => l.includes(role) && l.includes(name))
  const match = line?.match(/\[ref=(e\d+)\]/)
  assert.ok(match, `missing ${role} ${name} in snapshot:\n${snapshot}`)
  return match[1]
}

const started = Date.now()
try {
  assert.equal(engine.status().running, false)
  ok(await engine.execute('open', { url }), 'open')
  const first = ok(await engine.execute('read', { mode: 'snapshot' }), 'read snapshot')
  const input = ref(first.snapshot, 'textbox', 'Name')
  ok(await engine.execute('act', { operation: 'fill', ref: input, snapshotId: first.snapshotId, text: 'Camoufox OK' }), 'fill')
  const second = ok(await engine.execute('read', { mode: 'snapshot' }), 'read after fill')
  const button = ref(second.snapshot, 'button', 'Submit')
  ok(await engine.execute('act', { operation: 'click', ref: button, snapshotId: second.snapshotId }), 'click')
  const text = ok(await engine.execute('read', { mode: 'text' }), 'read text')
  assert.match(text.text, /Submitted: Camoufox OK/)
  const audit = ok(await engine.execute('audit'), 'audit')
  const evaluated = ok(await engine.execute('eval', { expression: 'document.title' }), 'eval')
  ok(await engine.execute('screenshot', { path: shot }), 'screenshot')
  assert.ok((await stat(shot)).size > 0)
  ok(await engine.execute('close'), 'close')
  assert.equal(engine.status().running, false)
  console.log(JSON.stringify({
    ok: true,
    durationMs: Date.now() - started,
    url,
    title: evaluated.result,
    fingerprint: { consistent: audit.consistent, mismatches: audit.mismatches ?? [] },
    screenshot: shot,
  }, null, 2))
} finally {
  await engine.dispose()
  await new Promise(resolve => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
