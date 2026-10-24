// Tests of the in-browser 2D CDT simulator (js/cdt2d), run with `node --test tests/`.
// They mirror CDT_4d-master/cdt/tests/test2d.cpp: an independent recount after every move, the
// exact proposal-kernel / detailed-balance test of tests/kernel.hpp, plus statistical and
// reproducibility checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../js/cdt2d/rng.js';
import { Simulation, ADD, DELETE, FLIP, ratioAdd, ratioDelete, ratioFlip, canAdd, canDelete } from '../js/cdt2d/moves.js';
import { UP } from '../js/cdt2d/universe.js';
import { ProfileAverage, alignProfile, centreOfVolume, volumeProfile } from '../js/cdt2d/observables.js';

//// ------------------------------------------------------------------ invariants

test('initial geometry is consistent', () => {
  for (const slices of [3, 4, 8, 13]) {
    const sim = new Simulation({ slices, targetVolume: 0 });
    assert.deepEqual(sim.universe.problems(), []);
    assert.equal(sim.N0, 3 * slices);
    assert.equal(sim.N2, 6 * slices);
    assert.deepEqual(sim.sliceSizes, new Array(slices).fill(3));
  }
});

test('check() after every move: 100k proposals per seed at T=8, N2 ~ 200', () => {
  for (const seed of [1, 2, 3, 4]) {
    const sim = new Simulation({ slices: 8, targetVolume: 200, seed });
    const u = sim.universe;
    let accepted = 0, maxN2 = 0;
    for (let i = 0; i < 100000; i++) {
      if (sim.step() !== 0) accepted++;
      const p = u.problems();
      if (p.length > 0) assert.fail(`seed ${seed}, after ${i + 1} proposals:\n  ${p.join('\n  ')}`);
      maxN2 = Math.max(maxN2, sim.N2);
    }
    assert.ok(accepted > 50000, `seed ${seed}: only ${accepted} moves accepted`);
    assert.ok(maxN2 >= 200, `seed ${seed}: never reached the target volume (max N2 ${maxN2})`);
  }
});

test('check() after every move near the minimal triangulation (slices of size 3)', () => {
  // large lambda and no volume fixing: the chain presses against the slice-size bound of canDelete
  const sim = new Simulation({ slices: 5, lambda: 2.0, targetVolume: 0, seed: 11 });
  let minSlice = Infinity;
  for (let i = 0; i < 50000; i++) {
    sim.step();
    sim.universe.check();
    minSlice = Math.min(minSlice, ...sim.sliceSizes);
  }
  assert.equal(minSlice, 3);
});

test('geometry queries: slice rings and strips', () => {
  const sim = new Simulation({ slices: 6, targetVolume: 120, seed: 5 });
  sim.steps(20000);
  const u = sim.universe;
  let n0 = 0, n2 = 0;
  for (let t = 0; t < u.nSlices; t++) {
    const ring = u.sliceVertices(t);
    assert.equal(ring.length, u.sliceSizes[t]);
    assert.equal(new Set(ring).size, ring.length);
    for (const v of ring) assert.equal(u.vTime[v], t);
    const strip = u.stripTriangles(t);
    assert.equal(strip.length, u.sliceSizes[t] + u.sliceSizes[(t + 1) % u.nSlices]);
    for (const tri of strip) assert.equal(u.tTime[tri], u.tType[tri] === UP ? t : (t + 1) % u.nSlices);
    n0 += ring.length;
    n2 += strip.length;
  }
  assert.equal(n0, sim.N0);
  assert.equal(n2, sim.N2);
});

//// ------------------------------------------------------------------ exact kernel test
// For a configuration T every proposal the code can make is enumerated with its exact
// probability p and the acceptance ratio ar the code computes for it. Each one is applied to a
// snapshot of T and the result identified by a label-independent signature, giving the move
// instances I with q(I|T) = sum of p. For the inverse instance I' from T' the same is done. A
// correct Metropolis-Hastings sampler of w(T) = exp(-S(T)), S = lambda N2 + eps |N2 - V|, has
//     ar(I) = q(I'|T') / q(I|T) * exp(-(S(T') - S(T)))   for every instance, hence
//     w(T) q(I|T) min(1, ar(I)) = w(T') q(I'|T') min(1, ar(I')).

const RATIOS = { ratioAdd, ratioDelete, ratioFlip };

