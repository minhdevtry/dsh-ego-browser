# Tuỳ biến dsh-ego-browser — Full English, custom tối thiểu

> Fork: `minhdevtry/dsh-ego-browser` (từ `omdsh-dev/dsh-ego-browser` @ v0.15.2, GPL-3.0-only).
> Mục tiêu: **full English** cho mọi text người dùng thấy, **custom tối thiểu** để pull/merge upstream thoải mái.
> Đích: DSH Web `0.2.2-rc.5` @ `127.0.0.1:3080`, Linux 16GB RAM.

## 1. English hỗ trợ tới đâu (trước khi sửa)

| Phần | Trước | Ghi chú |
|---|---|---|
| Watch panel + settings card (UI) | ✅ English đầy đủ | `watchEn` 85 key + `en` 55 key; browser không phải zh → tự English. Không cần sửa. |
| Failure hints (`errors.ts`) | ❌ Chinese | 12 hint, hiện trong tool card khi lỗi |
| Snapshot diff (`snapshot-diff.ts`) | ❌ Chinese | summary / baseline / note |
| `ego_status` + action success hint (`index.ts`) | ❌ Chinese | `STATUS_RULES_SUMMARY`, `ACTION_SUCCESS_HINT` |
| `ego_help` docs + fallback (`help.ts`, `index.ts`) | ❌ Chinese | 21 topic |
| Client H.264 failure (`client:1527`) | ❌ Chinese hardcode | |
| Rules system-prompt (`rules.ts`) | ❌ Chinese | **Model-facing, người dùng KHÔNG thấy** → giữ nguyên có chủ đích |

## 2. Đã làm — English overlay tối thiểu, merge-friendly

**Nguyên tắc:** toàn bộ English nằm trong **file mới additive** (không bao giờ conflict); wiring mỗi chỗ 1 dòng; config `language` opt-in, mặc định `auto` = giữ nguyên upstream → fork không xâm lấn.

### File mới (additive, 0 conflict khi merge)
- `src/english.ts` — framework + English cho: 12 failure hints, status summary, action hint, snapshot-diff strings, ego_help fallback. Chọn English khi `language='en'`,否则 trả nguyên văn upstream.
- `src/english-help.ts` — English cho **21 topic** ego_help (dịch đầy đủ, giữ nguyên tool name/param/thuật ngữ).

### Config mới
- `language: 'auto' | 'en' | 'zh'` (volatile, opt-in). Thêm vào `src/config.ts` (prefs + resolveConfig) và `src/types.ts` (ResolvedConfig). Mặc định `auto`.

### Wiring (6 file, +29/−16 dòng)
| File | Thay đổi |
|---|---|
| `src/errors.ts` | `hint: hintFor(code, HINTS[code])` + import |
| `src/snapshot-diff.ts` | `diffSummary/diffBaseline/diffNote` bọc 3 chỗ + import |
| `src/index.ts` | import; `setLanguageSource(...)` trong apply; `statusRulesSummary`; `actionSuccessHint` (5 chỗ); help output dùng `helpText/helpPlatformUnavailable/helpNotFound` |
| `src/client/index.ts` | thêm key `h264Unsupported` vào watchEn/watchZh; `onFailure(wt('h264Unsupported'))` |
| `src/config.ts` | thêm field `language` |
| `src/types.ts` | thêm `language` vào ResolvedConfig |

**Graceful degradation:** key/topic nào upstream đổi mà overlay chưa cập nhật → tự rơi về text gốc, không vỡ. `language='auto'` reproduces upstream y hệt (kể cả note tiếng Trung của help).

## 3. Bật English + nhẹ máy (profile patch, không cần sửa code thêm)

Thêm vào `cordis.patch.yml` của profile web:
```yaml
- id: ego-browser
  name: dsh-ego-browser
  config:
    language: en          # full English cho tool results / hints / ego_help
    idleTimeoutMin: 10    # tự đóng browser khi idle 10p → nhả RAM
    cdpFps: 10            # giảm nửa CPU stream
    cdpMaxWidth: 960
    toolProfile: lite     # bớt tool → bớt token context
    residentExecutor: true
    residentIdleMin: 10
```
UI panel/settings vốn đã English theo browser; `language: en` lo phần text kết quả.

## 4. Build & test
```sh
pnpm install        # devDeps; peers để external trong tsdown nên không cần cài peers để build
pnpm build          # tsdown → lib/index.js + lib/client.js + bin/ego-cast-worker.mjs
pnpm test           # vitest (cần peers nếu test import trực tiếp; xem ghi chú)
```
Cài vào profile (dev): `dsh plugin --profile web add link:/home/minhdn3/Documents/deepseek-harness/default-workspace/dsh-ego-browser`

## 5. Merge upstream sau này
```sh
git remote add upstream https://github.com/omdsh-dev/dsh-ego-browser.git
git fetch upstream
git merge upstream/master   # hoặc rebase
```
- `src/english.ts`, `src/english-help.ts`: file mới → **không conflict**.
- 6 file wiring: chỉ conflict nếu upstream sửa đúng dòng đó; conflict nhỏ, dễ resolve (giữ wrapper `hintFor/diffSummary/...`).
- Sau merge: nếu upstream thêm failure code / help topic mới, thêm English tương ứng vào overlay (thiếu thì tự fallback text gốc, không vỡ).
- `rules.ts` giữ Chinese (model-facing) → không đụng, không conflict.

## 6. Cố ý KHÔNG làm
- Không dịch `rules.ts` (system prompt, người dùng không thấy; dịch rủi ro đổi hành vi model + thêm diff).
- Không đổi license (GPL-3.0-only), giữ LICENSE + THIRD_PARTY_NOTICES.
- Không nới lỏng security (auth cookie v0.15.1, login-import fail-closed).
- Không sửa runtime/ ego-lite (MIT vendored).
