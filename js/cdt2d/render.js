// Drawing a 2D causal triangulation as a periodic strip: time upward, space horizontal and periodic.
//
// geometry(universe) reduces the triangulation to what the picture needs, as plain arrays that can
// be posted from a Web Worker: the slice sizes and, per strip, the left-to-right sequence of
// triangle types plus the position of the first triangle's apex in the next slice. drawStrip()
// lays each slice out evenly and shifts it so that every strip stays as upright as possible.

import { UP } from './universe.js';

export function geometry(u) {
  const T = u.nSlices;
  const sizes = Array.from(u.sliceSizes);
  const strips = [];
  for (let t = 0; t < T; t++) {
    const next = u.sliceVertices((t + 1) % T);
    const tris = u.stripTriangles(t);  // starts with the UP triangle at the anchor of slice t
    const types = new Uint8Array(tris.length);
    for (let k = 0; k < tris.length; k++) types[k] = u.tType[tris[k]];
    strips.push({ types, apex: next.indexOf(u.tVc[tris[0]]) });
  }
  return { sizes, strips };
}

// Phase of each slice (in units of its own vertex spacing). Slice t+1 is shifted so that the mean
// horizontal offset between the upper and lower vertices of the triangles in strip t is zero,
// which keeps the strip as upright as an even spacing allows. Row T is slice 0 again, drawn with
// its own phase.
function phases(geom) {
  const { sizes, strips } = geom;
  const T = sizes.length;
  const phi = new Float64Array(T + 1);
  for (let t = 0; t < T; t++) {
    const n = sizes[t], m = sizes[(t + 1) % T];
    const { types, apex } = strips[t];
    let a = 0, b = apex, sum = 0;
    for (let k = 0; k < types.length; k++) {
      // upper position minus lower position, as fractions of the width, with phi[t + 1] = 0
      if (types[k] === UP) { sum += b / m - (a + 0.5 + phi[t]) / n; a++; }
      else { sum += (b + 0.5) / m - (a + phi[t]) / n; b++; }
    }
    // no reduction modulo m here: shifting row t+1 by a whole period would shift only the upper
    // corners of strip t, stretching its triangles across the full width
    phi[t + 1] = -(sum / types.length) * m;
  }
  return phi;
}

// colors: { up, down, line, vertex }; opts.cylinder scales each row by its slice size
export function drawStrip(ctx, geom, { width, height, colors, pad = 6, cylinder = false, vertices = true }) {
  const { sizes, strips } = geom;
  const T = sizes.length;
  const phi = phases(geom);
  const maxN = Math.max(...sizes);
  const rowY = t => height - pad - t * (height - 2 * pad) / T;
  // Each vertex has an angular coordinate theta (a fraction of its slice). Row t maps theta in
  // [0, 1) onto the full width (strip), or onto a width proportional to the slice size, centred
  // (cylinder: the circumference of space drawn to scale, like an unrolled surface of revolution).
  const rowW = t => cylinder ? (width - 2 * pad) * sizes[t % T] / maxN : width;
  const rowX0 = t => cylinder ? (width - rowW(t)) / 2 : 0;
  const theta = (t, idx) => (idx + phi[t]) / sizes[t % T];
  const X = (t, th) => rowX0(t) + th * rowW(t);

  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1;

  for (let t = 0; t < T; t++) {
    const yLo = rowY(t), yHi = rowY(t + 1);
    const { types, apex } = strips[t];
    const up = new Path2D(), down = new Path2D();
    // a triangle with corners (row, theta), shifted so its leftmost corner lies in [0, 1), and
    // added again one period to the left so that the part past the right edge shows on the left
    const add = (path, r1, h1, r2, h2, r3, h3) => {
      const k = Math.floor(Math.min(h1, h2, h3));
      for (const s of [k, k + 1]) {
        path.moveTo(X(r1, h1 - s), r1 === t ? yLo : yHi);
        path.lineTo(X(r2, h2 - s), r2 === t ? yLo : yHi);
        path.lineTo(X(r3, h3 - s), r3 === t ? yLo : yHi);
        path.closePath();
      }
    };
    let a = 0, b = apex;
    for (let k = 0; k < types.length; k++) {
      if (types[k] === UP) {
        add(up, t, theta(t, a), t, theta(t, a + 1), t + 1, theta(t + 1, b));
        a++;
      } else {
        add(down, t + 1, theta(t + 1, b), t + 1, theta(t + 1, b + 1), t, theta(t, a));
        b++;
      }
    }
    ctx.save();
    const clip = new Path2D();
    clip.moveTo(rowX0(t), yLo);
    clip.lineTo(rowX0(t) + rowW(t), yLo);
    clip.lineTo(rowX0(t + 1) + rowW(t + 1), yHi);
    clip.lineTo(rowX0(t + 1), yHi);
    clip.closePath();
    ctx.clip(clip);
    fillStroke(ctx, up, colors.up);
    fillStroke(ctx, down, colors.down);
    ctx.restore();
  }

  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.4;
  for (let t = 0; t <= T; t++) {
    const y = rowY(t);
    ctx.beginPath();
    ctx.moveTo(rowX0(t), y);
    ctx.lineTo(rowX0(t) + rowW(t), y);
    ctx.stroke();
  }
  if (vertices && maxN * 4 < width) {
    ctx.fillStyle = colors.vertex;
    for (let t = 0; t <= T; t++) {
      const y = rowY(t), n = sizes[t % T];
      for (let k = 0; k < n; k++) {
        const th = theta(t, k);
        ctx.beginPath();
        ctx.arc(X(t, th - Math.floor(th)), y, 1.8, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
}

function addTri(path, x1, y1, x2, y2, x3, y3) {
  path.moveTo(x1, y1);
  path.lineTo(x2, y2);
  path.lineTo(x3, y3);
  path.closePath();
}

function fillStroke(ctx, path, color) {
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = color;
  ctx.fill(path);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = color;
  ctx.stroke(path);
}

// The simplex-type colours of the current theme, from the CSS tokens.
export function themeColors(el = document.documentElement) {
  const cs = getComputedStyle(el);
  const v = name => cs.getPropertyValue(name).trim();
  return { up: v('--up'), down: v('--down'), line: v('--text'), vertex: v('--text') };
}