function draws(sim, ratios = RATIOS) {
  const u = sim.universe;
  const [fAddDelete, fFlip] = sim.moveFreqs;
  const pAdd = fAddDelete / (fAddDelete + fFlip) / 2;
  const pFlip = fFlip / (fAddDelete + fFlip);
  const out = [];
  const n2 = u.trianglesAll.size, n4 = u.verticesFour.size, nf = u.trianglesFlip.size;
  const arAdd = ratios.ratioAdd(u, sim);
  for (const t of u.trianglesAll.toArray()) if (canAdd(u, t)) out.push({ move: ADD, p: pAdd / n2, ar: arAdd, site: t });
  if (n4 > 0) {
    const arDel = ratios.ratioDelete(u, sim);
    for (const v of u.verticesFour.toArray()) if (canDelete(u, v)) out.push({ move: DELETE, p: pAdd / n4, ar: arDel, site: v });
  }
  for (const t of u.trianglesFlip.toArray()) out.push({ move: FLIP, p: pFlip / nf, ar: ratios.ratioFlip(u, t), site: t });
  return out;
}

function apply(u, d) {
  if (d.move === ADD) u.insertVertex(d.site);
  else if (d.move === DELETE) u.removeVertex(d.site);
  else u.flipLink(d.site);
}

// the triangulation as the sorted list of vertex triples (labels are reused LIFO, so undoing a
// move restores the labels exactly, as with the C++ Pool)
function signature(u) {
  const ts = [];
  for (const t of u.trianglesAll.toArray()) {
    ts.push([u.tVl[t], u.tVr[t], u.tVc[t]].sort((a, b) => a - b).join(','));
  }
  return ts.sort().join(';');
}

function action(sim) {
  const n2 = sim.N2;
  return sim.lambda * n2 + (sim.targetVolume > 0 ? sim.epsilon * Math.abs(n2 - sim.targetVolume) : 0);
}

// all instances reachable from the current state; the state is left unchanged
function instances(sim, ratios) {
  const u = sim.universe;
  const s0 = u.snapshot();
  const S0 = action(sim);
  const out = new Map();
  for (const d of draws(sim, ratios)) {
    u.restore(s0);
    apply(u, d);
    const key = `${d.move}|${signature(u)}`;
    const inst = out.get(key);
    if (!inst) out.set(key, { move: d.move, q: d.p, ar: d.ar, arConsistent: true, dS: action(sim) - S0, first: d });
    else {
      inst.q += d.p;
      if (Math.abs(inst.ar - d.ar) > 1e-12 * Math.abs(inst.ar)) inst.arConsistent = false;
    }
  }
  u.restore(s0);
  return out;
}

// q and ar of the draws of type `move` from the current state that lead to `target`
function qTo(sim, move, target, ratios) {
  const u = sim.universe;
  const s = u.snapshot();
  let q = 0, ar = null, arConsistent = true;
  for (const d of draws(sim, ratios)) {
    if (d.move !== move) continue;
    u.restore(s);
    apply(u, d);
    if (signature(u) !== target) continue;
    q += d.p;
    if (ar === null) ar = d.ar;
    else if (Math.abs(ar - d.ar) > 1e-12 * Math.abs(ar)) arConsistent = false;
  }
  u.restore(s);
  return { q, ar, arConsistent };
}

const INVERSE = [DELETE, ADD, FLIP];

// runs the kernel test on the current state; returns per-move statistics
function kernel(sim, ratios = RATIOS) {
  const u = sim.universe;
  const s0 = u.snapshot();
  const sig0 = signature(u);
  const stats = [ADD, DELETE, FLIP].map(() => ({ instances: 0, irreversible: 0, inconsistentAr: 0, worst: 0, worstBalance: 0 }));
  for (const inst of instances(sim, ratios).values()) {
    const st = stats[inst.move];
    st.instances++;
    if (!inst.arConsistent) st.inconsistentAr++;
    u.restore(s0);
    apply(u, inst.first);
    u.check();
    const rev = qTo(sim, INVERSE[inst.move], sig0, ratios);
    if (rev.q <= 0) {
      st.irreversible++;
      continue;
    }
    if (!rev.arConsistent) st.inconsistentAr++;
    const R = rev.q / inst.q;
    st.worst = Math.max(st.worst, Math.abs(inst.ar / (R * Math.exp(-inst.dS)) - 1));
    // detailed balance with weights relative to w(T): w(T') / w(T) = exp(-dS)
    const forward = inst.q * Math.min(1, inst.ar);
    const backward = Math.exp(-inst.dS) * rev.q * Math.min(1, rev.ar);
    st.worstBalance = Math.max(st.worstBalance, Math.abs(backward / forward - 1));
  }
  u.restore(s0);
  assert.equal(signature(u), sig0, 'state not restored after the kernel test');
  return stats;
}

