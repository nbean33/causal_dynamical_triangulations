// research/validation.html: interactive versions of the validation figures, built from data/*.json
// (written by tools/sync_from_cdt.py; schema in data/README.md). Each chart replaces the static
// figure named by its container's data-replaces attribute; without JS the figures stay.

import { chart } from './chart.js';

const load = name => fetch(`../data/${name}.json`).then(r => {
  if (!r.ok) throw new Error(`${name}.json: HTTP ${r.status}`);
  return r.json();
});

function mount(id, build) {
  const el = document.getElementById(id);
  if (!el) return;
  build(el)
    .then(() => {
      const img = el.dataset.replaces && document.querySelector(`img[src$="${el.dataset.replaces}"]`);
      if (img) img.closest('figure').hidden = true;
    })
    .catch(err => {
      el.replaceChildren();  // leave the static figure
      console.error(err);
    });
}

const kfmt = n => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

//// de Sitter scaling collapse

mount('chart-desitter', async el => {
  const d = await load('desitter');
  const chains = d.chains.filter(c => c.code === 'cpp');
  const color = { '20k': 1, '40k': 2, '80k': 3 };
  const series = chains.map(c => ({
    x: c.x, y: c.y, color: color[c.volume], width: 1.5, dash: c.equilibrated ? undefined : [5, 4],
    group: `N₄₁ = ${c.volume}, ${chains.filter(o => o.volume === c.volume).length} chains${c.equilibrated ? '' : ', no single blob'}`,
  }));
  series.push({ x: d.published.curve.x, y: d.published.curve.y, color: 'ref', width: 2, dash: [2, 3], group: `published cos³, s₀ = ${d.published.value}` });
  chart(el, {
    title: 'de Sitter volume profiles, rescaled',
    xLabel: 'i / N₄^¼', yLabel: '⟨N₃(i)⟩ rescaled', height: 320,
    table: { xLabel: 'i / N₄^¼' },
    caption: 'Each line is one Markov chain (second half of production), centred on its centre of volume and rescaled by N₄^¼ in time and N₄^¾ in volume. Profiles from different volumes falling on one curve means the universe scales as four-dimensional. The hover readout and the table give the mean of each volume\'s chains.',
    series,
  });
});

//// spectral dimension

mount('chart-spectral', async el => {
  const s = await load('spectral');
  const series = s.runs.map((r, k) => ({
    x: r.sigma, y: r.ds, band: { lo: r.ds.map((v, i) => v - r.err[i]), hi: r.ds.map((v, i) => v + r.err[i]) },
    color: k + 1, dash: r.blob ? undefined : [5, 4],
    group: `N₄ = ${kfmt(r.N4)}${r.blob ? '' : ', no blob'}`,
  }));
  const { a, b, c } = s.ajl;
  const sig = s.runs.reduce((m, r) => (r.sigma.length > m.length ? r.sigma : m), []);
  series.push({ x: sig, y: sig.map(x => a - b / (c + x)), color: 'ref', width: 2, dash: [2, 3], group: `AJL fit ${a} − ${b}/(${c} + σ)` });
  chart(el, {
    title: 'Spectral dimension D_S(σ)',
    xLabel: 'diffusion time σ', yLabel: 'D_S', height: 320, yRange: [1.5, 4],
    shadeX: { from: 0, to: s.sigma_min_reliable },
    table: { xLabel: 'σ' },
    caption: `Shaded bands are ±1 jackknife error. Below σ = ${s.sigma_min_reliable} (grey) odd and even steps differ, a lattice artefact, so the published fit starts there. The N₄ = 182k geometry never formed a de Sitter blob and is not a test of the fit.`,
    series,
  });
});

//// phases: phase-B collapse and the A–C transition

