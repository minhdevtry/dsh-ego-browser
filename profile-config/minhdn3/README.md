# Local profile defaults

Optional configuration-only bundle for this fork. Install it **after** `dsh-ego-browser` when you want the maintainer's local defaults:

- English tool results and help.
- Full Chrome tool surface, 10 FPS preview and 10-minute idle cleanup.
- Resident Chrome executor with 10-minute idle stop.
- Camoufox enabled, headless, humanized, GeoIP alignment on direct connection, 10-minute idle cleanup.

It does not contain browser code and does not change the upstream plugin defaults. Remove/disable this bundle to return to the plugin's own defaults. Proxy remains off until explicitly configured; GeoIP uses the direct exit IP and the locally fetched database.
