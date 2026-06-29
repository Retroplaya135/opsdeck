/* ═══════════════════════════════════════════════════════════════════════════
   Shared view vocabulary.
   ═══════════════════════════════════════════════════════════════════════════
   The pieces every view reuses: stat tiles, KPI cards, sortable table headers,
   the activity feed, toasts and the count-up animation.

   These lived in the view file simply because that is where they were first
   needed. Once the analytical views moved into their own module they broke on
   `tile is not defined` — the smoke suite caught it — which is the signal that
   they were always a shared vocabulary rather than one view's private helpers.
   ═══════════════════════════════════════════════════════════════════════════ */
import { $, els, esc, num, nf0, clamp, ago, REDUCED, maskName } from './util.js';
import { sparkline } from './charts.js';
import { CLIENT_BY, AGENT_BY, SESSION, state } from './state.js';
import { PAST } from './aggregates.js';

export const exportBtn = (kind) => '<button class="btn btn-ghost btn-sm" data-exportcsv="' + kind + '">'
  + '<svg class="ic ic-14"><use href="#i-down"/></svg>Export CSV</button>';

export function kpiCard(k, v, delta, foot, spark, color) {
  return '<div class="glass kpi"><div class="k">' + esc(k) + '</div>'
    + '<div class="v" data-count="' + esc(v) + '">' + esc(v) + '</div>'
    + '<div class="foot">' + delta + '<span>' + esc(foot) + '</span></div>'
    + sparkline(spark, {color}) + '</div>';
}

export const tile = (k, v, cls) => '<div class="glass tile"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div></div>';

export function feedLine(a) {
  const ag = AGENT_BY[a.agentId], c = CLIENT_BY[a.clientId];
  if (!ag || !c) return '';
  const client = maskName(c.name), agent = esc(ag.name);
  if (a.outcome === 'closed')
    return { i: 'g', html: '<b>' + agent + '</b> closed an appointment for <b>' + client + '</b>' };
  if (a.outcome === 'showed')
    return { i: 'g', html: 'Appointment for <b>' + client + '</b> marked <span>sat</span> by <b>' + agent + '</b>' };
  if (a.outcome === 'noshow')
    return { i: 'r', html: 'No-show recorded on <b>' + client + '</b>' };
  if (a.outcome === 'cancelled')
    return { i: 'a', html: 'Appointment for <b>' + client + '</b> cancelled' };
  return { i: 'v', html: '<b>' + agent + '</b> booked an appointment for <b>' + client + '</b>' };
}

export function feedHTML(n) {
  const limit = n || 16;
  const rows = PAST.slice(-Math.max(limit * 3, 48)).reverse();
  let out = '', shown = 0;
  for (const a of rows) {
    if (shown >= limit) break;
    const line = feedLine(a);
    if (!line) continue;
    out += '<div class="ev"><span class="ei ' + line.i + '"><svg class="ic ic-14"><use href="#i-zap"/></svg></span>'
      + '<span class="et">' + line.html + '</span>'
      + '<span class="ew">' + ago(a.t) + '</span></div>';
    shown++;
  }
  if (!out) return '<div class="empty"><b>No recent activity</b>Appointments that have already happened will show up here.</div>';
  return out;
}

export function countUp(root) {
  if (REDUCED) return;
  els('[data-count]', root).forEach(node => {
    const target = node.dataset.count;
    const m = target.match(/-?[\d,.]+/);
    if (!m) return;
    const end = parseFloat(m[0].replace(/,/g, ''));
    if (!isFinite(end) || end === 0) return;
    const pre = target.slice(0, m.index), post = target.slice(m.index + m[0].length);
    const decimals = (m[0].split('.')[1] || '').length;
    const t0 = performance.now(), dur = 620;
    const step = (now) => {
      const p = clamp((now - t0) / dur, 0, 1);
      const e = 1 - Math.pow(1 - p, 3);
      const v = end * e;
      node.textContent = pre + (decimals ? v.toFixed(decimals) : nf0.format(Math.round(v))) + post;
      if (p < 1) requestAnimationFrame(step); else node.textContent = target;
    };
    requestAnimationFrame(step);
  });
}

export function th(tableKey, key, label, right) {
  const s = state.sort[tableKey];
  const dir = (s && s.key === key) ? s.dir : '';
  return '<th class="s' + (right ? ' r' : '') + '" data-sorttable="' + tableKey + '" data-sortkey="' + key + '"'
    + (dir ? ' data-dir="' + dir + '"' : '') + ' tabindex="0" role="button">' + esc(label) + '</th>';
}

export function applySort(rows, tableKey, valueOf) {
  const s = state.sort[tableKey];
  if (!s) return rows;
  const mul = s.dir === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    const x = valueOf(a, s.key), y = valueOf(b, s.key);
    if (typeof x === 'string') return x.localeCompare(y) * mul;
    return ((x || 0) - (y || 0)) * mul;
  });
  return rows;
}

let toastTimer = 0;
export function toast(msg) {
  const n = $('toast');
  n.innerHTML = '<svg class="ic ic-16" style="color:var(--emerald)"><use href="#i-check"/></svg>' + esc(msg);
  n.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => n.classList.remove('on'), 2400);
}


/* A restricted view must say so on the page itself. Without this an operator
   reading a filtered client book has no way to tell it is filtered, which is
   how someone reports "our MRR dropped" when they simply cannot see two
   thirds of the book. */
export function scopeBanner() {
  if (!SESSION.user || SESSION.unrestricted) return '';
  const n = (SESSION.clients || []).length;
  return '<div class="scope-note"><svg class="ic ic-14"><use href="#i-flag"/></svg>'
    + '<span>Restricted view — this account is scoped to <b>' + n + ' client account'
    + (n === 1 ? '' : 's') + '</b>. Rows for any other client are filtered out by the '
    + 'server and never reach this browser.</span></div>';
}

/* An "i" button that reveals the explanation on demand.

   The methodology used to sit on the page as body copy: every card carried a
   paragraph about detrending, Wilson intervals or standardised features. That
   is the right information for whoever tunes the model and the wrong
   information for a client reading their own numbers, who now sees the plain
   statement and can open the detail if they want it. Nothing is deleted, it
   just stops being the first thing on the card. */
export const info = (text) =>
  '<button type="button" class="ibtn" data-info="' + esc(text) + '" aria-label="What this means">i</button>';

/* One delegated listener for every info button on the page. */
let infoPop = null;
function closeInfo() { if (infoPop) { infoPop.remove(); infoPop = null; } }
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest && ev.target.closest('.ibtn');
  if (!btn) { closeInfo(); return; }
  ev.stopPropagation();
  const already = infoPop && infoPop.dataset.owner === btn.dataset.info;
  closeInfo();
  if (already) return;
  const pop = document.createElement('div');
  pop.className = 'ipop';
  pop.dataset.owner = btn.dataset.info;
  pop.textContent = btn.dataset.info;
  document.body.appendChild(pop);
  const r = btn.getBoundingClientRect();
  const w = Math.min(320, window.innerWidth - 24);
  pop.style.width = w + 'px';
  // Flip above the button when there is no room below, and keep it on screen
  // horizontally rather than letting it hang off the right edge.
  let left = Math.min(Math.max(12, r.left - w / 2 + r.width / 2), window.innerWidth - w - 12);
  pop.style.left = left + 'px';
  const below = window.innerHeight - r.bottom;
  if (below < pop.offsetHeight + 16) pop.style.top = (r.top - pop.offsetHeight - 8) + 'px';
  else pop.style.top = (r.bottom + 8) + 'px';
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeInfo(); });
window.addEventListener('scroll', closeInfo, true);
