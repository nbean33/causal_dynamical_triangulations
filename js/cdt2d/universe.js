// A 2D causal triangulation of the torus: T periodic time slices, each a closed ring of vertices,
// joined by strips of up and down triangles. Port of cdt/2d/universe.cpp, triangle.hpp, vertex.hpp
// and cdt/common/pool.hpp, bag.hpp.
// Derived from 2d-cdt (MIT, (c) 2020 Joren Brunekreef and Andrzej Görlich) via the corrected
// CDT_4d-master port; see LICENSE in this folder.
//
// Conventions (as in the C++):
// - A triangle has a spacelike base (vl, vr) at its `time` and an apex vc in the next slice (UP)
//   or the previous one (DOWN). Its left and right neighbours share its timelike edges {vl, vc}
//   and {vr, vc}; its centre neighbour shares the base and has the other orientation.
// - A vertex v points to the two UP triangles whose base contains it: tl (v is its right base
//   vertex) and tr (v is its left base vertex). The right neighbour of v in its slice is tr.vr.
// - Vertices and triangles are integer labels into struct-of-arrays pools; labels of destroyed
//   objects are reused last-in first-out, exactly like Pool<T>.

export const UP = 0;
export const DOWN = 1;

function grown(a, n, fill) {
  const b = new Int32Array(n);
  b.set(a);
  if (fill !== 0) b.fill(fill, a.length);
  return b;
}

// Pool<T>: labels with a free list threaded through `next` (next[i] === i for a live cell,
// ~nextFree for a free one). The arrays grow on demand instead of having a fixed pool_size.
class Pool {
  constructor(capacity, onGrow) {
    this.next = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this.next[i] = ~(i + 1);
    this.first = 0;
    this.total = 0;
    this.onGrow = onGrow;
  }

  get capacity() {
    return this.next.length;
  }

  create() {
    if (this.first >= this.next.length) this.grow();
    const i = this.first;
    this.first = ~this.next[i];
    this.next[i] = i;
    this.total++;
    return i;
  }

  destroy(i) {
    this.next[i] = ~this.first;
    this.first = i;
    this.total--;
  }

  alive(i) {
    return i >= 0 && i < this.next.length && this.next[i] === i;
  }

  grow() {
    const n = this.next.length;
    this.next = grown(this.next, 2 * n, 0);
    for (let i = n; i < 2 * n; i++) this.next[i] = ~(i + 1);
    this.onGrow(2 * n);
  }

  snapshot() {
    return { next: this.next.slice(), first: this.first, total: this.total };
  }

  restore(s) {
    this.next = s.next.slice();
    this.first = s.first;
    this.total = s.total;
  }
}

// Bag: a set of labels with O(1) add, remove, contains and uniform pick (cdt/common/bag.hpp).
export class Bag {
  constructor(rng, capacity = 64) {
    this.rng = rng;
    this.indices = new Int32Array(capacity).fill(-1);  // by label: position in elements, or -1
    this.elements = new Int32Array(capacity);  // contiguous labels
    this.size = 0;
  }

  contains(x) {
    return x < this.indices.length && this.indices[x] !== -1;
  }

  add(x) {
    if (x >= this.indices.length) this.indices = grown(this.indices, Math.max(2 * this.indices.length, x + 1), -1);
    if (this.indices[x] !== -1) throw new Error(`Bag.add: ${x} is already in the bag`);
    if (this.size === this.elements.length) this.elements = grown(this.elements, 2 * this.size, 0);
    this.indices[x] = this.size;
    this.elements[this.size++] = x;
  }

  remove(x) {
    if (!this.contains(x)) throw new Error(`Bag.remove: ${x} is not in the bag`);
    const index = this.indices[x];
    const last = this.elements[--this.size];
    this.elements[index] = last;
    this.indices[last] = index;
    this.indices[x] = -1;
  }

  pick() {
    return this.elements[this.rng.int(this.size)];
  }

  at(i) {
    return this.elements[i];
  }

  toArray() {
    return Array.from(this.elements.subarray(0, this.size));
  }

  // exact contents, order included (Bag::snapshot / restore)
  snapshot() {
    return this.elements.slice(0, this.size);
  }

