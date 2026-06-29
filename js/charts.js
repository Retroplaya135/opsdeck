/* SVG chart builders. Every one returns a string, so a whole view renders in
   a single innerHTML write rather than node-by-node. Depends on util only. */
import { esc, clamp, num, nf1, nf2, pct, kmb, usd } from './util.js';

/* Each returns an SVG string. Built once per dataset, injected in bulk. */

export function sparkPath(vals, w, h, pad) {
  pad = pad || 2;
  // A one-day window yields a one-point series, and a single moveto draws
  // nothing at all -- the card renders with a blank space where the trend
  // should be. Repeat the point so it draws as a flat line across, which is
  // the honest picture of a single day.
  if (vals.length === 1) vals = [vals[0], vals[0]];
  if (!vals.length) vals = [0, 0];
  const max = Math.max.apply(null, vals) || 1;
  const min = Math.min.apply(null, vals);
  const span = (max - min) || 1;
  const dx = (w - pad * 2) / Math.max(1, vals.length - 1);
  let line = '', area = '';
  for (let i = 0; i < vals.length; i++) {
    const x = pad + i * dx;
    const y = pad + (h - pad * 2) * (1 - (vals[i] - min) / span);
    line += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
  }
  area = line + 'L' + (pad + (vals.length - 1) * dx).toFixed(1) + ' ' + (h - pad) + 'L' + pad + ' ' + (h - pad) + 'Z';
  return {line, area};
}

export let gid = 0;
export function sparkline(vals, opts) {
  opts = opts || {};
  const w = opts.w || 150, h = opts.h || 34, color = opts.color || 'var(--accent)';
  const p = sparkPath(vals, w, h, 3);
  const id = 'sg' + (++gid);
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">'
    + '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0%" stop-color="' + color + '" stop-opacity=".34"/>'
    + '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>'
    + '<path d="' + p.area + '" fill="url(#' + id + ')"/>'
    + '<path d="' + p.line + '" fill="none" stroke="' + color + '" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>'
    + '</svg>';
}

export function microSpark(vals, color) {
  const p = sparkPath(vals, 68, 20, 2);
  return '<svg width="68" height="20" viewBox="0 0 68 20" aria-hidden="true" style="display:block">'
    + '<path d="' + p.line + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity=".9"/></svg>';
}

/* Dual-series area chart with axis + grid. One <svg>, no library. */
export function areaChart(series, opts) {
  opts = opts || {};
  const W = 1000, H = opts.h || 250, L = 42, R = 14, T = 14, B = 26;
  const iw = W - L - R, ih = H - T - B;
  let a = series.a, b = series.b;
  let labels = series.labels;
  // Same reason as sparkPath: one point is not a line. Duplicated so the
  // series renders as a flat segment rather than vanishing.
  if (a.length === 1) {
    a = [a[0], a[0]];
    if (b && b.length === 1) b = [b[0], b[0]];
    if (labels && labels.length === 1) labels = [labels[0], labels[0]];
  }
  const max = Math.max(1, Math.max.apply(null, a.concat(b || [])));
  const n = a.length;
  const dx = iw / Math.max(1, n - 1);
  const X = (i) => L + i * dx;
  const Y = (v) => T + ih * (1 - v / max);

  const path = (vals) => {
    let d = '';
    for (let i = 0; i < vals.length; i++) d += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(vals[i]).toFixed(1);
    return d;
  };
  const areaOf = (vals) => path(vals) + 'L' + X(n-1).toFixed(1) + ' ' + (T + ih) + 'L' + L + ' ' + (T + ih) + 'Z';

  const idA = 'ga' + (++gid), idB = 'gb' + (++gid);
  const ticks = 4;
  let grid = '', axis = '';
  for (let i = 0; i <= ticks; i++) {
    const v = max * (1 - i / ticks), y = Y(v);
    grid += '<line class="gl" x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W-R) + '" y2="' + y.toFixed(1) + '"/>';
    axis += '<text class="ax" x="' + (L - 8) + '" y="' + (y + 3.2).toFixed(1) + '" text-anchor="end">' + Math.round(v) + '</text>';
  }
  const step = Math.max(1, Math.floor(n / 8));
  let xax = '';
  for (let i = 0; i < n; i += step) {
    xax += '<text class="ax" x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc((labels || [])[i] || '') + '</text>';
  }

  const cA = opts.colorA || '#2fb8ac', cB = opts.colorB || '#5ec8ff';
  let out = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(opts.label || 'Trend chart') + '">'
    + '<defs>'
    + '<linearGradient id="' + idA + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + cA + '" stop-opacity=".42"/><stop offset="100%" stop-color="' + cA + '" stop-opacity="0"/></linearGradient>'
    + '<linearGradient id="' + idB + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + cB + '" stop-opacity=".30"/><stop offset="100%" stop-color="' + cB + '" stop-opacity="0"/></linearGradient>'
    + '</defs>' + grid + axis + xax;
  if (b) out += '<path d="' + areaOf(b) + '" fill="url(#' + idB + ')"/><path d="' + path(b) + '" fill="none" stroke="' + cB + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity=".95"/>';
  out += '<path d="' + areaOf(a) + '" fill="url(#' + idA + ')"/><path d="' + path(a) + '" fill="none" stroke="' + cA + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
  out += '</svg>';
  return out;
}

