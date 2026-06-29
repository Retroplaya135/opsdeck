/* Formatting, escaping and small DOM helpers. Pure and dependency-free, so
   everything downstream can import them without pulling in app state. */
export const $ = (id) => document.getElementById(id);
export const el = (sel, root) => (root || document).querySelector(sel);
export const els = (sel, root) => Array.from((root || document).querySelectorAll(sel));

export const ESC_MAP = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

export const nf0 = new Intl.NumberFormat('en-US');
export const nf1 = new Intl.NumberFormat('en-US', {minimumFractionDigits:1, maximumFractionDigits:1});
export const nf2 = new Intl.NumberFormat('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
export const num = (n) => nf0.format(Math.round(n || 0));
export const usd = (n) => '$' + nf0.format(Math.round(n || 0));
export const usdc = (n) => '$' + nf2.format(n || 0);
export const kmb = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + nf1.format(n / 1e6) + 'M';
  if (a >= 1e3) return '$' + nf1.format(n / 1e3) + 'k';
  return '$' + Math.round(n);
};
export const pct = (n) => nf1.format((n || 0) * 100) + '%';
export const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
export const sum = (arr, f) => arr.reduce((s, x) => s + (f ? f(x) : x), 0);
export const initials = (s) => s.split(/[\s-]+/).slice(0,2).map(w => w[0]).join('').toUpperCase();

export const DAY = 86400000;
export const TODAY = new Date(); TODAY.setHours(0,0,0,0);
export const dkey = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  const mm = String(x.getMonth() + 1).padStart(2, '0');
  const dd = String(x.getDate()).padStart(2, '0');
  return x.getFullYear() + '-' + mm + '-' + dd;
};
export const shortDate = (d) => d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
export const ago = (ms) => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
};
// Guarded so this module stays importable outside a browser — otherwise the
// whole utility layer becomes untestable in Node just to read one media query.
export const REDUCED = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;

/* Deterministic PRNG — the dataset must be identical on every load, or
   "yesterday's number" changes every refresh and the UI lies. */
export function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
export const rand = mulberry32(0x6D5A17);
export const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
export const pick = (a) => a[Math.floor(rand() * a.length)];

/* ── client-name masking ──────────────────────────────────────────────────
   Client names are masked by default for everyone, admin included. The
   reason is ordinary operational hygiene rather than access control: this
   console gets screen-shared on calls, screenshotted into decks and looked
   over shoulders, and a client's name sitting in a leaderboard next to their
   margin is the kind of disclosure nobody intends to make.

   The masked form is TWO REAL LETTERS plus filler, not the real string under
   a CSS blur. A blur is a picture of privacy: the text is still in the DOM,
   still selectable, still in the copied clipboard, still in the accessibility
   tree, and still there when the stylesheet fails to load. What is not
   rendered cannot leak that way.

   This is deliberately NOT a security boundary -- the toggle reveals, and the
   data is in the browser because the account is entitled to it. Scoping is
   what stops an account seeing a client at all; this only stops it being read
   at a glance by whoever else is looking at the screen. */
let namesRevealed = false;
try { namesRevealed = localStorage.getItem('css.names.reveal') === '1'; } catch (_) {}

export const namesAreRevealed = () => namesRevealed;

export function setNamesRevealed(on) {
  namesRevealed = !!on;
  try { localStorage.setItem('css.names.reveal', namesRevealed ? '1' : '0'); } catch (_) {}
}

/* Returns escaped HTML, so call sites must NOT wrap it in esc() again. */
export function maskName(name) {
  const full = String(name == null ? '' : name);
  if (namesRevealed) return esc(full);
  const head = full.slice(0, 2);
  // Filler length tracks the real length loosely so columns do not jump when
  // revealed, but is capped so a long name does not advertise how long it is.
  const n = Math.min(9, Math.max(3, full.length - 2));
  return esc(head) + '<span class="redacted" aria-label="name hidden">'
    + '\u2022'.repeat(n) + '</span>';
}

/* For avatars and anywhere only initials are shown: initials of a masked name
   would still identify a small book, so the second letter is dropped. */
export const maskInitials = (name) =>
  namesRevealed ? initials(name) : String(name || '').slice(0, 1).toUpperCase() + '\u2022';

/* Plain-text form of maskName, for places that cannot take markup: a
   <select><option>, or a title="" attribute where the class="redacted" quote
   would close the attribute early. Returns UNESCAPED text, so escape it at
   the call site exactly once. */
export function maskNameText(name) {
  const full = String(name == null ? '' : name);
  if (namesRevealed) return full;
  const n = Math.min(9, Math.max(3, full.length - 2));
  return full.slice(0, 2) + '\u2022'.repeat(n);
}
