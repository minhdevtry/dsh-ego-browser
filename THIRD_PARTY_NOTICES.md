# Third-Party Notices

The ego-browser plugin itself is licensed under **GPL-3.0-only**; see LICENSE. The vendored components below keep their original licenses.

This plugin **vendors** (embeds) the following open-source components from the
[CitroLabs/ego-lite](https://github.com/CitroLabs/ego-lite) project (MIT License),
including the Linux port work in [PR #234](https://github.com/citrolabs/ego-lite/pull/234)
(`package/ego-linux`):

| Vendored component | Source | License |
|---|---|---|
| `runtime/ego-browser/dist/out/index.js` | shared ego-browser harness build (`package/ego-browser`) | MIT |
| `runtime/ego-linux/*` | Linux CDP host (`package/ego-linux`, PR #234) + local proxy patch | MIT |
| `runtime/skills/ego-browser/*` | agent skill package (`skills/ego-browser`) | MIT |
| BtbN FFmpeg builds (optional download) | https://github.com/BtbN/FFmpeg-Builds | GPL-3.0-or-later for the selected GPL build |
| `ffmpeg-static` macOS release assets (optional download) | https://github.com/eugeneware/ffmpeg-static | GPL-3.0-or-later; upstream binaries originate from Evermeet/OSXExperts |
| FFmpeg | https://ffmpeg.org/ | GPL-3.0-or-later for the selected builds |

## 分发范围 / Distribution scope

本仓库与 npm 包包含 **GPL-3.0-only** 的插件本体，以及 **MIT** 许可的内置 ego-lite 运行时（`runtime/`）。
FFmpeg 不在分发物内：仅在用户主动启用 FFmpeg 后端时，由安装器按需下载到用户缓存，
因此 GPL-3.0-or-later 的义务只及于该独立下载的二进制，不传导到本项目的分发物。

## FFmpeg distribution notice

The CDP backend does not require FFmpeg. The optional FFmpeg backend first checks
the user path and system PATH, then offers an explicit managed download into the
user cache. No FFmpeg executable is included in this repository or npm package.
Users and distributors must comply with the license attached to the selected
build, preserve notices, and provide corresponding source as required. Sources:

- BtbN builds: https://github.com/BtbN/FFmpeg-Builds
- macOS release assets: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- Evermeet macOS Intel builds: https://evermeet.cx/ffmpeg/
- OSXExperts Apple Silicon builds: https://www.osxexperts.net/
- FFmpeg: https://git.ffmpeg.org/ffmpeg.git
- GPL v3 text: https://www.gnu.org/licenses/gpl-3.0.html

Using a user-supplied FFmpeg binary may carry different licensing obligations;
the user/distributor is responsible for the selected build.

Additional local modifications on top of upstream (see `runtime/ego-linux/src/chrome.mjs`):
- `EGO_LINUX_PROXY` support: injects `--proxy-server` / `--proxy-bypass-list` into the
  launched Chrome, so the agent browser can reach the network through a local proxy
  without hijacking the CLI's own loopback CDP traffic.

MIT License (as provided by the upstream project):

    MIT License

    Copyright (c) 2026 CitroLabs (ego-lite) and contributors

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Stealth kit adaptations (MIT)

The `src/stealth/*` modules adapt concepts and heuristics from
[mcp-camoufox](https://github.com/RobithYusuf/mcp-camoufox) (MIT License,
Copyright (c) RobithYusuf). The implementations here are original; no
mcp-camoufox source is copied verbatim. Adapted areas:

| Stealth module | Adapted from (mcp-camoufox, MIT) |
|---|---|
| `antibot-detect.ts` | `detect_anti_bot` vendor heuristics (`src/tools/session.ts`, `src/tools/inspect.ts`) |
| `http-impit.ts` | browserless impit kit + manual-redirect credential-drop fix (`src/tools/http.ts`) |
| `storage-state.ts` | `storage_state_save/load` shape + cross-origin localStorage guard (`src/tools/session.ts`) |
| `fingerprint-audit.ts` | `fingerprint_audit` coherence checks (`src/tools/inspect.ts`) |
| `humanize.ts` | human-input / mouse record-replay concepts (`src/tools/session.ts`) |

The clearance-cache pattern (`clearance.ts`) is inspired by fastCRW
(https://github.com/adambenhassen/crw-camofox, AGPL-3.0) **as a concept only**;
it is an original implementation and no AGPL code is copied or linked.

    MIT License (mcp-camoufox)

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

## Optional Camoufox backend

`ego_camoufox` dynamically uses the official [Camoufox TypeScript launcher](https://github.com/daijro/camoufox/tree/main/typescript) (`camoufox`, MIT, Copyright (c) 2024-2026 daijro and the Camoufox contributors) and `playwright-core` (Apache-2.0). Both are optional dependencies; neither is bundled into `lib/index.js`.

The Camoufox browser build is downloaded separately by `camoufox fetch` or on first launch. It is licensed under MPL-2.0 and is not redistributed in this repository or npm package. The launcher's bundled notices include its dependencies (including fpgen-js, Apache-2.0, and python-random); those notices remain with the installed package. The adapter in `src/camoufox/` is original code and does not copy fastCRW AGPL code.