  restore(s) {
    for (let i = 0; i < this.size; i++) this.indices[this.elements[i]] = -1;
    this.size = 0;
    for (const x of s) this.add(x);
  }
}

export class Universe {
  // nSlices: number of time slices T (>= 3, needed by the periodic orientation rule in updateType)
  // width: vertices per slice in the initial strip (3 in 2d-cdt)
  constructor(nSlices, rng, { width = 3 } = {}) {
    if (!Number.isInteger(nSlices) || nSlices < 3) throw new RangeError('Universe: need an integer number of slices >= 3');
    if (!Number.isInteger(width) || width < 3) throw new RangeError('Universe: need an initial width >= 3');
    this.nSlices = nSlices;
    this.rng = rng;

    const vCap = 2 * width * nSlices;
    this.vertices = new Pool(vCap, (n) => this.growVertices(n));
    this.vTime = new Int32Array(vCap);
    this.vTl = new Int32Array(vCap);
    this.vTr = new Int32Array(vCap);

    const tCap = 2 * vCap;
    this.triangles = new Pool(tCap, (n) => this.growTriangles(n));
    this.tTime = new Int32Array(tCap);
    this.tType = new Int32Array(tCap);
    this.tTl = new Int32Array(tCap);
    this.tTr = new Int32Array(tCap);
    this.tTc = new Int32Array(tCap);
    this.tVl = new Int32Array(tCap);
    this.tVr = new Int32Array(tCap);
    this.tVc = new Int32Array(tCap);

    this.sliceSizes = new Int32Array(nSlices);
    this.sliceAnchor = new Int32Array(nSlices);  // one vertex of each slice: where the ring walk starts

    this.trianglesAll = new Bag(rng, tCap);  // all triangles: candidates for the add move
    this.verticesFour = new Bag(rng, vCap);  // vertices of coordination number 4: candidates for delete
    this.trianglesFlip = new Bag(rng, tCap);  // triangles whose right neighbour has the other type: flip

    this.initialize(width);
  }

  get n0() {
    return this.vertices.total;
  }

  get n2() {
    return this.triangles.total;
  }

  growVertices(n) {
    this.vTime = grown(this.vTime, n, 0);
    this.vTl = grown(this.vTl, n, 0);
    this.vTr = grown(this.vTr, n, 0);
  }

  growTriangles(n) {
    for (const f of ['tTime', 'tType', 'tTl', 'tTr', 'tTc', 'tVl', 'tVr', 'tVc']) this[f] = grown(this[f], n, 0);
  }

  //// Triangle setters (triangle.hpp): neighbour links are set in both directions

  setTriangleRight(t, x) {
    this.tTr[t] = x;
    this.tTl[x] = t;
  }

  setTriangleCenter(t, x) {
    this.tTc[t] = x;
    this.tTc[x] = t;
  }

  setTriangles(t, l, r, c) {
    this.tTl[t] = l;
    this.tTr[t] = r;
    this.tTc[t] = c;
    this.tTr[l] = t;
    this.tTl[r] = t;
    this.tTc[c] = t;
  }

  setVertexRight(t, v) {
    this.tVr[t] = v;
    if (this.tType[t] === UP) this.vTl[v] = t;
  }

  setVertices(t, vl, vr, vc) {
    this.tVl[t] = vl;
    this.tVr[t] = vr;
    this.tVc[t] = vc;
    this.tTime[t] = this.vTime[vl];
    this.tType[t] = this.orientation(vl, vc);
    if (this.tType[t] === UP) {
      this.vTr[vl] = t;
      this.vTl[vr] = t;
    }
  }

  // Triangle::updateType: UP if the apex lies in the next slice, with the periodic wrap T-1 -> 0
  orientation(vl, vc) {
    const tl = this.vTime[vl];
    const tc = this.vTime[vc];
    let type = tl < tc ? UP : DOWN;
    if (tc === 0 && tl > 1) type = UP;
    if (tl === 0 && tc > 1) type = DOWN;
    return type;
  }

  //// Initial geometry (Universe::initialize): T slices of `width` vertices, 2 * width * T triangles

