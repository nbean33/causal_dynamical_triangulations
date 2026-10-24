// Monte Carlo moves of 2D CDT and the Simulation that drives them: port of cdt/2d/simulation.cpp.
// Derived from 2d-cdt (MIT, (c) 2020 Joren Brunekreef and Andrzej Görlich) via the corrected
// CDT_4d-master port; see LICENSE in this folder.
//
// The chain samples triangulations with weight exp(-lambda N2 - epsilon |N2 - V|), V the target
// volume (no volume fixing for V = 0). attemptMove() proposes add / delete with probability 1/4
// each and flip with probability 1/2 (moveFreqs {1, 1}); the acceptance ratios below are the
// exact Metropolis-Hastings ratios for these proposals (tests/cdt2d.test.js checks them).

import { Rng } from './rng.js';
import { Universe } from './universe.js';
import { AcceptanceCounter } from './observables.js';

export const ADD = 0;
export const DELETE = 1;
export const FLIP = 2;

// Acceptance ratios and site checks. `p` holds lambda, epsilon and targetVolume (a Simulation
// will do). They read the state before the move, as in the C++.

// add: q_rev / q_fwd = N0 / (n4 + 1), action change 2 lambda -+ 2 epsilon
export function ratioAdd(u, p) {
  const n0 = u.n0;
  const n0Four = u.verticesFour.size;
  let ar = n0 / (n0Four + 1.0) * Math.exp(-2 * p.lambda);
  if (p.targetVolume > 0) {
    const expeps = Math.exp(2 * p.epsilon);
    ar *= u.n2 < p.targetVolume ? expeps : 1 / expeps;
  }
  return ar;
}

// delete: q_rev / q_fwd = n4 / (N0 - 1). At N2 == V a delete raises epsilon |N2 - V| by
// 2 epsilon, hence `<=` (the CDT_4d-master fix; upstream 2d-cdt has `<`)
export function ratioDelete(u, p) {
  const n0 = u.n0;
  const n0Four = u.verticesFour.size;
  let ar = n0Four / (n0 - 1.0) * Math.exp(2 * p.lambda);
  if (p.targetVolume > 0) {
    const expeps = Math.exp(2 * p.epsilon);
    ar *= u.n2 <= p.targetVolume ? 1 / expeps : expeps;
  }
  return ar;
}

// flip: q_rev / q_fwd = nFlip / nFlip', where nFlip' is the size of trianglesFlip after the flip
export function ratioFlip(u, t) {
  const wa = u.trianglesFlip.size;
  let wb = wa;
  wb += u.tType[t] === u.tType[u.tTl[t]] ? 1 : -1;
  const tr = u.tTr[t];
  wb += u.tType[tr] === u.tType[u.tTr[tr]] ? 1 : -1;
  return 1.0 * wa / wb;
}

// on the torus every triangle can take an add (the C++ only refuses time 0 on the sphere)
export function canAdd(u, t) {
  return true;
}

// reject moves that shrink slices below size 3
export function canDelete(u, v) {
  return u.sliceSizes[u.vTime[v]] >= 4;
}

export class Simulation {
  constructor({
    slices = 8,
    lambda = Math.LN2,
    targetVolume = 0,
    epsilon = 0.02,
    seed = 0,
    moveFreqs = [1, 1],  // relative weights of {add or delete} and flip
    sweepFactor = 100,  // proposals per sweep / targetVolume
    width = 3,
  } = {}) {
    if (!Number.isInteger(targetVolume) || targetVolume < 0 || targetVolume % 2 !== 0) {
      throw new RangeError('Simulation: targetVolume must be a non-negative even integer (N2 is always even)');
    }
    this.rng = new Rng(seed);
    this.universe = new Universe(slices, this.rng, { width });
    this.lambda = lambda;
    this.epsilon = epsilon;
    this.targetVolume = targetVolume;
    this.moveFreqs = moveFreqs;
    this.sweepFactor = sweepFactor;
    this.acceptance = new AcceptanceCounter();
  }

  get N0() {
    return this.universe.n0;
  }

  get N2() {
    return this.universe.n2;
  }

  get sliceSizes() {
    return Array.from(this.universe.sliceSizes);
  }

  get nSlices() {
    return this.universe.nSlices;
  }

  ratioAdd() {
    return ratioAdd(this.universe, this);
  }

  ratioDelete() {
    return ratioDelete(this.universe, this);
  }

  ratioFlip(t) {
    return ratioFlip(this.universe, t);
  }

  // one proposal; returns 0 if rejected, 1 add, 2 delete, 3 flip (Simulation::attemptMove)
  attemptMove() {
    const [fAddDelete, fFlip] = this.moveFreqs;
    const move = this.rng.int(fAddDelete + fFlip);
    if (move < fAddDelete) {
      if (this.rng.int(2) === 0) {
        const ok = this.moveAdd();
        this.acceptance.record(ADD, ok);
        return ok ? 1 : 0;
      }
      const ok = this.moveDelete();
      this.acceptance.record(DELETE, ok);
      return ok ? 2 : 0;
    }
    const ok = this.moveFlip();
    this.acceptance.record(FLIP, ok);
    return ok ? 3 : 0;
  }

