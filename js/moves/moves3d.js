// 3D move scenes for learn/moves.html, drawn with three.js. Each move is shown as its "before" set
// of tetrahedra exploding apart, swapping for the "after" set, which then closes up again; the
// colours give the tetrahedron types (3,1), (2,2) and (1,3). Inverse moves play the scene backwards.

import * as THREE from 'three';
import { OrbitControls } from '../../vendor/three-0.169.0/addons/controls/OrbitControls.js';

const H = 1.1;  // distance between neighbouring slices

const SCENES = {
  insert: {  // (2,6) and its inverse (6,2)
    v: { a: [-1, 0, -0.6], b: [1, 0, -0.6], c: [0, 0, 1], d: [0, H, 0], e: [0, -H, 0], m: [0, 0, -0.067] },
    before: ['abcd', 'abce'],
    after: ['abmd', 'bcmd', 'camd', 'abme', 'bcme', 'came'],
    slices: [-H, 0, H],
  },
  flip: {  // (4,4): flip the spatial edge ab to cd inside slice t
    v: { a: [-1, 0, 0], b: [1, 0, 0], c: [0, 0, 1], d: [0, 0, -1], u: [0, H, 0], w: [0, -H, 0] },
    before: ['abcu', 'abdu', 'abcw', 'abdw'],
    after: ['cdau', 'cdbu', 'cdaw', 'cdbw'],
    slices: [-H, 0, H],
  },
  shift: {  // (2,3) and its inverse (3,2): two tetrahedra sharing triangle bcd become three sharing link ae
    v: { a: [-0.8, 0, 0], b: [0.9, 0, -0.7], c: [0.9, 0, 0.7], d: [0.3, H, 0], e: [1.6, H, 0] },
    before: ['abcd', 'bcde'],
    after: ['aebc', 'aecd', 'aedb'],
    slices: [0, H],
  },
};

const MOVES = {
  '2,6': { scene: 'insert', reverse: false, text: 'A vertex is inserted in a spatial triangle. The (3,1) and (1,3) tetrahedra on either side of it become three of each.' },
  '6,2': { scene: 'insert', reverse: true, text: 'A vertex shared by exactly six tetrahedra is removed. The six become two.' },
  '4,4': { scene: 'flip', reverse: false, text: 'The spatial edge between two triangles in a slice is flipped to the other diagonal. Four tetrahedra become four others.' },
  '2,3': { scene: 'shift', reverse: false, text: 'A (3,1) and a (2,2) tetrahedron sharing a timelike triangle become three tetrahedra sharing a timelike edge: one (3,1) and two (2,2).' },
  '3,2': { scene: 'shift', reverse: true, text: 'The inverse: three tetrahedra around a timelike edge become two sharing a timelike triangle.' },
};

function tetType(pts) {
  const lo = Math.min(...pts.map(p => p[1]));
  const n = pts.filter(p => Math.abs(p[1] - lo) < 1e-9).length;
  return n === 3 ? 'up' : n === 1 ? 'down' : 'mid';
}

function cssColors() {
  const cs = getComputedStyle(document.documentElement);
  const c = name => new THREE.Color(cs.getPropertyValue(name).trim());
  return { up: c('--up'), down: c('--down'), mid: c('--mid'), line: c('--text') };
}

