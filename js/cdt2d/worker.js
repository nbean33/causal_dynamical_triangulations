// Web Worker that runs the 2D CDT chain for learn/simulator.html, so the page stays responsive.
//
// Messages in:
//   { type: 'init', slices, targetVolume, lambda, seed }   build, grow and thermalise a new universe
//   { type: 'run', rate }     run at `rate` proposals per second (Infinity: as fast as possible)
//   { type: 'pause' }
//   { type: 'stepAccepted' }  propose until one move is accepted, then pause
//   { type: 'setLambda', lambda }
//   { type: 'resetAverage' }
// Messages out:
//   { type: 'ready' } after init, then { type: 'state', ... } snapshots (see snapshot());
//   { type: 'runaway', N2 } when the volume ran away and the chain paused itself

import { Simulation } from './moves.js';
import { geometry } from './render.js';
import { ProfileAverage, alignProfile, MOVE_NAMES } from './observables.js';

const TICK_MS = 16;          // length of one work slice
const POST_MS = 50;          // at most 20 snapshots per second
const MEASURE_EVERY = 10;    // profile measurements every MEASURE_EVERY * V proposals
const RUNAWAY = 5;           // pause when N2 exceeds RUNAWAY * V

let sim = null;
let average = null;
let running = false;
let rate = Infinity;
let proposals = 0;
let sinceMeasure = 0;
let lastAccepted = null;
let lastPost = 0;
let timer = null;
let rateWindow = { t: 0, n: 0, value: 0 };

function measure() {
  average.add(sim.sliceSizes);
  sinceMeasure = 0;
}

function snapshot() {
  const sizes = sim.sliceSizes;
  const now = performance.now();
  if (now - rateWindow.t > 500) {
    rateWindow.value = (proposals - rateWindow.n) / ((now - rateWindow.t) / 1000);
    rateWindow = { t: now, n: proposals, value: rateWindow.value };
  }
  postMessage({
    type: 'state',
    geom: geometry(sim.universe),
    sizes,
    aligned: alignProfile(sizes),
    mean: average.mean,
    std: average.std,
    measurements: average.count,
    N0: sim.N0,
    N2: sim.N2,
    targetVolume: sim.targetVolume,
    lambda: sim.lambda,
    proposals,
    acceptance: sim.acceptance.summary(),
    lastAccepted,
    running,
    rate: running ? rateWindow.value : 0,
  });
  lastPost = now;
}

// run `n` proposals, measuring the profile on schedule; stop early at the first accepted move if
// asked, or if the volume runs away (lambda too far below ln 2 for the weak linear volume term)
function work(n, untilAccepted = false) {
  const every = MEASURE_EVERY * sim.targetVolume;
  const limit = RUNAWAY * sim.targetVolume;
  for (let i = 0; i < n; i++) {
    const r = sim.attemptMove();
    proposals++;
    if (++sinceMeasure >= every) measure();
    if (r !== 0) {
      lastAccepted = MOVE_NAMES[r - 1];
      if (untilAccepted) return true;
      if (sim.N2 > limit) {
        running = false;
        postMessage({ type: 'runaway', N2: sim.N2 });
        return false;
      }
    }
  }
  return false;
}

function tick() {
  timer = null;
  if (!running || !sim) return;
  const start = performance.now();
  if (rate === Infinity) {
    // as many proposals as fit in the slice, in chunks so the clock is checked rarely
    do work(20000); while (running && performance.now() - start < TICK_MS);
  } else {
    work(Math.max(1, Math.round(rate * TICK_MS / 1000)));
  }
  if (!running || performance.now() - lastPost >= POST_MS) snapshot();
  if (!running) return;
  timer = setTimeout(tick, rate === Infinity ? 0 : Math.max(0, TICK_MS - (performance.now() - start)));
}

function schedule() {
  if (timer === null && running) timer = setTimeout(tick, 0);
}

onmessage = ({ data: msg }) => {
  switch (msg.type) {
    case 'init': {
      running = false;
      sim = new Simulation({
        slices: msg.slices,
        targetVolume: msg.targetVolume,
        lambda: msg.lambda,
        seed: msg.seed,
      });
      sim.grow();
      sim.thermalize(20);
      sim.acceptance.reset();
      average = new ProfileAverage(msg.slices);
      proposals = 0;
      sinceMeasure = 0;
      lastAccepted = null;
      rateWindow = { t: performance.now(), n: 0, value: 0 };
      postMessage({ type: 'ready' });
      snapshot();
      break;
    }
    case 'run':
      rate = msg.rate;
      running = true;
      rateWindow = { t: performance.now(), n: proposals, value: rateWindow.value };
      schedule();
      break;
    case 'pause':
      running = false;
      snapshot();
      break;
    case 'stepAccepted':
      running = false;
      if (sim) {
        // bounded, so a pathological state cannot hang the worker
        work(1e6, true);
        snapshot();
      }
      break;
    case 'setLambda':
      if (sim) sim.lambda = msg.lambda;
      break;
    case 'resetAverage':
      if (average) average.reset();
      if (sim) sim.acceptance.reset();
      if (sim && !running) snapshot();
      break;
  }
};
