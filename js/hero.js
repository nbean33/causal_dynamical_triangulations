// Landing-page hero: a small live 2D CDT simulation drawn as a periodic strip.
// Runs on the main thread (a few thousand proposals per frame is well under a millisecond), only
// while the canvas is on screen, and not at all under prefers-reduced-motion unless asked.

import { Simulation } from './cdt2d/moves.js';
import { geometry, drawStrip, themeColors } from './cdt2d/render.js';

const SLICES = 12;
const VOLUME = 480;            // target number of triangles
const PROPOSALS_PER_FRAME = 1500;

const canvas = document.getElementById('hero-canvas');
const stat = document.getElementById('hero-stat');
const toggle = document.getElementById('hero-toggle');

if (canvas) {
  const sim = new Simulation({ slices: SLICES, targetVolume: VOLUME, seed: (Math.random() * 2 ** 31) | 0 });
  sim.grow();
  sim.steps(50 * VOLUME);  // start from a fluctuating state, not the regular initial strip

  const ctx = canvas.getContext('2d');
  let colors = themeColors();
  let size = { width: 0, height: 0 };
  let onScreen = true;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let running = !reduced;
  let frame = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    size = { width: rect.width, height: rect.height };
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    if (!size.width) return;
    drawStrip(ctx, geometry(sim.universe), { ...size, colors });
    stat.textContent = `${sim.N2} triangles · ${sim.N0} vertices · ${SLICES} time slices`;
  }

  function tick() {
    if (running && onScreen) {
      sim.steps(PROPOSALS_PER_FRAME);
      // redraw every other frame: the picture changes slowly and this halves the cost
      if (frame++ % 2 === 0) draw();
    }
    requestAnimationFrame(tick);
  }

  function setRunning(on) {
    running = on;
    toggle.textContent = on ? 'Pause' : 'Play';
    toggle.setAttribute('aria-pressed', String(!on));
  }

  toggle.addEventListener('click', () => setRunning(!running));
  setRunning(running);
  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(canvas);
  document.addEventListener('themechange', () => { colors = themeColors(); draw(); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colors = themeColors(); draw(); });
  requestAnimationFrame(tick);
}
