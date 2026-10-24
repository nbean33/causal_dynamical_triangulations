// learn/simulator.html: controls, triangulation view and live plots for the 2D CDT chain, which
// runs in js/cdt2d/worker.js.

import uPlot from '../vendor/uplot-1.6.31/uPlot.esm.js';
import { drawStrip, themeColors } from './cdt2d/render.js';

const $ = id => document.getElementById(id);
const canvas = $('sim-canvas');
const ctx = canvas.getContext('2d');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const worker = new Worker(new URL('./cdt2d/worker.js', import.meta.url), { type: 'module' });

let state = null;        // latest snapshot from the worker
let running = false;
let resumeOnShow = false;
let drawPending = false;
let colors = themeColors();
let canvasSize = { width: 0, height: 0 };
let history = { x: [], y: [] };   // N2 against proposals, for the volume plot

//// formatting

function si(n) {
  if (!isFinite(n)) return 'max';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
}
const pct = x => (100 * x).toFixed(1) + '%';

//// speed: slider 0..100 on a log scale, 100 = as fast as possible

function speedRate() {
  const v = Number($('sim-speed').value);
  return v >= 100 ? Infinity : Math.round(10 ** (2 + 5 * v / 100));
}
function showSpeed() {
  const r = speedRate();
  $('sim-speed-out').textContent = isFinite(r) ? `${si(r)} proposals/s` : 'as fast as possible';
}

//// worker control

function init() {
  const slices = Number($('sim-slices').value);
  const targetVolume = Number($('sim-volume').value);
  const seed = Number($('sim-seed').value) | 0;
  const lambda = Number($('sim-lambda').value);
  history = { x: [], y: [] };
  state = null;
  setStatus('Building and thermalising a new universe…');
  worker.postMessage({ type: 'init', slices, targetVolume, lambda, seed });
}

function setRunning(on) {
  running = on;
  if (on) setStatus('');
  $('sim-run').textContent = on ? 'Pause' : 'Run';
  worker.postMessage(on ? { type: 'run', rate: speedRate() } : { type: 'pause' });
}

function setStatus(text) {
  $('sim-status').textContent = text;
}

worker.onmessage = ({ data }) => {
  if (data.type === 'ready') {
    setStatus('');
    resetPlots();
    if (running) worker.postMessage({ type: 'run', rate: speedRate() });
    return;
  }
  if (data.type === 'runaway') {
    running = false;
    $('sim-run').textContent = 'Run';
    setStatus(`Paused: the universe grew to ${data.N2} triangles, more than 5× the target. ` +
      'λ is too far below ln 2 for the volume penalty to hold it. Raise λ, or build a new universe.');
    return;
  }
  if (data.type === 'state') {
    state = data;
    history.x.push(data.proposals / 1e6);
    history.y.push(data.N2);
    if (history.x.length > 600) { history.x.shift(); history.y.shift(); }
    if (!drawPending) {
      drawPending = true;
      requestAnimationFrame(draw);
    }
  }
};
worker.onerror = (e) => {
  setStatus('The simulation stopped with an error. Reload the page to try again.');
  console.error(e);
};

//// drawing

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvasSize = { width: rect.width, height: rect.height };
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function draw() {
  drawPending = false;
  if (!state || !canvasSize.width) return;
  drawStrip(ctx, state.geom, { ...canvasSize, colors, cylinder: $('sim-cylinder').checked });

  $('stat-n2').textContent = `${state.N2} (target ${state.targetVolume})`;
  $('stat-n0').textContent = state.N0;
  $('stat-lambda').textContent = state.lambda.toFixed(4);
  $('stat-proposals').textContent = si(state.proposals);
  $('stat-rate').textContent = state.running ? `${si(state.rate)}/s` : 'paused';
  $('stat-meas').textContent = state.measurements;
  const acc = Object.fromEntries(state.acceptance.map(a => [a.move, a]));
  $('stat-acc').textContent = ['add', 'delete', 'flip'].map(m => `${m} ${pct(acc[m].rate)}`).join(' · ');
  $('stat-last').textContent = state.lastAccepted ?? '—';
  updatePlots();
}

//// plots

let profilePlot = null;
let volumePlot = null;

function axisStyle() {
  const cs = getComputedStyle(document.documentElement);
  const v = name => cs.getPropertyValue(name).trim();
  return { text: v('--text-muted'), grid: v('--border'), c1: v('--plot-1'), c2: v('--plot-2'), c3: v('--plot-3') };
}

function plotWidth(el) {
  return Math.max(200, Math.floor(el.getBoundingClientRect().width));
}

