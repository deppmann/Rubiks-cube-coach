// Practice tools: WCA-style timer, statistics and persisted solve history.
// Pure and DOM-free; every Timer method takes a timestamp so tests are deterministic.

import { randomScramble } from './cube.js';

export const HOLD_MS = 300;        // hold the trigger this long before the timer is "ready"
export const INSPECT_MS = 15000;   // free inspection
export const PLUS2_LIMIT_MS = 17000; // starting after this is a DNF

// "1:02.35" above a minute, "9.87" otherwise, "DNF" for DNF. Centiseconds are truncated like WCA.
export function formatTime(ms) {
  if (ms === null || ms === undefined || ms === 'DNF' || !Number.isFinite(ms)) return 'DNF';
  const cs = Math.floor(Math.max(0, ms) / 10);
  const s = Math.floor(cs / 100);
  const frac = String(cs % 100).padStart(2, '0');
  if (s < 60) return `${s}.${frac}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${frac}`;
}

export class Timer {
  // idle → inspecting → (holding → ready) → running → stopped. 'holding' = trigger down but < 300 ms.
  constructor({ inspection = true, now = () => performance.now() } = {}) {
    this.inspection = inspection;
    this.now = now;
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.penalty = null;
    this.ms = 0;
    this._inspectStart = null;
    this._holdStart = null;
    this._runStart = null;
    this._resumeState = 'idle'; // where to go back to if the hold is released too early
  }

  startInspection(now = this.now()) {
    if (this.state !== 'idle') return;
    this.state = 'inspecting';
    this._inspectStart = now;
  }

  // Inspection running past 17 s ends the attempt as a DNF.
  _checkInspection(now) {
    if (this._inspectStart !== null && this.state !== 'running' && this.state !== 'stopped'
        && now - this._inspectStart > PLUS2_LIMIT_MS) {
      this.state = 'stopped';
      this.penalty = 'DNF';
      this.ms = 0;
    }
  }

  press(now = this.now()) {
    this._checkInspection(now);
    if (this.state === 'stopped') {
      // Pressing after a result starts a fresh attempt.
      this.reset();
    }
    if (this.state === 'running') {
      this.ms = now - this._runStart;
      this.state = 'stopped';
    } else if (this.state === 'idle') {
      if (this.inspection) this.startInspection(now);
      else { this._resumeState = 'idle'; this.state = 'holding'; this._holdStart = now; }
    } else if (this.state === 'inspecting') {
      this._resumeState = 'inspecting';
      this.state = 'holding';
      this._holdStart = now;
    }
  }

  release(now = this.now()) {
    this._checkInspection(now);
    if (this.state !== 'holding' && this.state !== 'ready') return; // e.g. release after stopping
    if (now - this._holdStart >= HOLD_MS) {
      if (this._inspectStart !== null) {
        const used = now - this._inspectStart;
        this.penalty = used > INSPECT_MS ? '+2' : null;
      }
      this.state = 'running';
      this._runStart = now;
    } else {
      this.state = this._resumeState; // released too early: nothing happens
      this._holdStart = null;
    }
  }

  // The finished solve as { ms, penalty } (ms excludes the +2), or null until stopped.
  result() {
    return this.state === 'stopped' ? { ms: this.ms, penalty: this.penalty } : null;
  }

  tick(now = this.now()) {
    this._checkInspection(now);
    if (this.state === 'holding' && now - this._holdStart >= HOLD_MS) this.state = 'ready';
    let display;
    switch (this.state) {
      case 'idle': display = '0.00'; break;
      case 'running': display = formatTime(now - this._runStart); break;
      case 'stopped':
        display = this.penalty === 'DNF' ? 'DNF'
          : formatTime(this.ms + (this.penalty === '+2' ? 2000 : 0)) + (this.penalty === '+2' ? '+' : '');
        break;
      default:
        if (this._inspectStart === null) { display = '0.00'; break; }
        {
          const used = now - this._inspectStart;
          display = used > INSPECT_MS ? '+2' : String(Math.max(0, Math.ceil((INSPECT_MS - used) / 1000)));
        }
    }
    // While holding/ready during inspection the penalty shown is the one that would apply.
    let penalty = this.penalty;
    if (this._inspectStart !== null && (this.state === 'inspecting' || this.state === 'holding' || this.state === 'ready')) {
      penalty = now - this._inspectStart > INSPECT_MS ? '+2' : null;
    }
    return { state: this.state, display, penalty };
  }
}

// ---- Statistics -----------------------------------------------------------------

// Effective time in ms: DNF → Infinity, +2 adds two seconds.
const effective = (s) => (s.penalty === 'DNF' ? Infinity : s.ms + (s.penalty === '+2' ? 2000 : 0));

// WCA average of the given times: drop best and worst (5% each side, at least one),
// one DNF counts as worst, more DNFs than dropped → DNF. Returns ms, 'DNF', or null if too few.
function trimmedAverage(times, n) {
  if (times.length < n) return null;
  const w = times.slice(-n).sort((a, b) => a - b);
  const trim = Math.ceil(n * 0.05);
  const kept = w.slice(trim, n - trim);
  if (kept.some((t) => t === Infinity)) return 'DNF';
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

// best/worst/mean ignore DNFs (null if every solve is a DNF); ao5/ao12 are the latest windows.
export function stats(solves) {
  const times = solves.map(effective);
  const ok = times.filter(Number.isFinite);
  return {
    count: solves.length,
    best: ok.length ? Math.min(...ok) : null,
    worst: ok.length ? Math.max(...ok) : null,
    mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null,
    ao5: trimmedAverage(times, 5),
    ao12: trimmedAverage(times, 12),
  };
}

// ---- History --------------------------------------------------------------------

export class History {
  constructor(storage, key = 'rcc.solves') {
    this.storage = storage;
    this.key = key;
    this.solves = this._load();
  }

  _load() {
    try {
      const data = JSON.parse(this.storage.getItem(this.key));
      if (!Array.isArray(data)) return [];
      return data.filter((s) => s && typeof s === 'object' && Number.isFinite(s.ms));
    } catch {
      return []; // corrupt JSON or unavailable storage: start empty
    }
  }

  _save() {
    try { this.storage.setItem(this.key, JSON.stringify(this.solves)); } catch { /* quota/private mode: keep in memory */ }
  }

  add(solve) {
    this.solves.push({ penalty: null, date: Date.now(), ...solve });
    this._save();
  }

  remove(index) {
    if (index >= 0 && index < this.solves.length) { this.solves.splice(index, 1); this._save(); }
  }

  clear() {
    this.solves = [];
    this._save();
  }

  all() {
    return this.solves.map((s) => ({ ...s }));
  }

  setPenalty(index, penalty) {
    if (!this.solves[index]) return;
    if (penalty !== null && penalty !== '+2' && penalty !== 'DNF') throw new Error(`bad penalty ${penalty}`);
    this.solves[index].penalty = penalty;
    this._save();
  }
}

export function scrambleForPractice(rand = Math.random) {
  return randomScramble(20, rand).join(' ');
}
