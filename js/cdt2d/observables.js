// Observables of the 2D CDT simulator: the volume profile, its running average aligned by the
// centre of volume, and acceptance counters per move.
// Derived from 2d-cdt (MIT, (c) 2020 Joren Brunekreef and Andrzej Görlich) via the corrected
// CDT_4d-master port; see LICENSE in this folder.

export const MOVE_NAMES = ['add', 'delete', 'flip'];

// slice sizes n_t, t = 0..T-1 (cdt/2d/observables/volume_profile.cpp)
export function volumeProfile(universe) {
  return Array.from(universe.sliceSizes);
}

// centre of volume of a periodic profile, in [0, T): the direction of sum_t n_t e^{2 pi i t / T}
export function centreOfVolume(profile) {
  const T = profile.length;
  let c = 0, s = 0;
  for (let t = 0; t < T; t++) {
    c += profile[t] * Math.cos(2 * Math.PI * t / T);
    s += profile[t] * Math.sin(2 * Math.PI * t / T);
  }
  if (c === 0 && s === 0) return 0;  // perfectly flat: any slice is a centre
  const phase = Math.atan2(s, c);
  return ((phase / (2 * Math.PI)) * T + T) % T;
}

// the profile rotated so that its centre of volume sits in slice floor(T / 2)
export function alignProfile(profile) {
  const T = profile.length;
  const shift = Math.floor(T / 2) - Math.round(centreOfVolume(profile));
  const out = new Array(T);
  for (let t = 0; t < T; t++) out[(((t + shift) % T) + T) % T] = profile[t];
  return out;
}

// running average of aligned profiles, with the per-slice standard deviation
export class ProfileAverage {
  constructor(nSlices) {
    this.nSlices = nSlices;
    this.reset();
  }

  reset() {
    this.count = 0;
    this.sum = new Float64Array(this.nSlices);
    this.sumSq = new Float64Array(this.nSlices);
  }

  add(profile, { align = true } = {}) {
    const p = align ? alignProfile(profile) : profile;
    for (let t = 0; t < this.nSlices; t++) {
      this.sum[t] += p[t];
      this.sumSq[t] += p[t] * p[t];
    }
    this.count++;
  }

  get mean() {
    return Array.from(this.sum, (x) => (this.count > 0 ? x / this.count : 0));
  }

  get std() {
    return Array.from(this.sum, (x, t) => {
      if (this.count < 2) return 0;
      const m = x / this.count;
      return Math.sqrt(Math.max(0, this.sumSq[t] / this.count - m * m));
    });
  }
}

// proposals and acceptances per move type (0 add, 1 delete, 2 flip)
export class AcceptanceCounter {
  constructor() {
    this.reset();
  }

  reset() {
    this.proposed = [0, 0, 0];
    this.accepted = [0, 0, 0];
  }

  record(move, accepted) {
    this.proposed[move]++;
    if (accepted) this.accepted[move]++;
  }

  rate(move) {
    return this.proposed[move] > 0 ? this.accepted[move] / this.proposed[move] : 0;
  }

  get total() {
    return this.proposed[0] + this.proposed[1] + this.proposed[2];
  }

  summary() {
    return MOVE_NAMES.map((name, m) => ({ move: name, proposed: this.proposed[m], accepted: this.accepted[m], rate: this.rate(m) }));
  }
}