  initialize(w) {
    const t = this.nSlices;
    const vs = new Int32Array(w * t);
    for (let i = 0; i < w * t; i++) {
      const v = this.vertices.create();
      this.vTime[v] = Math.floor(i / w);
      vs[i] = v;
    }
    for (let i = 0; i < t; i++) {
      this.sliceSizes[i] = w;
      this.sliceAnchor[i] = vs[i * w];
    }

    const ts = new Int32Array(2 * w * t);
    for (let i = 0; i < t; i++) {
      for (let j = 0; j < w; j++) {
        const tl = this.triangles.create();
        this.setVertices(tl, vs[i * w + j], vs[i * w + (j + 1) % w], vs[((i + 1) % t) * w + j]);
        ts[2 * (i * w + j)] = tl;

        const tr = this.triangles.create();
        this.setVertices(tr, vs[((i + 1) % t) * w + j], vs[((i + 1) % t) * w + (j + 1) % w], vs[i * w + (j + 1) % w]);
        ts[2 * (i * w + j) + 1] = tr;

        this.trianglesAll.add(tl);
        this.trianglesAll.add(tr);
        this.trianglesFlip.add(tl);
        this.trianglesFlip.add(tr);
      }
    }

    for (let i = 0; i < t; i++) {
      for (let j = 0; j < w; j++) {
        const row = 2 * i * w;
        const column = 2 * j;
        this.setTriangles(ts[row + column],
          ts[row + (column - 1 + 2 * w) % (2 * w)],
          ts[row + column + 1],
          ts[(row + column - 2 * w + 1 + 2 * t * w) % (2 * t * w)]);
        this.setTriangles(ts[row + column + 1],
          ts[row + column],
          ts[row + (column + 2) % (2 * w)],
          ts[(row + column + 2 * w) % (2 * t * w)]);
      }
    }
  }

  //// Moves

  // (2,4) move: a new vertex splits the base of t and of its centre neighbour tc
  insertVertex(t) {
    const tc = this.tTc[t];
    const vr = this.tVr[t];
    const time = this.tTime[t];

    const v = this.vertices.create();
    this.vTime[v] = time;
    this.verticesFour.add(v);
    this.sliceSizes[time] += 1;

    this.setVertexRight(t, v);
    this.setVertexRight(tc, v);

    const t1 = this.triangles.create();  // right neighbour of t
    const t2 = this.triangles.create();  // right neighbour of tc
    this.trianglesAll.add(t1);
    this.trianglesAll.add(t2);

    this.setVertices(t1, v, vr, this.tVc[t]);
    this.setVertices(t2, v, vr, this.tVc[tc]);

    this.setTriangles(t1, t, this.tTr[t], t2);
    this.setTriangles(t2, tc, this.tTr[tc], t1);

    if (this.tType[t1] !== this.tType[this.tTr[t1]]) {
      this.trianglesFlip.remove(t);
      this.trianglesFlip.add(t1);
    }
    if (this.tType[t2] !== this.tType[this.tTr[t2]]) {
      this.trianglesFlip.remove(tc);
      this.trianglesFlip.add(t2);
    }
  }

  // (4,2) move: removes a vertex of coordination 4 together with its two right triangles
  removeVertex(v) {
    const tl = this.vTl[v];
    const tr = this.vTr[v];
    const tlc = this.tTc[tl];
    const trc = this.tTc[tr];
    const trn = this.tTr[tr];
    const trcn = this.tTr[trc];

    this.setTriangleRight(tl, trn);
    this.setTriangleRight(tlc, trcn);

    const vrr = this.tVr[tr];
    this.setVertexRight(tl, vrr);
    this.setVertexRight(tlc, vrr);
    this.vTl[vrr] = tl;

    const time = this.vTime[v];
    this.sliceSizes[time] -= 1;
    if (this.sliceAnchor[time] === v) this.sliceAnchor[time] = this.tVl[tl];

    this.trianglesAll.remove(tr);
    this.trianglesAll.remove(trc);
    if (this.trianglesFlip.contains(tr)) {
      this.trianglesFlip.remove(tr);
      this.trianglesFlip.add(tl);
    }
    if (this.trianglesFlip.contains(trc)) {
      this.trianglesFlip.remove(trc);
      this.trianglesFlip.add(tlc);
    }

    this.triangles.destroy(tr);
    this.triangles.destroy(trc);

    this.verticesFour.remove(v);
    this.vertices.destroy(v);
  }

