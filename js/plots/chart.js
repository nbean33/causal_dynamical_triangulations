// A small layer over uPlot for the result charts: series with their own x values, one hover
// readout listing every legend group, an HTML legend with line keys, optional error bands,
// shaded x ranges and y bands, and a data table under each chart (the accessible view).
//
// spec = {
//   title, xLabel, yLabel, xLog, height, xRange: [min, max], yRange: [min, max],
//   shadeX: { from, to, label },        a recessive x range (e.g. lattice artefacts)
//   bandY:  { from, to, label },        a horizontal band (e.g. a published range)
//   series: [{ x, y, group, color: 1..4 | 'ref', dash, width, points, line, band: { lo, hi } }],
//   xFormat, yFormat: value -> string,  table: { xLabel }
// }
// Series sharing a `group` share a legend entry and a readout row (the mean of the members).

import uPlot from '../../vendor/uplot-1.6.31/uPlot.esm.js';

function cssVars() {
  const cs = getComputedStyle(document.documentElement);
  const v = name => cs.getPropertyValue(name).trim();
  return {
    text: v('--text'), muted: v('--text-muted'), grid: v('--border'), surface: v('--bg-raised'),
    series: [v('--series-1'), v('--series-2'), v('--series-3'), v('--series-4')],
  };
}

function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// linear interpolation of (xs, ys) at x over the non-null points; null outside the data
export function interp(xs, ys, x) {
  let prev = -1;
  for (let i = 0; i < xs.length; i++) {
    if (ys[i] == null) continue;
    if (xs[i] === x) return ys[i];
    if (xs[i] > x) {
      if (prev < 0) return null;
      const t = (x - xs[prev]) / (xs[i] - xs[prev]);
      return ys[prev] + t * (ys[i] - ys[prev]);
    }
    prev = i;
  }
  return null;
}

const fmt = v => (v == null || !isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toLocaleString('en', { maximumFractionDigits: 0 }) : Number(v.toPrecision(4)).toString());

