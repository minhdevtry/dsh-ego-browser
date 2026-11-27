/**
 * Human-input concepts adapted from mcp-camoufox / Camoufox humanize (MIT).
 * CDP input events are trusted, so paths here shape timing/geometry only.
 *
 * Concepts (curved mouse approach, rhythmic key delays, bounded mouse
 * record/replay) follow mcp-camoufox src/tools/session.ts (humanize_click,
 * humanize_type, mouse_record, mouse_replay); this is an original pure-math
 * implementation — no upstream code is copied, no browser or timers involved.
 */

export interface Point {
  x: number
  y: number
}

/** A point with `t` = milliseconds offset from the start of the path. */
export interface TimedPoint extends Point {
  t: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Deterministic PRNG (mulberry32) returning values in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Human-like mouse path from `from` to `to`: a quadratic bezier whose control
 * point sits off the straight line (random side, 10..35% of the distance),
 * sampled uniformly in time with smoothstep ease-in-out progression, so the
 * pointer moves slowly at the start and end. `steps` is the number of moves
 * (the result has `steps + 1` points); defaults are distance-based
 * (steps 8..60, duration 120..900ms). Deterministic for a given rng sequence.
 */
export function humanMousePath(
  from: Point,
  to: Point,
  rng: () => number,
  opts: { steps?: number; durationMs?: number } = {},
): TimedPoint[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const steps = Math.max(2, Math.round(opts.steps ?? clamp(dist / 8, 8, 60)))
  const durationMs = Math.max(0, opts.durationMs ?? Math.round(clamp(dist * 1.5, 120, 900)))
  // Control point: midpoint pushed perpendicular to the straight line.
  const sign = rng() < 0.5 ? -1 : 1
  const offset = dist * (0.1 + rng() * 0.25) * sign
  const nx = dist > 0 ? -(to.y - from.y) / dist : 0
  const ny = dist > 0 ? (to.x - from.x) / dist : 0
  const cx = (from.x + to.x) / 2 + nx * offset
  const cy = (from.y + to.y) / 2 + ny * offset
  const points: TimedPoint[] = []
  for (let i = 0; i <= steps; i++) {
    const u = i / steps
    const s = u * u * (3 - 2 * u)
    const a = (1 - s) * (1 - s)
    const b = 2 * (1 - s) * s
    const c = s * s
    points.push({
      x: a * from.x + b * cx + c * to.x,
      y: a * from.y + b * cy + c * to.y,
      t: durationMs * u,
    })
  }
  points[0] = { x: from.x, y: from.y, t: 0 }
  points[steps] = { x: to.x, y: to.y, t: durationMs }
  return points
}

/**
 * Per-character typing delays in ms. The mean comes from `wpm` (default 65)
 * via the 5-characters-per-word convention: base = 60000 / (wpm * 5). Each
 * keystroke gets ±30% jitter, and word starts occasionally get a longer
 * "thinking" pause. Deterministic for a given rng sequence.
 */
export function humanTypingDelays(
  text: string,
  rng: () => number,
  opts: { wpm?: number } = {},
): number[] {
  const wpm = Math.max(1, opts.wpm ?? 65)
  const base = 60000 / (wpm * 5)
  const delays: number[] = []
  for (let i = 0; i < text.length; i++) {
    let delay = base * (0.7 + rng() * 0.6)
    if (i > 0 && text[i - 1] === ' ' && rng() < 0.35) {
      delay += base * (1.5 + rng() * 2.5)
    }
    delays.push(delay)
  }
  return delays
}

/**
 * Bounded mouse recorder. Pure buffer: timestamps are supplied by the caller
 * (`nowMs`), so no timers are involved. The first recorded point defines t=0;
 * points past `maxPoints` (default 500) or beyond `durationMs` from the first
 * point are dropped. `addPoint` is a no-op unless recording; `start` replaces
 * any earlier recording; `stop` returns a copy of the recorded path.
 */
export class MouseRecorder {
  private points: TimedPoint[] = []
  private active = false
  private maxPoints = 500
  private durationMs: number | undefined
  private originMs: number | undefined

  start(maxPoints = 500, durationMs?: number): void {
    this.points = []
    this.active = true
    this.maxPoints = Math.max(1, Math.floor(maxPoints))
    this.durationMs = durationMs === undefined ? undefined : Math.max(0, durationMs)
    this.originMs = undefined
  }

  addPoint(p: Point, nowMs: number): void {
    if (!this.active) return
    if (this.originMs === undefined) this.originMs = nowMs
    const t = nowMs - this.originMs
    if (this.durationMs !== undefined && t > this.durationMs) return
    if (this.points.length >= this.maxPoints) return
    this.points.push({ x: p.x, y: p.y, t })
  }

  stop(): TimedPoint[] {
    this.active = false
    return this.points.map(p => ({ ...p }))
  }

  get recording(): boolean {
    return this.active
  }
}

/**
 * Normalize a recorded path for replay: shift timestamps so the first point
 * is t=0, preserving every relative delta. Drops nothing, never mutates the
 * input; an empty path replays as empty.
 */
export function replayPath(points: TimedPoint[]): TimedPoint[] {
  if (points.length === 0) return []
  const t0 = points[0]!.t
  return points.map(p => ({ x: p.x, y: p.y, t: p.t - t0 }))
}