  moveAdd() {
    const u = this.universe;
    const ar = this.ratioAdd();
    const t = u.trianglesAll.pick();
    if (!canAdd(u, t)) return false;
    if (ar < 1.0 && this.rng.uniform() > ar) return false;
    u.insertVertex(t);
    return true;
  }

  moveDelete() {
    const u = this.universe;
    if (u.verticesFour.size === 0) return false;
    const ar = this.ratioDelete();
    if (ar < 1.0 && this.rng.uniform() > ar) return false;
    const v = u.verticesFour.pick();
    if (!canDelete(u, v)) return false;
    u.removeVertex(v);
    return true;
  }

  moveFlip() {
    const u = this.universe;
    if (u.trianglesFlip.size === 0) return false;
    const t = u.trianglesFlip.pick();
    const ar = this.ratioFlip(t);
    if (ar < 1.0 && this.rng.uniform() > ar) return false;
    u.flipLink(t);
    return true;
  }

  step() {
    return this.attemptMove();
  }

  // n proposals; returns the number accepted
  steps(n) {
    let accepted = 0;
    for (let i = 0; i < n; i++) if (this.attemptMove() !== 0) accepted++;
    return accepted;
  }

  // Simulation::sweep: sweepFactor * V proposals, then proposals until N2 == V again, so that
  // measurements are taken at fixed volume. Without a target volume: sweepFactor * N2 proposals.
  sweep(n = 1) {
    for (let k = 0; k < n; k++) {
      const V = this.targetVolume;
      const proposals = this.sweepFactor * (V > 0 ? V : this.N2);
      for (let i = 0; i < proposals; i++) this.attemptMove();
      if (V > 0) {
        do this.attemptMove(); while (this.N2 !== V);
      }
    }
  }

  // Simulation::grow: V proposals at a time until N2 reaches V; returns the number of rounds
  grow() {
    const V = this.targetVolume;
    if (V <= 0) return 0;
    let rounds = 0;
    do {
      for (let i = 0; i < V; i++) this.attemptMove();
      rounds++;
    } while (this.N2 < V);
    return rounds;
  }

  // largest number of neighbours of a vertex in the next and in the previous slice
  maxCoordination() {
    const u = this.universe;
    let maxUp = 0, maxDown = 0;
    for (const v of u.liveVertices()) {
      maxUp = Math.max(maxUp, u.coordUp(v));
      maxDown = Math.max(maxDown, u.coordDown(v));
    }
    return { maxUp, maxDown };
  }

  // Simulation::thermalize: rounds of 100 V proposals until no vertex has more than log2(2 V)
  // neighbours in the next or previous slice; returns the number of rounds
  thermalize(maxRounds = Infinity) {
    const V = this.targetVolume;
    if (V <= 0) throw new RangeError('Simulation.thermalize: needs a target volume');
    const coordBound = Math.log(2 * V) / Math.log(2);
    let rounds = 0;
    let c;
    do {
      for (let i = 0; i < 100 * V; i++) this.attemptMove();
      c = this.maxCoordination();
      rounds++;
    } while ((c.maxUp > coordBound || c.maxDown > coordBound) && rounds < maxRounds);
    return rounds;
  }

  // Simulation::tune (compiled out upstream: "tuning isn't used in the current setup").
  // Adjusts epsilon and lambda from the mean and variance of N2 over rounds of 100 V proposals;
  // returns one record per round.
  tune(tuneSteps = 50) {
    const V = this.targetVolume;
    if (V <= 0) throw new RangeError('Simulation.tune: needs a target volume');
    const log = [];
    const volumes = [];
    this.epsilon = 0.02;
    for (let k = 0; k < tuneSteps; k++) {
      for (let i = 0; i < V; i++) {
        for (let j = 0; j < 100; j++) this.attemptMove();
        volumes.push(this.N2);
      }

      let avg = 0;
      for (const v of volumes) avg += v;
      avg /= volumes.length;

      let sd = 0;  // the variance, despite the name (as in the C++)
      for (const v of volumes) sd += (v - avg) * (v - avg);
      sd /= volumes.length;

      const d2 = (V - avg) * (V - avg);
      if (d2 < 2 * sd) {
        this.epsilon *= 0.7;
        if (this.epsilon < 0.02) {
          this.epsilon = 0.02;
          this.lambda -= 0.003 * (V - avg) / Math.sqrt(sd);
        }
      } else if (d2 > 8 * sd) {
        this.epsilon *= 1.2;
        if (this.epsilon > 5.0) this.epsilon = 5.0;
      } else if (d2 < 0.04 * V * V) {
        this.lambda += 0.6 * Math.sign(avg - V) * this.epsilon;
      }
      volumes.length = 0;
      log.push({ step: k, epsilon: this.epsilon, lambda: this.lambda, avg, sd });
    }
    return log;
  }
}