export function chart(container, spec) {
  const groups = [...new Set(spec.series.map(s => s.group))];
  container.classList.add('chart-box');
  container.setAttribute('role', 'figure');
  container.setAttribute('aria-label', spec.title);

  // union of all x values, each series spread onto it with nulls where it has no point
  const xs = [...new Set(spec.series.flatMap(s => s.x))].sort((a, b) => a - b);
  const index = new Map(xs.map((x, i) => [x, i]));
  const spread = (sx, sy) => {
    const out = new Array(xs.length).fill(null);
    sx.forEach((x, i) => { out[index.get(x)] = sy[i] ?? null; });
    return out;
  };

  let plot = null;
  const head = document.createElement('div');
  head.className = 'chart-head';
  const title = document.createElement('div');
  title.className = 'chart-title';
  title.textContent = spec.title;
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  head.append(title, legend);
  const area = document.createElement('div');
  area.className = 'chart-area';
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  area.appendChild(tip);
  const table = document.createElement('details');
  table.className = 'chart-table';
  const caption = document.createElement('p');
  caption.className = 'chart-caption';
  caption.textContent = spec.caption ?? '';
  container.replaceChildren(head, area, caption, table);

  function build() {
    const c = cssVars();
    const colorOf = s => (s.color === 'ref' ? c.muted : c.series[(s.color || 1) - 1]);

    // legend: one entry per group, keyed with a short stroke (or a ring for point-only series)
    legend.replaceChildren(...groups.map(g => {
      const s = spec.series.find(x => x.group === g);
      const item = document.createElement('span');
      item.className = 'chart-key';
      const key = document.createElement('span');
      key.className = s.line === false ? 'key-dot' : 'key-line';
      key.style.setProperty('--key', colorOf(s));
      if (s.dash) key.classList.add('dashed');
      item.append(key, document.createTextNode(g));
      return item;
    }));

    const data = [xs];
    const series = [{}];
    const bands = [];
    for (const s of spec.series) {
      const color = colorOf(s);
      data.push(spread(s.x, s.y));
      series.push({
        stroke: color,
        width: s.line === false ? 0 : (s.width ?? 2),
        dash: s.dash,
        spanGaps: true,
        paths: s.line === false ? () => null : undefined,
        points: s.points || s.line === false
          ? { show: true, size: 7, width: 1.5, stroke: color, fill: s.line === false ? c.surface : color }
          : { show: false },
      });
      if (s.band) {
        const hi = data.length, lo = data.length + 1;
        data.push(spread(s.x, s.band.hi), spread(s.x, s.band.lo));
        series.push({ stroke: 'transparent', width: 0, spanGaps: true, points: { show: false } },
                    { stroke: 'transparent', width: 0, spanGaps: true, points: { show: false } });
        bands.push({ series: [hi, lo], fill: withAlpha(color, 0.18) });
      }
    }

    const axis = (label, size) => ({
      stroke: c.muted, label, labelSize: 20, size,
      grid: { stroke: c.grid, width: 1 }, ticks: { stroke: c.grid, width: 1, size: 4 },
      font: '12px system-ui, sans-serif', labelFont: '12px system-ui, sans-serif',
    });
    const xAxis = axis(spec.xLabel, 44);
    if (spec.xLog) xAxis.values = (u, ticks) => ticks.map(v => v >= 1e9 ? `${v / 1e9}G` : v >= 1e6 ? `${v / 1e6}M` : v >= 1e3 ? `${v / 1e3}k` : v);

    const shade = u => {
      const ctx = u.ctx, { left, top, width, height } = u.bbox;
      ctx.save();
      if (spec.shadeX) {
        const x0 = Math.max(left, u.valToPos(spec.shadeX.from, 'x', true));
        const x1 = Math.min(left + width, u.valToPos(spec.shadeX.to, 'x', true));
        ctx.fillStyle = withAlpha(c.muted, 0.12);
        ctx.fillRect(x0, top, x1 - x0, height);
      }
      if (spec.bandY) {
        const y0 = u.valToPos(spec.bandY.to, 'y', true), y1 = u.valToPos(spec.bandY.from, 'y', true);
        ctx.fillStyle = withAlpha(c.muted, 0.16);
        ctx.fillRect(left, y0, width, y1 - y0);
      }
      ctx.restore();
    };

    plot?.destroy();
    plot = new uPlot({
      width: Math.max(260, Math.floor(area.getBoundingClientRect().width)),
      height: spec.height ?? 300,
      legend: { show: false },
      cursor: { y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: {
        x: { time: false, distr: spec.xLog ? 3 : 1, ...(spec.xRange ? { range: spec.xRange } : {}) },
        y: spec.yRange ? { range: spec.yRange } : {},
      },
      axes: [xAxis, axis(spec.yLabel, 56)],
      series,
      bands,
      hooks: {
        drawClear: [shade],
        setCursor: [u => readout(u)],
      },
    }, data, area);
    plot.root.querySelector('canvas')?.setAttribute('aria-hidden', 'true');
    buildTable();
  }

  // hover readout: every group at the cursor's x, value first
  function readout(u) {
    const left = u.cursor.left;
    if (left == null || left < 0) { tip.hidden = true; return; }
    const x = u.posToVal(left, 'x');
    const rows = groupValues(x);
    if (rows.every(r => r.value == null)) { tip.hidden = true; return; }
    const c = cssVars();
    tip.replaceChildren();
    const xh = document.createElement('div');
    xh.className = 'tip-x';
    // the cursor sits between data points, so round its x more than the table does
    xh.textContent = `${spec.table?.xLabel ?? spec.xLabel}: ${(spec.xFormat ?? (v => Number(v.toPrecision(3)).toString()))(x)}`;
    tip.appendChild(xh);
    for (const r of rows) {
      if (r.value == null) continue;
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('span');
      key.className = 'key-line';
      key.style.setProperty('--key', r.s.color === 'ref' ? c.muted : c.series[(r.s.color || 1) - 1]);
      const val = document.createElement('strong');
      val.textContent = (spec.yFormat ?? fmt)(r.value);
      const lab = document.createElement('span');
      lab.textContent = r.group;
      row.append(key, val, lab);
      tip.appendChild(row);
    }
    tip.hidden = false;
    // cursor.left is in CSS pixels within the plotting area; bbox is in canvas pixels
    const px = left + u.bbox.left / devicePixelRatio;
    const tw = tip.offsetWidth;
    tip.style.left = `${px + 14 + tw > area.clientWidth ? px - tw - 14 : px + 14}px`;
    tip.style.top = `${u.bbox.top / devicePixelRatio + 8}px`;
  }

  function groupValues(x) {
    return groups.map(g => {
      const members = spec.series.filter(s => s.group === g);
      const vals = members.map(s => (s.line === false ? nearest(s, x) : interp(s.x, s.y, x))).filter(v => v != null);
      return { group: g, s: members[0], value: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    });
  }

  // point-only series (digitised paper points) read out only near an actual point
  function nearest(s, x) {
    let best = null, bd = Infinity;
    s.x.forEach((xi, i) => { const d = Math.abs(xi - x); if (d < bd) { bd = d; best = s.y[i]; } });
    const span = (xs[xs.length - 1] - xs[0]) || 1;
    return bd <= span * 0.02 ? best : null;
  }

  function buildTable() {
    const sum = document.createElement('summary');
    sum.textContent = 'Data table';
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap chart-table-scroll';
    const t = document.createElement('table');
    const thead = t.createTHead().insertRow();
    for (const h of [spec.table?.xLabel ?? spec.xLabel, ...groups]) {
      const th = document.createElement('th');
      th.textContent = h;
      thead.appendChild(th);
    }
    const body = t.createTBody();
    const step = Math.max(1, Math.ceil(xs.length / 120));  // at most about 120 rows
    for (let i = 0; i < xs.length; i += step) {
      const tr = body.insertRow();
      tr.insertCell().textContent = (spec.xFormat ?? fmt)(xs[i]);
      for (const r of groupValues(xs[i])) tr.insertCell().textContent = (spec.yFormat ?? fmt)(r.value);
    }
    wrap.appendChild(t);
    table.replaceChildren(sum, wrap);
  }

  build();
  area.addEventListener('pointerleave', () => { tip.hidden = true; });
  new ResizeObserver(() => plot && plot.setSize({ width: Math.max(260, Math.floor(area.getBoundingClientRect().width)), height: spec.height ?? 300 })).observe(area);
  const rebuild = () => build();
  document.addEventListener('themechange', rebuild);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rebuild);
  return { rebuild };
}
