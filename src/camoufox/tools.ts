import { defineTool } from '@deepseek-ai/dsh-tools'

export interface CamoufoxToolEngine {
  execute(action: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>
  status(): Record<string, unknown>
  dispose(): Promise<void>
}

type Register = (tool: ReturnType<typeof defineTool>) => void
type Observe = <T>(args: Record<string, unknown>, exec: unknown, run: () => Promise<T>) => Promise<T>

const SECRET_KEY = /^(password|passwd|pwd|secret|apikey|accesstoken|refreshtoken|token|authorization|cookie|cookies|setcookie|cfclearance)$/i

function redactString(value: string): string {
  return value
    .replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//<redacted>@')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer <redacted>')
    .replace(/([?&](?:password|passwd|token|api_key|access_token)=)[^&#\s]+/gi, '$1<redacted>')
}

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value)
  if (depth >= 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 200).map(item => redact(item, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[-_]/g, '').toLowerCase()
    out[key] = SECRET_KEY.test(normalized) ? '<redacted>' : redact(item, depth + 1)
  }
  return out
}

/** One compact action-based tool keeps the Camoufox backend cheap in context. */
export function registerCamoufoxTool(
  reg: Register,
  engine: CamoufoxToolEngine,
  enabled: () => boolean,
  observe?: Observe,
): void {
  reg(defineTool({
    name: 'ego_camoufox',
    description: 'Optional Camoufox anti-detect Firefox backend, separate from the ego-lite Chrome tools. Actions: status; open(url); read(mode=snapshot|text); act(operation=click|dblclick|fill|press|select|check|uncheck|hover, ref from the latest read, optional snapshotId); screenshot(path?, fullPage?); eval(expression); audit; close. Use for fingerprint-sensitive browsing; use ego_* when you need the live Chrome watch panel/takeover. Read before acting; page-changing actions are never retried automatically. A CAPTCHA still needs a human—do not claim Camoufox bypasses it. Disabled unless camoufoxEnabled=true. Screenshot returns a file path; view it with read_image.',
    parameters: {
      action: { type: 'string', required: true, description: 'status | open | read | act | screenshot | eval | audit | close.' },
      url: { type: 'string', description: 'HTTP(S) URL for action=open.' },
      mode: { type: 'string', description: 'read mode: snapshot (default, semantic refs) or text.' },
      operation: { type: 'string', description: 'act operation: click, dblclick, fill, press, select, check, uncheck, hover.' },
      ref: { type: 'string', description: 'Element ref such as e12 from the latest Camoufox snapshot.' },
      snapshotId: { type: 'string', description: 'Optional snapshot generation; mismatch fails with STALE_REF.' },
      text: { type: 'string', description: 'Text for act operation=fill; never echoed back.' },
      value: { type: 'string', description: 'Option value for act operation=select.' },
      key: { type: 'string', description: 'Key/chord for act operation=press, e.g. Enter or Control+A.' },
      expression: { type: 'string', description: 'JavaScript expression for action=eval (Playwright page.evaluate).' },
      path: { type: 'string', description: 'Optional PNG output path for action=screenshot.' },
      fullPage: { type: 'boolean', description: 'Capture the whole page for action=screenshot; default false.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 120_000,
    execute: async (args: Record<string, unknown>, exec: unknown) => {
      const run = async (): Promise<Record<string, unknown>> => {
        const action = typeof args.action === 'string' ? args.action : 'status'
        if (action === 'status') return { ...engine.status(), enabled: enabled() }
        if (!enabled()) return { ok: false, code: 'DISABLED', error: 'Camoufox backend is disabled. Set camoufoxEnabled=true in ego-browser plugin config. Existing ego_* Chrome tools are unchanged.' }
        const result = await engine.execute(action, args)
        return { ...result, enabled: true }
      }
      const result = observe ? await observe(args, exec, run) : await run()
      return redact(result) as Record<string, unknown>
    },
    presentCall: (args: unknown) => ({
      card: 'generic',
      title: `Camoufox: ${String((args as Record<string, unknown>)?.action ?? 'status')}`,
      kind: 'other',
      rawInput: null,
    }),
  } as any))
}