function makePlots() {
  const st = axisStyle();
  const axis = (label, size = 40) => ({ stroke: st.text, grid: { stroke: st.grid, width: 1 }, ticks: { stroke: st.grid, width: 1 }, label, labelSize: 18, size });
  profilePlot?.destroy();
  volumePlot?.destroy();
  const pEl = $('sim-profile'), vEl = $('sim-volplot');
  pEl.replaceChildren();
  vEl.replaceChildren();
  profilePlot = new uPlot({
    width: plotWidth(pEl), height: 210,
    title: 'Volume profile, centred',
    scales: { x: { time: false } },
    legend: { show: true, live: false },
    cursor: { show: false },
    axes: [axis('slice (centre of volume in the middle)'), axis('vertices in slice', 50)],
    series: [
      {},
      { label: 'now', stroke: st.c1, width: 1.2 },
      { label: 'average', stroke: st.c2, width: 2.2 },
      { label: '− 1 sd', stroke: st.c2, width: 1, dash: [4, 4] },
      { label: '+ 1 sd', stroke: st.c2, width: 1, dash: [4, 4] },
    ],
  }, [[], [], [], [], []], pEl);
  volumePlot = new uPlot({
    width: plotWidth(vEl), height: 150,
    title: 'Number of triangles',
    scales: { x: { time: false } },
    legend: { show: false },
    cursor: { show: false },
    axes: [axis('proposals (millions)'), axis('N₂', 56)],
    series: [{}, { stroke: st.c3, width: 1.4 }, { stroke: st.text, width: 1, dash: [3, 4] }],
  }, [[], [], []], vEl);
  // the numbers are in the stats list beside the plots, so the canvases are decorative to screen readers
  for (const el of [pEl, vEl]) el.querySelectorAll('canvas').forEach(c => c.setAttribute('aria-hidden', 'true'));
  updatePlots();
}

function resetPlots() {
  if (!profilePlot) makePlots();
  else updatePlots();
}

function updatePlots() {
  if (!state || !profilePlot) return;
  const T = state.sizes.length;
  const xs = Array.from({ length: T }, (_, t) => t);
  const hasMean = state.measurements > 0;
  const mean = hasMean ? state.mean : xs.map(() => null);
  const lo = hasMean && state.measurements > 1 ? state.mean.map((m, t) => m - state.std[t]) : xs.map(() => null);
  const hi = hasMean && state.measurements > 1 ? state.mean.map((m, t) => m + state.std[t]) : xs.map(() => null);
  profilePlot.setData([xs, state.aligned, mean, lo, hi]);
  volumePlot.setData([history.x, history.y, history.x.map(() => state.targetVolume)]);
}

function resizePlots() {
  if (profilePlot) profilePlot.setSize({ width: plotWidth($('sim-profile')), height: 210 });
  if (volumePlot) volumePlot.setSize({ width: plotWidth($('sim-volplot')), height: 150 });
}

//// wiring

$('sim-run').addEventListener('click', () => setRunning(!running));
$('sim-step').addEventListener('click', () => {
  if (running) setRunning(false);
  worker.postMessage({ type: 'stepAccepted' });
});
$('sim-new').addEventListener('click', init);
$('sim-random-seed').addEventListener('click', () => {
  $('sim-seed').value = Math.floor(Math.random() * 1e6);
  init();
});
$('sim-reset-avg').addEventListener('click', () => worker.postMessage({ type: 'resetAverage' }));
$('sim-speed').addEventListener('input', () => {
  showSpeed();
  if (running) worker.postMessage({ type: 'run', rate: speedRate() });
});
$('sim-lambda').addEventListener('input', () => {
  const lambda = Number($('sim-lambda').value);
  $('sim-lambda-out').textContent = lambda.toFixed(3);
  worker.postMessage({ type: 'setLambda', lambda });
});
$('sim-lambda-ln2').addEventListener('click', () => {
  $('sim-lambda').value = Math.LN2;
  $('sim-lambda').dispatchEvent(new Event('input'));
});
$('sim-cylinder').addEventListener('change', draw);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) { resumeOnShow = true; setRunning(false); }
  else if (!document.hidden && resumeOnShow) { resumeOnShow = false; setRunning(true); }
});
const retheme = () => { colors = themeColors(); makePlots(); draw(); };
document.addEventListener('themechange', retheme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
new ResizeObserver(() => { resizeCanvas(); resizePlots(); }).observe(canvas);

$('sim-seed').value = Math.floor(Math.random() * 1e6);
$('sim-lambda').value = Math.LN2;
$('sim-lambda-out').textContent = Math.LN2.toFixed(3);
showSpeed();
makePlots();
init();
if (!reduced) setRunning(true);
