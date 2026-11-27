import { describe, it, expect } from 'vitest'
import { seededRng, humanMousePath, humanTypingDelays, MouseRecorder, replayPath } from '../src/stealth/humanize.ts'

describe('seededRng', () => {
  it('produces the same sequence in [0, 1) for the same seed', () => {
    const a = seededRng(42)
    const b = seededRng(42)
    const seqA = Array.from({ length: 100 }, () => a())
    const seqB = Array.from({ length: 100 }, () => b())
    expect(seqA).toEqual(seqB)
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('produces different sequences for different seeds', () => {
    const a = seededRng(1)
    const b = seededRng(2)
    const seqA = Array.from({ length: 20 }, () => a())
    const seqB = Array.from({ length: 20 }, () => b())
    expect(seqA).not.toEqual(seqB)
  })
})

describe('humanMousePath', () => {
  const from = { x: 10, y: 20 }
  const to = { x: 310, y: 220 }

  it('starts exactly at `from` at t=0 and ends exactly at `to`', () => {
    const path = humanMousePath(from, to, seededRng(7))
    expect(path[0]).toEqual({ x: 10, y: 20, t: 0 })
    const last = path[path.length - 1]!
    expect(last.x).toBe(310)
    expect(last.y).toBe(220)
  })

  it('honours explicit steps and durationMs', () => {
    const path = humanMousePath(from, to, seededRng(7), { steps: 10, durationMs: 400 })
    expect(path).toHaveLength(11)
    expect(path[0]).toEqual({ x: 10, y: 20, t: 0 })
    expect(path[10]).toEqual({ x: 310, y: 220, t: 400 })
  })

  it('has monotonic non-decreasing timestamps', () => {
    const path = humanMousePath(from, to, seededRng(9))
    expect(path.length).toBeGreaterThan(1)
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!.t).toBeGreaterThanOrEqual(path[i - 1]!.t)
    }
  })

  it('is curved: points deviate from the straight line', () => {
    const path = humanMousePath({ x: 0, y: 0 }, { x: 300, y: 0 }, seededRng(11))
    const maxDeviation = Math.max(...path.map(p => Math.abs(p.y)))
    expect(maxDeviation).toBeGreaterThan(1)
  })

  it('eases motion: smaller spatial steps at the start and end than mid-path', () => {
    const path = humanMousePath({ x: 0, y: 0 }, { x: 400, y: 0 }, seededRng(5), { steps: 20, durationMs: 400 })
    const step = (i: number) => Math.hypot(path[i + 1]!.x - path[i]!.x, path[i + 1]!.y - path[i]!.y)
    const mid = Math.floor(path.length / 2)
    expect(step(0)).toBeLessThan(step(mid) * 0.5)
    expect(step(path.length - 2)).toBeLessThan(step(mid) * 0.5)
  })

  it('is deterministic for the same seed and differs across seeds', () => {
    const a = humanMousePath(from, to, seededRng(123))
    const b = humanMousePath(from, to, seededRng(123))
    expect(a).toEqual(b)
    const c = humanMousePath(from, to, seededRng(124))
    expect(c).not.toEqual(a)
  })

  it('clamps distance-based defaults to steps 8..60 and duration 120..900ms', () => {
    const short = humanMousePath({ x: 0, y: 0 }, { x: 3, y: 4 }, seededRng(1))
    expect(short).toHaveLength(9)
    expect(short[short.length - 1]!.t).toBe(120)
    const long = humanMousePath({ x: 0, y: 0 }, { x: 20000, y: 0 }, seededRng(1))
    expect(long).toHaveLength(61)
    expect(long[long.length - 1]!.t).toBe(900)
  })

  it('handles zero distance without NaN', () => {
    const p = { x: 50, y: 60 }
    const path = humanMousePath(p, p, seededRng(3))
    expect(path[0]!.t).toBe(0)
    for (const q of path) {
      expect(q.x).toBe(50)
      expect(q.y).toBe(60)
      expect(Number.isFinite(q.t)).toBe(true)
    }
  })
})

