// 2D move animations for learn/moves.html: the (2,4) add, (4,2) delete and (2,2) flip moves on a
// small patch of a causal triangulation, drawn as SVG and morphed by a parameter s in [0, 1].
// Delete is the add scene played backwards.

const NS = 'http://www.w3.org/2000/svg';
const lerp = (p, q, s) => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];

// Rows: t-1 at y=190, t at y=110, t+1 at y=30.
const ADD = {
  title: 'Add (2,4) / delete (4,2)',
  counts: [{ N0: 10, N2: 10 }, { N0: 11, N2: 12 }],
  vertices: s => {
    const A = [140, 110], B = [260, 110];
    return {
      L: [40, 110], A, B, R: [360, 110],
      T0: [70, 30], C: [200, 30], T2: [330, 30],
      S0: [70, 190], D: [200, 190], S2: [330, 190],
      M: lerp(A, [200, 110], s),  // the inserted vertex slides out of A to the middle of AB
    };
  },
  // [vertex names, type, part of the move?]
  triangles: s => [
    [['L', 'A', 'T0'], 'up'], [['T0', 'C', 'A'], 'down'], [['C', 'T2', 'B'], 'down'], [['B', 'R', 'T2'], 'up'],
    [['L', 'A', 'S0'], 'down'], [['S0', 'D', 'A'], 'up'], [['D', 'S2', 'B'], 'up'], [['B', 'R', 'S2'], 'down'],
    ...(s === 0
      ? [[['A', 'B', 'C'], 'up', true], [['A', 'B', 'D'], 'down', true]]
      : [[['A', 'M', 'C'], 'up', true], [['M', 'B', 'C'], 'up', true],
         [['A', 'M', 'D'], 'down', true], [['M', 'B', 'D'], 'down', true]]),
  ],
  marked: s => (s > 0 ? ['M'] : []),
  rows: [30, 110, 190],
};

const FLIP = {
  title: 'Flip (2,2)',
  counts: [{ N0: 8, N2: 6 }, { N0: 8, N2: 6 }],
  vertices: s => {
    const L0 = [130, 170], L1 = [250, 170], U0 = [190, 50], U1 = [310, 50];
    return {
      P0: [30, 170], L0, L1, P3: [370, 170], Q0: [70, 50], U0, U1, Q3: [390, 50],
      P: lerp(L1, L0, s),  // the lower end of the shared timelike link
      Q: lerp(U0, U1, s),  // its upper end
    };
  },
  triangles: s => [
    [['P0', 'L0', 'Q0'], 'up'], [['Q0', 'U0', 'L0'], 'down'],
    [['L1', 'P3', 'U1'], 'up'], [['U1', 'Q3', 'P3'], 'down'],
    // left and right of the moving link: an up and a down triangle that trade types halfway
    [['L0', 'P', 'Q', 'U0'], s < 0.5 ? 'up' : 'down', true],
    [['P', 'L1', 'U1', 'Q'], s < 0.5 ? 'down' : 'up', true],
  ],
  marked: () => [],
  hidden: ['P', 'Q'],  // ends of the moving link, not vertices
  rows: [50, 170],
};

const SCENES = { add: { scene: ADD, from: 0, to: 1 }, delete: { scene: ADD, from: 1, to: 0 }, flip: { scene: FLIP, from: 0, to: 1 } };

function el(name, attrs = {}) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

export function mountMoves2d(container) {
  container.innerHTML = `
    <div class="controls" role="group" aria-label="2D move">
      <button type="button" data-move="add" class="secondary">Add (2,4)</button>
      <button type="button" data-move="delete" class="secondary">Delete (4,2)</button>
      <button type="button" data-move="flip" class="secondary">Flip (2,2)</button>
      <button type="button" data-play>Play</button>
      <label>Step <input type="range" min="0" max="1000" value="0" data-scrub aria-label="Animation progress"></label>
    </div>
    <div class="move-stage"></div>
    <p class="move-caption" aria-live="polite"></p>`;
  const stage = container.querySelector('.move-stage');
  const caption = container.querySelector('.move-caption');
  const scrub = container.querySelector('[data-scrub]');
  const playBtn = container.querySelector('[data-play]');
  const svg = el('svg', { viewBox: '0 0 400 220', class: 'move-svg', role: 'img' });
  stage.appendChild(svg);

  let current = 'add';
  let progress = 0;  // 0..1 along the selected move
  let anim = null;

  function render() {
    const { scene, from, to } = SCENES[current];
    const s = from + (to - from) * progress;
    const V = scene.vertices(s);
    svg.replaceChildren();
    svg.setAttribute('aria-label', `${scene.title}, ${Math.round(progress * 100)}% through the move`);
    for (const y of scene.rows) svg.appendChild(el('line', { x1: 0, x2: 400, y1: y, y2: y, class: 'm-slice' }));
    for (const [names, type, active] of scene.triangles(s)) {
      const pts = names.map(n => V[n].join(',')).join(' ');
      svg.appendChild(el('polygon', { points: pts, class: `m-tri m-${type}${active ? ' m-active' : ''}` }));
    }
    const marked = new Set(scene.marked(s));
    const seen = new Set(scene.hidden || []);
    for (const [names] of scene.triangles(s)) {
      for (const n of names) {
        if (seen.has(n)) continue;
        seen.add(n);
        svg.appendChild(el('circle', { cx: V[n][0], cy: V[n][1], r: marked.has(n) ? 5 : 3.2, class: marked.has(n) ? 'm-vtx m-new' : 'm-vtx' }));
      }
    }
    const before = scene.counts[from], after = scene.counts[to];
    const delta = (k) => { const d = after[k] - before[k]; return d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0'; };
    caption.textContent = {
      add: 'Add: a new vertex splits a spatial link, and the two triangles sharing it become four.',
      delete: 'Delete: a vertex with exactly four triangles around it is removed, and the four become two.',
      flip: 'Flip: an up and a down triangle in the same strip swap their shared diagonal. Nothing is created or removed.',
    }[current] + ` In this patch: vertices ${delta('N0')}, triangles ${delta('N2')}.`;
    scrub.value = Math.round(progress * 1000);
    container.querySelectorAll('[data-move]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.move === current)));
  }

  function stop() {
    if (anim) cancelAnimationFrame(anim);
    anim = null;
    playBtn.textContent = 'Play';
  }

  function play() {
    if (progress >= 1) progress = 0;
    const start = performance.now() - progress * 1600;
    playBtn.textContent = 'Pause';
    const step = (now) => {
      progress = Math.min(1, (now - start) / 1600);
      render();
      if (progress < 1) anim = requestAnimationFrame(step);
      else stop();
    };
    anim = requestAnimationFrame(step);
  }

  container.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => {
    stop();
    current = b.dataset.move;
    progress = 0;
    render();
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) play();
  }));
  playBtn.addEventListener('click', () => (anim ? stop() : play()));
  scrub.addEventListener('input', () => { stop(); progress = scrub.value / 1000; render(); });
  render();
}