  // (2,2) move: flips the timelike edge between t and its right neighbour (of the other type)
  flipLink(t) {
    const tr = this.tTr[t];
    const tc = this.tTc[t];
    const trc = this.tTc[tr];

    if (this.tType[t] === UP) {
      this.vTr[this.tVl[t]] = tr;
      this.vTl[this.tVr[t]] = tr;
    } else {
      this.vTr[this.tVl[tr]] = t;
      this.vTl[this.tVr[tr]] = t;
    }

    this.setTriangleCenter(t, trc);
    this.setTriangleCenter(tr, tc);

    const vl = this.tVl[t];
    const vr = this.tVr[t];
    const vc = this.tVc[t];
    const vrr = this.tVr[tr];

    this.setVertices(t, vc, vrr, vl);
    this.setVertices(tr, vl, vr, vrr);

    const four = this.verticesFour;
    if (four.contains(vl)) four.remove(vl);
    if (this.isFourVertex(vr)) four.add(vr);
    if (this.isFourVertex(vc)) four.add(vc);
    if (four.contains(vrr)) four.remove(vrr);

    const flip = this.trianglesFlip;
    const tl = this.tTl[t];
    if (flip.contains(tl) && this.tType[t] === this.tType[tl]) flip.remove(tl);
    if (flip.contains(tr) && this.tType[tr] === this.tType[this.tTr[tr]]) flip.remove(tr);
    if (!flip.contains(tl) && this.tType[t] !== this.tType[tl]) flip.add(tl);
    if (!flip.contains(tr) && this.tType[tr] !== this.tType[this.tTr[tr]]) flip.add(tr);
  }

  isFourVertex(v) {
    const tl = this.vTl[v];
    const tr = this.vTr[v];
    return this.tTr[tl] === tr && this.tTr[this.tTc[tl]] === this.tTc[tr];
  }

  //// Geometry queries (for observables and drawing)

  // neighbours of v in the next slice: 1 + the number of DOWN triangles with apex v
  coordUp(v) {
    let n = 1;
    for (let t = this.tTr[this.vTl[v]]; t !== this.vTr[v]; t = this.tTr[t]) n++;
    return n;
  }

  // neighbours of v in the previous slice: 1 + the number of UP triangles with apex v
  coordDown(v) {
    let n = 1;
    const end = this.tTc[this.vTr[v]];
    for (let t = this.tTr[this.tTc[this.vTl[v]]]; t !== end; t = this.tTr[t]) n++;
    return n;
  }

  // the vertices of slice `time` in spatial order (left to right), starting at its anchor
  sliceVertices(time) {
    const out = new Array(this.sliceSizes[time]);
    let v = this.sliceAnchor[time];
    for (let k = 0; k < out.length; k++) {
      out[k] = v;
      v = this.tVr[this.vTr[v]];
    }
    return out;
  }

  // the triangles between slice `time` and the next one, left to right, starting with the UP
  // triangle at the slice's anchor; sliceSizes[time] + sliceSizes[time + 1] of them
  stripTriangles(time) {
    const out = [];
    const first = this.vTr[this.sliceAnchor[time]];
    let t = first;
    do {
      out.push(t);
      t = this.tTr[t];
    } while (t !== first);
    return out;
  }

  liveVertices() {
    const out = [];
    for (let k = 0; k < this.trianglesAll.size; k++) {
      const t = this.trianglesAll.at(k);
      if (this.tType[t] === UP) out.push(this.tVl[t]);  // every vertex is vl of exactly one UP triangle
    }
    return out;
  }

  //// Exact save / restore of the whole state (the cdt/tests snapshots)