function assertExact(stats, label) {
  stats.forEach((st, m) => {
    const name = ['add', 'delete', 'flip'][m];
    assert.equal(st.irreversible, 0, `${label}: ${name} has irreversible instances`);
    assert.equal(st.inconsistentAr, 0, `${label}: ${name} has draws of one instance with different ratios`);
    assert.ok(st.worst < 1e-9, `${label}: ${name} ar / (R e^-dS) off by ${st.worst}`);
    assert.ok(st.worstBalance < 1e-9, `${label}: ${name} detailed balance off by ${st.worstBalance}`);
  });
}

// states of a small chain: after a few runs of proposals, and at N2 = V - 2, V, V + 2 where
// the volume term switches
function* kernelStates(sim, runs) {
  yield 'initial';
  for (let k = 0; k < runs; k++) {
    sim.steps(3000);
    yield `after ${3000 * (k + 1)} proposals`;
  }
  for (const dv of [0, -2, 2]) {
    while (sim.N2 !== sim.targetVolume + dv) sim.step();
    yield `N2 = V ${dv === 0 ? '' : dv > 0 ? '+ 2' : '- 2'}`;
  }
}

test('exact detailed balance of add, delete and flip', () => {
  const configs = [
    { slices: 3, targetVolume: 30, epsilon: 0.1, seed: 21 },
    { slices: 4, targetVolume: 48, epsilon: 0.1, seed: 22 },
    { slices: 5, targetVolume: 60, epsilon: 0.05, lambda: 0.6, seed: 23 },
  ];
  for (const c of configs) {
    const sim = new Simulation(c);
    let checked = [0, 0, 0];
    for (const label of kernelStates(sim, 3)) {
      const stats = kernel(sim);
      assertExact(stats, `T=${c.slices} V=${c.targetVolume}, ${label} (N2=${sim.N2})`);
      checked = checked.map((n, m) => n + stats[m].instances);
    }
    for (const n of checked) assert.ok(n > 0, 'every move type must have been checked');
  }
});

test('exact detailed balance without volume fixing and with other move frequencies', () => {
  const sim = new Simulation({ slices: 4, targetVolume: 0, lambda: 0.75, moveFreqs: [3, 1], seed: 31 });
  for (let k = 0; k < 4; k++) {
    sim.steps(2000);
    assertExact(kernel(sim), `V=0, freqs 3:1, state ${k} (N2=${sim.N2})`);
  }
});

test('the kernel test detects the upstream delete ratio at N2 = V', () => {
  // 2d-cdt has `<` in ratioDelete; at N2 == V that is off by exactly e^{4 eps}
  const upstreamDelete = (u, p) => {
    let ar = u.verticesFour.size / (u.n0 - 1.0) * Math.exp(2 * p.lambda);
    const expeps = Math.exp(2 * p.epsilon);
    ar *= u.n2 < p.targetVolume ? 1 / expeps : expeps;
    return ar;
  };
  const sim = new Simulation({ slices: 4, targetVolume: 48, epsilon: 0.1, seed: 41 });
  sim.steps(5000);
  while (sim.N2 !== 48 || sim.universe.verticesFour.size === 0) sim.step();
  const stats = kernel(sim, { ...RATIOS, ratioDelete: upstreamDelete });
  assert.ok(Math.abs(stats[DELETE].worst - (Math.exp(0.4) - 1)) < 1e-9, `delete error ${stats[DELETE].worst}`);
  assertExact(kernel(sim), 'the corrected ratio at the same state');
});

//// ------------------------------------------------------------------ statistics

