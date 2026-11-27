# Keep Camoufox as an optional second backend

The existing ego-lite Chrome backend remains the default because it owns the live watch panel, takeover, task spaces and replay. Camoufox is added through the official MIT TypeScript launcher behind one compact `ego_camoufox` tool, with lazy launch and idle cleanup, so genuine Firefox fingerprint spoofing is available without rewriting or destabilising the Chrome tool surface.

## Considered options

- **Replace Chrome with Camoufox:** stronger stealth but loses the existing live-panel/takeover integration and creates a large upstream merge burden. Rejected.
- **Run camofox-browser as a REST service:** keeps adapter code small and reuses a maintained server, but adds another daemon, HTTP auth surface and deployment lifecycle. Rejected for the first version.
- **Embed the official launcher (chosen):** self-contained lifecycle, direct Playwright operations and upstream-maintained fingerprint generation; optional dependencies keep the base plugin usable without Firefox.

## Consequences

The first version intentionally has one active Camoufox page and no Chrome-style live panel. Screenshots provide visual evidence. The browser is opt-in, headless by default and closed after idle timeout or plugin disposal. A future persistent-profile or multi-tab design must preserve this ownership boundary and must never kill unrelated Firefox processes.