  snapshot() {
    const s = { vertices: this.vertices.snapshot(), triangles: this.triangles.snapshot() };
    for (const f of ['vTime', 'vTl', 'vTr', 'tTime', 'tType', 'tTl', 'tTr', 'tTc', 'tVl', 'tVr', 'tVc', 'sliceSizes', 'sliceAnchor']) {
      s[f] = this[f].slice();
    }
    for (const b of ['trianglesAll', 'verticesFour', 'trianglesFlip']) s[b] = this[b].snapshot();
    return s;
  }

  restore(s) {
    this.vertices.restore(s.vertices);
    this.triangles.restore(s.triangles);
    for (const f of ['vTime', 'vTl', 'vTr', 'tTime', 'tType', 'tTl', 'tTr', 'tTc', 'tVl', 'tVr', 'tVc', 'sliceSizes', 'sliceAnchor']) {
      this[f] = s[f].slice();
    }
    for (const b of ['trianglesAll', 'verticesFour', 'trianglesFlip']) this[b].restore(s[b]);
  }

  //// Consistency check: everything recounted from the triangles alone (cdt/tests/test2d.cpp
  //// problems2d() and Universe::check()). Returns a list of problems, empty if consistent.

  problems(limit = 20) {
    const P = [];
    const bad = (s) => { if (P.length < limit) P.push(s); };
    const T = this.nSlices;
    const tCap = this.triangles.capacity;
    const vCap = this.vertices.capacity;
    const { tTime, tType, tTl, tTr, tTc, tVl, tVr, tVc, vTime, vTl, vTr } = this;

    // internal consistency of the bags
    for (const name of ['trianglesAll', 'verticesFour', 'trianglesFlip']) {
      const b = this[name];
      for (let i = 0; i < b.size; i++) if (b.indices[b.elements[i]] !== i) bad(`${name}: index of element ${i} is wrong`);
      let n = 0;
      for (let x = 0; x < b.indices.length; x++) if (b.indices[x] !== -1) n++;
      if (n !== b.size) bad(`${name}: ${n} labels marked present, size ${b.size}`);
    }

    // trianglesAll = the live triangles
    const inAll = new Uint8Array(tCap);
    for (let i = 0; i < this.trianglesAll.size; i++) {
      const t = this.trianglesAll.at(i);
      if (!this.triangles.alive(t)) bad(`trianglesAll holds dead triangle ${t}`);
      else inAll[t] = 1;
    }
    for (let t = 0; t < tCap; t++) if (this.triangles.alive(t) && !inAll[t]) bad(`live triangle ${t} missing from trianglesAll`);
    if (this.trianglesAll.size !== this.triangles.total) bad('trianglesAll size != number of triangles');

    // triangles: neighbours, orientation, shared edges, trianglesFlip
    const order = new Int32Array(vCap);
    for (let t = 0; t < tCap; t++) {
      if (!inAll[t]) continue;
      const l = tTl[t], r = tTr[t], c = tTc[t];
      const vl = tVl[t], vr = tVr[t], vc = tVc[t];
      if (!inAll[l] || !inAll[r] || !inAll[c]) { bad(`triangle ${t} has a neighbour outside trianglesAll`); continue; }
      if (!this.vertices.alive(vl) || !this.vertices.alive(vr) || !this.vertices.alive(vc)) { bad(`triangle ${t} has a dead vertex`); continue; }
      if (tTr[l] !== t || tTl[r] !== t) bad(`left/right neighbours of ${t} not reciprocal`);
      if (tTc[c] !== t) bad(`centre neighbour of ${t} not reciprocal`);
      if (tType[c] === tType[t]) bad(`centre neighbour of ${t} has the same orientation`);
      if (tVl[c] !== vl || tVr[c] !== vr) bad(`triangle ${t} and its centre neighbour do not share the base`);
      if (vTime[vl] !== vTime[vr]) bad(`base of triangle ${t} not spacelike`);
      if (tTime[t] !== vTime[vl]) bad(`time of triangle ${t} wrong`);
      const apex = tType[t] === UP ? (vTime[vl] + 1) % T : (vTime[vl] + T - 1) % T;
      if (vTime[vc] !== apex) bad(`apex of triangle ${t} not in the ${tType[t] === UP ? 'next' : 'previous'} slice`);
      if (tType[t] !== this.orientation(vl, vc)) bad(`type of triangle ${t} inconsistent with its vertices`);
      // the right timelike edge {vr, vc} of the left neighbour is the left edge {vl, vc} of t
      const a = tVr[l], b = tVc[l];
      if (!((a === vl && b === vc) || (a === vc && b === vl))) bad(`triangle ${t} and its left neighbour do not share an edge`);
      if (this.trianglesFlip.contains(t) !== (tType[t] !== tType[r])) bad(`trianglesFlip inconsistent at ${t}`);
      order[vl]++;
      order[vr]++;
      order[vc]++;
    }
    for (let i = 0; i < this.trianglesFlip.size; i++) {
      if (!inAll[this.trianglesFlip.at(i)]) bad('trianglesFlip holds a dead triangle');
    }

    // vertices: pointers, coordination, verticesFour, slice sizes
    const slices = new Int32Array(T);
    let n0 = 0;
    for (let v = 0; v < vCap; v++) {
      const live = this.vertices.alive(v);
      if (live !== (order[v] > 0)) { bad(`vertex ${v}: ${live ? 'live but in no triangle' : 'dead but in a triangle'}`); continue; }
      if (!live) continue;
      n0++;
      if (vTime[v] < 0 || vTime[v] >= T) { bad(`time of vertex ${v} out of range`); continue; }
      slices[vTime[v]]++;
      if (!inAll[vTr[v]] || tType[vTr[v]] !== UP || tVl[vTr[v]] !== v) { bad(`right-triangle pointer of vertex ${v} wrong`); continue; }
      if (!inAll[vTl[v]] || tType[vTl[v]] !== UP || tVr[vTl[v]] !== v) { bad(`left-triangle pointer of vertex ${v} wrong`); continue; }
      if ((order[v] === 4) !== this.verticesFour.contains(v)) bad(`verticesFour inconsistent at vertex ${v} (order ${order[v]})`);
      if (this.coordUp(v) + this.coordDown(v) + 2 !== order[v]) bad(`coordination of vertex ${v} inconsistent with its order`);
    }
    for (let i = 0; i < this.verticesFour.size; i++) {
      if (!this.vertices.alive(this.verticesFour.at(i))) bad('verticesFour holds a dead vertex');
    }
    if (n0 !== this.vertices.total) bad(`vertices in triangles ${n0} != N0 ${this.vertices.total}`);

    // slices: sizes, the ring walk from the anchor, the strip walk
    for (let i = 0; i < T; i++) {
      if (slices[i] !== this.sliceSizes[i]) bad(`sliceSizes[${i}] = ${this.sliceSizes[i]}, recount ${slices[i]}`);
      if (this.sliceSizes[i] < 3) bad(`slice ${i} has fewer than 3 vertices`);
      const anchor = this.sliceAnchor[i];
      if (!this.vertices.alive(anchor) || vTime[anchor] !== i) { bad(`anchor of slice ${i} invalid`); continue; }
      let v = anchor;
      for (let k = 0; k < slices[i]; k++) {
        if (vTime[v] !== i) { bad(`ring walk of slice ${i} leaves the slice`); break; }
        v = tVr[vTr[v]];
        if (v === anchor && k < slices[i] - 1) { bad(`ring of slice ${i} shorter than the slice`); break; }
      }
      if (v !== anchor) bad(`ring walk of slice ${i} does not close after ${slices[i]} vertices`);
      const strip = slices[i] + slices[(i + 1) % T];
      let t = vTr[anchor];
      for (let k = 0; k < strip; k++) t = tTr[t];
      if (t !== vTr[anchor]) bad(`strip ${i} does not close after ${strip} triangles`);
    }

    // torus: N2 = 2 N0 (Euler characteristic 0)
    if (this.triangles.total !== 2 * this.vertices.total) bad(`N2 = ${this.triangles.total} != 2 N0 = ${2 * this.vertices.total}`);
    return P;
  }

  check() {
    const p = this.problems();
    if (p.length > 0) throw new Error('Universe.check failed:\n  ' + p.join('\n  '));
    return true;
  }
}