describe('humanTypingDelays', () => {
  it('returns one positive delay per character', () => {
    const text = 'hello world, this is a test!'
    const delays = humanTypingDelays(text, seededRng(21))
    expect(delays).toHaveLength(text.length)
    for (const d of delays) expect(d).toBeGreaterThan(0)
    expect(humanTypingDelays('', seededRng(21))).toEqual([])
  })

  it('is deterministic for the same seed', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    expect(humanTypingDelays(text, seededRng(99))).toEqual(humanTypingDelays(text, seededRng(99)))
  })

  it('scales the mean delay with wpm (5 chars per word)', () => {
    const text = 'x'.repeat(400)
    const base65 = 60000 / (65 * 5)
    const d65 = humanTypingDelays(text, seededRng(5))
    const mean65 = d65.reduce((s, v) => s + v, 0) / d65.length
    expect(mean65).toBeGreaterThan(base65 * 0.75)
    expect(mean65).toBeLessThan(base65 * 1.25)
    const d130 = humanTypingDelays(text, seededRng(5), { wpm: 130 })
    const mean130 = d130.reduce((s, v) => s + v, 0) / d130.length
    expect(mean130).toBeLessThan(mean65 * 0.75)
  })

  it('adds occasional longer pauses at word boundaries', () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    const delays = humanTypingDelays(text, seededRng(17))
    const base = 60000 / (65 * 5)
    expect(Math.max(...delays)).toBeGreaterThan(2 * base)
  })
})

describe('MouseRecorder', () => {
  it('records points with relative timestamps between start and stop', () => {
    const rec = new MouseRecorder()
    expect(rec.recording).toBe(false)
    rec.addPoint({ x: 1, y: 1 }, 500)
    expect(rec.stop()).toEqual([])
    rec.start()
    expect(rec.recording).toBe(true)
    rec.addPoint({ x: 10, y: 20 }, 1000)
    rec.addPoint({ x: 11, y: 21 }, 1050)
    rec.addPoint({ x: 15, y: 25 }, 1200)
    const path = rec.stop()
    expect(rec.recording).toBe(false)
    expect(path).toEqual([
      { x: 10, y: 20, t: 0 },
      { x: 11, y: 21, t: 50 },
      { x: 15, y: 25, t: 200 },
    ])
    rec.addPoint({ x: 99, y: 99 }, 1300)
    expect(rec.stop()).toEqual(path)
  })

  it('bounds the buffer to maxPoints (custom and default 500)', () => {
    const rec = new MouseRecorder()
    rec.start(3)
    for (let i = 0; i < 5; i++) rec.addPoint({ x: i, y: 0 }, 1000 + i * 10)
    expect(rec.stop()).toEqual([
      { x: 0, y: 0, t: 0 },
      { x: 1, y: 0, t: 10 },
      { x: 2, y: 0, t: 20 },
    ])
    const big = new MouseRecorder()
    big.start()
    for (let i = 0; i < 600; i++) big.addPoint({ x: i, y: i }, 1000 + i)
    expect(big.stop()).toHaveLength(500)
  })

  it('drops points beyond the duration window measured from the first point', () => {
    const rec = new MouseRecorder()
    rec.start(100, 500)
    rec.addPoint({ x: 0, y: 0 }, 1000)
    rec.addPoint({ x: 1, y: 0 }, 1300)
    rec.addPoint({ x: 2, y: 0 }, 1801)
    expect(rec.stop()).toEqual([
      { x: 0, y: 0, t: 0 },
      { x: 1, y: 0, t: 300 },
    ])
  })

  it('keeps points across long gaps when no duration limit is set', () => {
    const rec = new MouseRecorder()
    rec.start()
    rec.addPoint({ x: 0, y: 0 }, 0)
    rec.addPoint({ x: 1, y: 0 }, 60000)
    expect(rec.stop()).toEqual([
      { x: 0, y: 0, t: 0 },
      { x: 1, y: 0, t: 60000 },
    ])
  })

  it('start replaces any earlier recording', () => {
    const rec = new MouseRecorder()
    rec.start()
    rec.addPoint({ x: 1, y: 1 }, 100)
    rec.start()
    expect(rec.recording).toBe(true)
    expect(rec.stop()).toEqual([])
  })
})

describe('replayPath', () => {
  it('normalizes timestamps to start at 0 and preserves relative deltas', () => {
    const input = [
      { x: 5, y: 6, t: 1000 },
      { x: 7, y: 8, t: 1050 },
      { x: 9, y: 10, t: 1200 },
    ]
    expect(replayPath(input)).toEqual([
      { x: 5, y: 6, t: 0 },
      { x: 7, y: 8, t: 50 },
      { x: 9, y: 10, t: 200 },
    ])
  })

  it('drops nothing (even duplicate timestamps) and does not mutate the input', () => {
    const input = [
      { x: 0, y: 0, t: 42 },
      { x: 1, y: 1, t: 42 },
      { x: 2, y: 2, t: 100 },
    ]
    const snapshot = input.map(p => ({ ...p }))
    const out = replayPath(input)
    expect(out).toHaveLength(3)
    expect(out[1]!.t).toBe(0)
    expect(out[2]!.t).toBe(58)
    expect(input).toEqual(snapshot)
  })

  it('handles empty and single-point paths', () => {
    expect(replayPath([])).toEqual([])
    expect(replayPath([{ x: 3, y: 4, t: 999 }])).toEqual([{ x: 3, y: 4, t: 0 }])
  })
})