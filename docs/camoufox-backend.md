# Optional Camoufox backend

`ego_camoufox` adds a Firefox-based anti-detect backend next to the existing ego-lite Chrome tools. It does **not** replace `ego_*`, the live Chrome watch panel, takeover, task spaces or replay.

## Enable

The backend is off by default. Install the optional dependencies and fetch the paired browser once:

```sh
pnpm install
pnpm camoufox:fetch
```

Then set `camoufoxEnabled: true` in the ego-browser plugin config. The maintainer's optional profile overlay is in `profile-config/minhdn3/`; install it after the main plugin to enable English results, lighter Chrome streaming and Camoufox with idle cleanup.

## Tool

One compact tool keeps context cost low:

```text
ego_camoufox { action: "status" }
ego_camoufox { action: "open", url: "https://example.com" }
ego_camoufox { action: "read", mode: "snapshot" }   # semantic refs + snapshotId
ego_camoufox { action: "act", operation: "fill", ref: "e3", snapshotId: "cf-1", text: "..." }
ego_camoufox { action: "read", mode: "snapshot" }   # read again after a mutation
ego_camoufox { action: "act", operation: "click", ref: "e4", snapshotId: "cf-2" }
ego_camoufox { action: "read", mode: "text" }
ego_camoufox { action: "audit" }
ego_camoufox { action: "screenshot", path: "/tmp/page.png" }
ego_camoufox { action: "close" }
```

`act` supports `click`, `dblclick`, `fill`, `press`, `select`, `check`, `uncheck`, `hover`. Page-changing actions are serialized, never retried automatically, and require a fresh read before the next action. `fill` text is not echoed and is redacted from errors.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `camoufoxEnabled` | `false` | Enable the backend. |
| `camoufoxHeadless` | `true` | Headless Firefox; set `false` for a visible desktop window. |
| `camoufoxHumanize` | `false` | Human-like cursor movement via the launcher. |
| `camoufoxGeoip` | `false` | Align timezone/locale/geolocation/WebRTC IP with the exit IP; downloads a GeoIP database on first use. |
| `camoufoxProxy` | empty | Optional proxy server URL. Credentials are not returned by status. |
| `camoufoxIdleMin` | `10` | Close the owned browser after idle; `0` disables. |

Configuration is read live for enablement and the next launch. Changing headless/proxy/GeoIP while a browser is running does not relaunch it; close it first.

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:camoufox
```

The live smoke test uses a loopback fixture and checks open, semantic snapshot, fill, click, text read, fingerprint audit, eval, screenshot and clean shutdown. It does not attempt to bypass a third-party challenge.

## Limits and honest expectations

- One active Camoufox page in this version; no multi-tab, persistent profile or proxy-auth UI yet.
- No Chrome-style live panel for Camoufox; use screenshots, or set `camoufoxHeadless=false` on a desktop session.
- Camoufox spoofs a coherent device identity and can humanize input, but behavioral challenges (Cloudflare Turnstile/DataDome/etc.) may still require a human. Do not treat a clean fingerprint as a bypass guarantee.
- The fingerprint audit is conservative and may report informational timezone/locale differences.
- The browser build is downloaded separately and is MPL-2.0; the launcher is MIT. See `THIRD_PARTY_NOTICES.md`.
- Only the browser owned by the engine is closed. The plugin never kills unrelated Firefox processes.