/* Grouped revenue/cost bars with a margin overlay line. */
export function barChart(rows, opts) {
  opts = opts || {};
  const W = 1000, H = opts.h || 260, L = 52, R = 14, T = 16, B = 30;
  const iw = W - L - R, ih = H - T - B;
  const max = Math.max(1, Math.max.apply(null, rows.map(r => Math.max(r.revenue, r.cost))));
  const gw = iw / rows.length, bw = Math.min(26, gw * 0.30);
  const Y = (v) => T + ih * (1 - v / max);
  let grid = '', axis = '';
  for (let i = 0; i <= 4; i++) {
    const v = max * (1 - i / 4), y = Y(v);
    grid += '<line class="gl" x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W-R) + '" y2="' + y.toFixed(1) + '"/>';
    axis += '<text class="ax" x="' + (L-8) + '" y="' + (y+3.2).toFixed(1) + '" text-anchor="end">' + kmb(v) + '</text>';
  }
  const idR = 'br' + (++gid), idC = 'bc' + (++gid);
  let bars = '', labels = '', mline = '';
  rows.forEach((r, i) => {
    const cx = L + gw * i + gw / 2;
    const x1 = cx - bw - 2, x2 = cx + 2;
    const hR = Math.max(2, (T + ih) - Y(r.revenue)), hC = Math.max(2, (T + ih) - Y(r.cost));
    bars += '<rect x="' + x1.toFixed(1) + '" y="' + Y(r.revenue).toFixed(1) + '" width="' + bw + '" height="' + hR.toFixed(1) + '" rx="4" fill="url(#' + idR + ')"/>';
    bars += '<rect x="' + x2.toFixed(1) + '" y="' + Y(r.cost).toFixed(1) + '" width="' + bw + '" height="' + hC.toFixed(1) + '" rx="4" fill="url(#' + idC + ')"/>';
    labels += '<text class="ax" x="' + cx.toFixed(1) + '" y="' + (H-9) + '" text-anchor="middle">' + esc(r.label) + '</text>';
    mline += (i ? 'L' : 'M') + cx.toFixed(1) + ' ' + Y(r.margin).toFixed(1);
  });
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Revenue versus cost by month">'
    + '<defs>'
    + '<linearGradient id="' + idR + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2fb8ac"/><stop offset="100%" stop-color="#1c7a71" stop-opacity=".55"/></linearGradient>'
    + '<linearGradient id="' + idC + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f59e0b" stop-opacity=".78"/><stop offset="100%" stop-color="#f59e0b" stop-opacity=".28"/></linearGradient>'
    + '</defs>' + grid + axis + bars + labels
    + '<path d="' + mline + '" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linejoin="round" stroke-dasharray="5 4"/>'
    + '</svg>';
}

