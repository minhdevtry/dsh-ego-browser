# Embedded interactive browser: streaming options research

Context: we embed a REAL Camoufox (Firefox, anti-detect) browser in the DSH sidebar
panel and let the user click/type into it. Current stack = Xvfb + x11vnc +
WebSocket↔TCP proxy + noVNC. It works but is pixel-streaming over WebSocket:
choppy, soft text, no audio, letterboxing. Goal: a better-looking, smoother embed
while keeping Camoufox + rootless (no sudo) on a 16GB machine.

Fundamental constraint: Camoufox is Firefox/Juggler, NOT Chrome/CDP. The crisp,
low-bandwidth "live view" used by Browserbase / Steel / Hyperbeam is CDP
screencast + input forwarding and therefore Chrome-only. To keep Camoufox we must
stream pixels/video (VNC or WebRTC). So the upgrade path is a better streaming
layer, not CDP.

## Options (primary sources fetched 2026-11-27)

### 1. KasmVNC (kasmtech/KasmVNC) — RECOMMENDED pragmatic upgrade
- Modern VNC fork; own X server (Xvnc) → replaces Xvfb + x11vnc with ONE component.
- WebP + JPEG (libjpeg-turbo), multi-threaded encode, WebCodecs video (H.264/H.265/AV1),
  WebRTC UDP transit, full-screen video detection, dynamic quality.
- Dynamic resize, seamless/binary clipboard, IME, mobile support, web API, multi-user.
- Ships its own web UI (no noVNC needed). Portable DEB (glibc 2.28+) → extractable
  rootless like our x11vnc. Keeps Camoufox (launch it on the KasmVNC display).
- Tradeoff: needs host OpenSSL3/FFmpeg libs + TLS cert/password setup; more config
  than x11vnc but far better quality/latency.
- Source: https://github.com/kasmtech/KasmVNC (README).

### 2. neko (m1k1o/neko) — best UX, but Docker + custom image
- WebRTC virtual browser; smooth video + audio + multi-participant control;
  explicitly an open-source Hyperbeam alternative; embeddable in a web app.
- Much smoother than noVNC (WebRTC, not WebSocket images).
- Tradeoff: Docker-based; official images are firefox/chromium/etc., NOT Camoufox.
  We'd need to build a Camoufox image. Heavier on a lagging machine; user is in the
  docker group so feasible, but more moving parts.
- Source: https://github.com/m1k1o/neko (README).

### 3. Selkies (selkies-project) — WebRTC X11, GPU-oriented
- Low-latency WebRTC X11 streaming; needs GStreamer and ideally a GPU.
- Tradeoff: heavy setup; overkill for a CPU-only lagging box. Not recommended here.

### 4. CDP live-view (Browserbase / Steel / Hyperbeam) — crisp but Chrome-only
- Screencast + input forwarding; crisp and low-bandwidth; the "embed a browser" SaaS pattern.
- Incompatible with Camoufox (Firefox). Only viable if we abandon Camoufox for a
  Chromium anti-detect stack. Not recommended given the anti-detect requirement.

## Recommendation
Adopt **KasmVNC** as the streaming layer (keep Camoufox + rootless). It directly
fixes the "soft/choppy/letterboxed" look with WebP/video + dynamic resize + clipboard,
and collapses Xvfb+x11vnc+noVNC into one server. Keep the current noVNC path as a
fallback. Choose **neko** only if we accept Docker + building a Camoufox image and
want audio/multi-user.

## Next step (if approved)
Verify KasmVNC portable DEB runs rootless on this host (extract, start Xvnc on a
private display, launch Camoufox on it, embed its web UI), then swap display.ts to
prefer KasmVNC with noVNC fallback.