test('after thermalisation N2 sits at the target volume and the profile is stable', () => {
  const V = 200;
  const sim = new Simulation({ slices: 8, targetVolume: V, seed: 7 });
  sim.grow();
  sim.thermalize(20);
  sim.sweep(5);

  let sum = 0, count = 0;
  const halves = [new ProfileAverage(8), new ProfileAverage(8)];
  const measurements = 60;
  for (let m = 0; m < measurements; m++) {
    for (let i = 0; i < sim.sweepFactor * V; i++) {
      sim.step();
      sum += sim.N2;
      count++;
    }
    while (sim.N2 !== V) sim.step();
    const profile = volumeProfile(sim.universe);
    assert.equal(profile.reduce((a, b) => a + b, 0), V / 2);  // measured at N2 = V, N0 = V / 2
    halves[m < measurements / 2 ? 0 : 1].add(profile);
  }
  const meanN2 = sum / count;
  // over seeds 1-11 the mean lies in 197-211 (|N2 - V| fluctuates on the scale 1 / eps = 50)
  assert.ok(Math.abs(meanN2 - V) < 0.08 * V, `mean N2 = ${meanN2}`);

  const [a, b] = halves.map((h) => h.mean);
  for (const p of [a, b]) assert.ok(Math.abs(p.reduce((x, y) => x + y, 0) - V / 2) < 1e-9);
  let l1 = 0;
  for (let t = 0; t < 8; t++) l1 += Math.abs(a[t] - b[t]);
  assert.ok(l1 / (V / 2) < 0.2, `profile halves differ by ${(100 * l1 / (V / 2)).toFixed(1)}%`);
  // aligned: the peak sits in the middle slice
  assert.equal(a.indexOf(Math.max(...a)), 4);
});

test('acceptance counters add up', () => {
  const sim = new Simulation({ slices: 8, targetVolume: 200, seed: 9 });
  const accepted = sim.steps(30000);
  const acc = sim.acceptance;
  assert.equal(acc.total, 30000);
  assert.equal(acc.accepted[0] + acc.accepted[1] + acc.accepted[2], accepted);
  // flip is proposed half the time, add and delete a quarter each
  assert.ok(Math.abs(acc.proposed[FLIP] / 30000 - 0.5) < 0.02);
  assert.ok(Math.abs(acc.proposed[ADD] / 30000 - 0.25) < 0.02);
  for (let m = 0; m < 3; m++) assert.ok(acc.rate(m) > 0 && acc.rate(m) <= 1);
});

test('profile alignment', () => {
  assert.deepEqual(alignProfile([10, 3, 3, 3, 3, 3]), [3, 3, 3, 10, 3, 3]);
  assert.deepEqual(alignProfile([3, 3, 3, 3, 3, 10, 20, 10]), [3, 3, 3, 10, 20, 10, 3, 3]);
  assert.ok(Math.abs(centreOfVolume([0, 1, 0, 0]) - 1) < 1e-12);
  const avg = new ProfileAverage(4);
  avg.add([1, 5, 1, 1]);
  avg.add([1, 1, 1, 5]);
  assert.deepEqual(avg.mean, [1, 1, 5, 1]);
  assert.deepEqual(avg.std, [0, 0, 0, 0]);
});

//// ------------------------------------------------------------------ reproducibility

test('seeded reproducibility', () => {
  const run = (seed) => {
    const sim = new Simulation({ slices: 8, targetVolume: 200, seed });
    const trace = [];
    for (let k = 0; k < 20; k++) {
      sim.steps(5000);
      trace.push(sim.sliceSizes.join(' '));
    }
    return { trace, acceptance: sim.acceptance.summary(), rng: sim.rng.getState(), sig: signature(sim.universe) };
  };
  const a = run(12345), b = run(12345), c = run(12346);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.trace, c.trace);
});

test('rng: ranges, uniformity and state', () => {
  const rng = new Rng(2024);
  const counts = new Array(7).fill(0);
  for (let i = 0; i < 70000; i++) {
    const k = rng.int(7);
    assert.ok(Number.isInteger(k) && k >= 0 && k < 7);
    counts[k]++;
  }
  for (const n of counts) assert.ok(Math.abs(n - 10000) < 500);
  let sum = 0;
  for (let i = 0; i < 100000; i++) {
    const x = rng.uniform();
    assert.ok(x >= 0 && x < 1);
    sum += x;
  }
  assert.ok(Math.abs(sum / 100000 - 0.5) < 0.005);
  const s = rng.getState();
  const x = [rng.next(), rng.next()];
  rng.setState(s);
  assert.deepEqual([rng.next(), rng.next()], x);
  assert.notEqual(new Rng(0).next(), new Rng(1).next());
  assert.notEqual(new Rng(1).next(), new Rng(2 ** 32 + 1).next());
});

test('throughput (diagnostic)', (t) => {
  const sim = new Simulation({ slices: 16, targetVolume: 2000, seed: 3 });
  sim.grow();
  const n = 2000000;
  const t0 = performance.now();
  sim.steps(n);
  const seconds = (performance.now() - t0) / 1000;
  t.diagnostic(`${(n / seconds / 1e6).toFixed(2)} M proposals/s at T=16, V=2000`);
  sim.universe.check();
});