export function funnel(stages) {
  const top = stages[0] ? stages[0].n : 1;
  return '<div class="funnel">' + stages.map((s, i) => {
    const w = clamp(s.n / (top || 1), 0.035, 1) * 100;
    const prev = i ? stages[i-1].n : s.n;
    const rate = prev ? s.n / prev : 1;
    return '<div class="fstage">'
      + '<span class="lbl">' + esc(s.label) + '</span>'
      + '<div class="barw"><div class="barf" style="width:' + w.toFixed(1) + '%;background:linear-gradient(90deg,' + s.color + ',' + s.color + 'bb);animation-delay:' + (i * 55) + 'ms">' + num(s.n) + '</div></div>'
      + '<span class="rate">' + (i ? pct(rate) : '—') + '</span>'
      + '</div>';
  }).join('') + '</div>';
}

/* Like funnel(), but every row is measured against one fixed base rather
   than the row above it — the right semantics for a mix breakdown, where
   "no-shows as a % of the closed-won count" would be meaningless. */
export function breakdown(rows, base) {
  return '<div class="funnel">' + rows.map((r, i) =>
    '<div class="fstage">'
    + '<span class="lbl">' + esc(r.label) + '</span>'
    + '<div class="barw"><div class="barf" style="width:' + clamp(r.n / (base || 1), 0.012, 1) * 100 + '%;background:linear-gradient(90deg,' + r.color + ',' + r.color + 'bb);animation-delay:' + (i * 55) + 'ms"></div></div>'
    + '<span class="rate" style="width:44px;color:var(--text);font-weight:650">' + num(r.n) + '</span>'
    + '<span class="rate">' + pct(base ? r.n / base : 0) + '</span>'
    + '</div>').join('') + '</div>';
}

export function meter(value, target) {
  const r = target ? value / target : 0;
  const cls = r >= 1 ? 'good' : r >= 0.6 ? 'mid' : 'bad';
  return '<div class="meter"><div class="track"><div class="fill ' + cls + '" style="transform:scaleX(' + clamp(r, 0, 1).toFixed(3) + ')"></div></div>'
    + '<span class="pctv">' + nf2.format(value) + '</span></div>';
}

export function ring(done, total) {
  const r = 18, c = 2 * Math.PI * r, p = total ? done / total : 0;
  return '<div class="ringwrap"><svg class="ring" viewBox="0 0 44 44">'
    + '<circle class="bgc" cx="22" cy="22" r="' + r + '"/>'
    + '<circle class="fgc" cx="22" cy="22" r="' + r + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + (c * (1 - p)).toFixed(1) + '"/>'
    + '</svg><span>' + Math.round(p * 100) + '</span></div>';
}

export const deltaTag = (curr, prev) => {
  if (!prev) return '<span class="delta flat">—</span>';
  const d = (curr - prev) / prev;
  if (Math.abs(d) < 0.005) return '<span class="delta flat">flat</span>';
  const up = d > 0;
  return '<span class="delta ' + (up ? 'up' : 'down') + '"><svg class="ic ic-14"><use href="#' + (up ? 'i-up' : 'i-down') + '"/></svg>' + nf1.format(Math.abs(d) * 100) + '%</span>';
};

export const STATUS_PILL = {
  active:'on-', churned:'off', watch:'watch', expansion:'grow',
  keeper:'grow', ramping:'watch', fire:'risk', steady:'on-'
};
export const pill = (kind, label) => '<span class="pill ' + (STATUS_PILL[kind] || 'off') + '">' + esc(label || kind) + '</span>';
const exportBtn = (kind) => '<button class="btn btn-ghost btn-sm" data-exportcsv="' + kind + '"><svg class="ic ic-14"><use href="#i-down"/></svg>Export CSV</button>';