mount('chart-phases', async el => {
  const p = await load('phases');
  el.classList.add('fig-pair');
  const left = document.createElement('div');
  const right = document.createElement('div');
  el.replaceChildren(left, right);

  const byId = Object.fromEntries(p.phaseB_collapse.map(r => [r.id, r]));
  const picks = [
    ['phB-20k-u-c0', 1, 'C++, N₄₁ = 20k'],
    ['phB-40k-u-c0', 2, 'C++, N₄₁ = 40k'],
    ['phB-10k-u-c1', 4, 'C++, N₄₁ = 10k'],
    ['phB20a-u', 3, 'Lisp, N₄₁ = 10k'],
  ].filter(([id]) => byId[id]);
  chart(left, {
    title: 'Phase B: collapse into one slice',
    xLabel: 'proposals', xLog: true, yLabel: 'largest slice / total', yRange: [0, 1], height: 280,
    xFormat: v => v.toExponential(1),
    caption: 'κ₀ = 1.6, Δ = 0, all from uniform starts. At 20k and 40k the volume collapses into a single slice; at 10k the collapse is a slow, random escape from a metastable blob, which one C++ chain made and the Lisp chain had not yet made.',
    series: picks.map(([id, color, group]) => ({ x: byId[id].proposals, y: byId[id].value, color, group })),
  });

  const runs = Object.fromEntries(p.runs.map(r => [r.id, r]));
  const colorAC = [1, 2, 3, 4];
  const series = p.AC_vs_kappa0.map((g, k) => {
    // average runs at the same kappa0 (uniform and concentrated starts)
    const at = new Map();
    for (const id of g.runs) {
      const r = runs[id];
      if (!r || !r.N0_N4) continue;
      if (!at.has(r.kappa0)) at.set(r.kappa0, []);
      at.get(r.kappa0).push(r.N0_N4[0]);
    }
    const ks = [...at.keys()].sort((x, y) => x - y);
    return {
      x: ks, y: ks.map(k0 => at.get(k0).reduce((s, v) => s + v, 0) / at.get(k0).length),
      color: colorAC[k], points: true, width: 1.5,
      group: `${g.code === 'cpp' ? 'C++' : 'Lisp'}, N₄₁ = ${kfmt(g.N41)}`,
    };
  });
  const [lo, hi] = p.published.AC.N0_N4_jump;
  chart(right, {
    title: 'A–C transition at Δ = 0.6',
    xLabel: 'κ₀', yLabel: 'N₀ / N₄', height: 280,
    bandY: { from: lo, to: hi },
    caption: `The order parameter N₀/N₄ jumps where the universe changes from phase C (extended) to phase A. The grey band is the published jump, ${lo}–${hi}, at κ₀ = ${p.published.AC.kappa0} and N₄ = 120k; the jump moves towards it as the volume grows.`,
    series,
  });
});

//// 2D curvature profile

mount('chart-curvature', async el => {
  const { cdt } = await load('curvature2d');
  const sets = Object.fromEntries(cdt.sets.map(s => [s.id, s]));
  const paper = Object.fromEntries(cdt.paper.fig5.curves.map(c => [c.label, c]));
  const series = [];
  [['link-50k', '50k', 1], ['link-90k', '90k', 2], ['link-150k', '150k', 3]].forEach(([id, label, color]) => {
    const s = sets[id];
    if (!s) return;
    series.push({
      x: s.delta, y: s.mean, color, width: 2,
      band: { lo: s.mean.map((v, i) => v - s.err[i]), hi: s.mean.map((v, i) => v + s.err[i]) },
      group: `N₂ = ${label}, this code`,
    });
    if (paper[label]) series.push({ x: paper[label].delta, y: paper[label].value, color, line: false, group: `N₂ = ${label}, paper` });
  });
  const flat = cdt.lattice_flat.link;
  series.push({ x: flat.delta, y: flat.value, color: 'ref', width: 2, dash: [2, 3], group: 'flat hexagonal lattice' });
  chart(el, {
    title: 'Curvature profile of 2D CDT (link distance)',
    xLabel: 'δ (link distance)', yLabel: '⟨d̄/δ⟩', height: 320, xRange: [1, 30],
    table: { xLabel: 'δ' },
    caption: 'Lines with ±1σ bands are this code; rings are points digitised from Brunekreef and Loll, arXiv:2110.11100, Fig. 5. The dashed line is the exact profile of the flat hexagonal lattice, which the profiles approach from below ("quantum flatness") before the torus topology bends them down.',
    series,
  });
});