export function mountMoves3d(container) {
  container.innerHTML = `
    <div class="controls" role="group" aria-label="3D move">
      ${Object.keys(MOVES).map(k => `<button type="button" class="secondary" data-move="${k}">(${k})</button>`).join('')}
      <button type="button" data-play>Play</button>
      <label>Step <input type="range" min="0" max="1000" value="0" data-scrub aria-label="Animation progress"></label>
    </div>
    <div class="move-3d" role="img" aria-label="Rotatable 3D view of the tetrahedra involved in the selected move. Drag to rotate."></div>
    <div class="legend">
      <span style="--swatch: var(--up)">(3,1)</span><span style="--swatch: var(--mid)">(2,2)</span><span style="--swatch: var(--down)">(1,3)</span>
      <span style="--swatch: transparent">Drag to rotate, scroll or pinch to zoom.</span>
    </div>
    <p class="move-caption" aria-live="polite"></p>`;
  const stage = container.querySelector('.move-3d');
  const caption = container.querySelector('.move-caption');
  const scrub = container.querySelector('[data-scrub]');
  const playBtn = container.querySelector('[data-play]');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(3.2, 2.2, 4.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !reduced;
  controls.autoRotateSpeed = 0.8;
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  let colors = cssColors();
  const group = new THREE.Group();
  scene.add(group);

  let current = '2,6';
  let shownScene = null;
  let progress = 0;
  let playing = false;
  let playStart = 0;
  let visible = true;

  function build() {
    const { scene: key, reverse } = MOVES[current];
    const sc = SCENES[key];
    const s = reverse ? 1 - progress : progress;
    const set = s < 0.5 ? sc.before : sc.after;
    const explode = 0.55 * Math.sin(Math.PI * s);  // apart in the middle of the move, closed at the ends
    // the scene is rebuilt every animation frame, so free the previous frame's GPU buffers
    group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    group.clear();

    const all = Object.values(sc.v);
    const centre = all.reduce((acc, p) => acc.map((x, i) => x + p[i] / all.length), [0, 0, 0]);
    if (key !== shownScene) {  // aim the camera at a new scene; keep the reader's rotation otherwise
      shownScene = key;
      controls.target.set(...centre);
      camera.position.set(centre[0] + 2.6, centre[1] + 1.9, centre[2] + 3.4);
    }
    for (const y of sc.slices) {
      const plane = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 3.4),
        new THREE.MeshBasicMaterial({ color: colors.line, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(centre[0], y, centre[2]);
      group.add(plane);
    }

    for (const tet of set) {
      const pts = [...tet].map(n => sc.v[n]);
      const c = pts.reduce((acc, p) => acc.map((x, i) => x + p[i] / 4), [0, 0, 0]);
      // explode horizontally only, so the time slices stay recognisable
      const off = new THREE.Vector3(c[0] - centre[0], 0, c[2] - centre[2]).multiplyScalar(explode * 1.6);
      const verts = pts.map(p => new THREE.Vector3(...p).add(off));
      const geo = new THREE.BufferGeometry().setFromPoints([
        verts[0], verts[1], verts[2], verts[0], verts[1], verts[3],
        verts[0], verts[2], verts[3], verts[1], verts[2], verts[3]]);
      geo.computeVertexNormals();
      const color = colors[tetType(pts)];
      group.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        color, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false })));
      const edges = new THREE.BufferGeometry().setFromPoints([0, 1, 0, 2, 0, 3, 1, 2, 1, 3, 2, 3].map(i => verts[i]));
      group.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color })));
      const dots = new THREE.BufferGeometry().setFromPoints(verts);
      group.add(new THREE.Points(dots, new THREE.PointsMaterial({ color: colors.line, size: 0.07 })));
    }

    caption.textContent = `(${current}): ${MOVES[current].text} ${set.length} tetrahedra shown.`;
    scrub.value = Math.round(progress * 1000);
    container.querySelectorAll('[data-move]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.move === current)));
  }

  function resize() {
    const { width, height } = stage.getBoundingClientRect();
    if (!width) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  function setPlaying(on) {
    playing = on;
    playBtn.textContent = on ? 'Pause' : 'Play';
    if (on) {
      if (progress >= 1) progress = 0;
      playStart = performance.now() - progress * 2400;
    }
  }

  function loop(now) {
    if (visible) {
      if (playing) {
        progress = Math.min(1, (now - playStart) / 2400);
        build();
        if (progress >= 1) setPlaying(false);
      }
      controls.update();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  }

  container.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', () => {
    current = b.dataset.move;
    progress = 0;
    build();
    setPlaying(!reduced);
  }));
  playBtn.addEventListener('click', () => setPlaying(!playing));
  scrub.addEventListener('input', () => { setPlaying(false); progress = scrub.value / 1000; build(); });
  const recolor = () => { colors = cssColors(); build(); };
  document.addEventListener('themechange', recolor);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', recolor);
  new ResizeObserver(resize).observe(stage);
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(stage);

  resize();
  build();
  requestAnimationFrame(loop);
}
