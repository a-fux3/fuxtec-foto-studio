/* FUXTEC Foto Studio – Bildverarbeitung im Browser
 * Tonwerte (verlustfrei, nur Produktpixel) · Einpassen 900 in 1200 · Schärfen · Schatten · Export
 */
export const OUT = 1200, FRAME = 900;

export function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });

/* Datei → ImageBitmap (EXIF-Drehung wird berücksichtigt) */
export async function loadBitmap(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { // Fallback für exotische Formate
    const url = URL.createObjectURL(blob);
    try { const im = new Image(); im.src = url; await im.decode(); return im; } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
  }
}

/* Hochwertig verkleinern (schrittweise halbieren, dann Rest) */
export function resized(src, w, h) {
  let cur = src, cw = src.width, ch = src.height;
  while (cw / 2 > w && ch / 2 > h) {
    const n = canvas(Math.round(cw / 2), Math.round(ch / 2)), x = n.getContext('2d');
    x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, n.width, n.height); cur = n; cw = n.width; ch = n.height;
  }
  const o = canvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h))), x = o.getContext('2d');
  x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, o.width, o.height); return o;
}
export function fitMax(src, maxSide) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  return s === 1 && src instanceof HTMLCanvasElement ? src : resized(src, src.width * s, src.height * s);
}
export const toBlob = (c, type = 'image/png', q) => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Export fehlgeschlagen'))), type, q));
export function jpegDataUrl(src, maxSide, q = 0.88) {
  const c = fitMax(src, maxSide), o = canvas(c.width, c.height), x = o.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, o.width, o.height); x.drawImage(c, 0, 0); return o.toDataURL('image/jpeg', q);
}
export function hasAlpha(c) {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 32) if (d[i] < 200) n++;
  return n > d.length / 32 * 0.02;
}

/* ---------------- Tonwerte ---------------- */
const s2l = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const l2s = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/* tone: {exposure, contrast, shadows, highlights, saturation, warmth, levels}; wirkt nur auf deckende Pixel */
export function applyTone(c, tone) {
  if (!tone) return c;
  const t = { exposure: 0, contrast: 0, shadows: 0, highlights: 0, saturation: 0, warmth: 0, levels: false, ...tone };
  const x = ctx2d(c), img = x.getImageData(0, 0, c.width, c.height), d = img.data;
  // Schwarz-/Weißpunkt aus Produktpixeln
  let lo = 0, hi = 1;
  if (t.levels) {
    const hist = new Uint32Array(256); let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 220) { hist[(d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8]++; n++; }
    if (n > 500) {
      let acc = 0, a = 0; while (a < 255 && (acc += hist[a]) < n * 0.003) a++;
      acc = 0; let b = 255; while (b > 0 && (acc += hist[b]) < n * 0.003) b--;
      lo = Math.min(a / 255, 0.08); hi = Math.max(b / 255, 0.85);
      if (hi - lo < 0.5) { lo = 0; hi = 1; }
    }
  }
  const gain = 2 ** t.exposure, tau = Math.PI * 2;
  const wR = 1 + 0.1 * t.warmth, wG = 1 + 0.015 * t.warmth, wB = 1 - 0.1 * t.warmth;
  const curve = (v, g) => {
    v = clamp01((v - lo) / (hi - lo));
    let L = s2l(v) * gain * g;
    if (L > 0.85) L = 0.85 + 0.15 * (1 - Math.exp(-(L - 0.85) / 0.15)); // weiche Schulter statt Ausfressen
    let s = l2s(clamp01(L));
    s += t.shadows * 2.2 * s * (1 - s) * (1 - s);
    s += t.highlights * 2.2 * s * s * (1 - s);
    s -= t.contrast * Math.sin(tau * s) / tau;
    return clamp01(s);
  };
  const lut = [wR, wG, wB].map(g => { const a = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) a[i] = Math.round(curve(i / 255, g) * 255); return a; });
  const [R, G, B] = lut, sat = 1 + t.saturation;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = R[d[i]], g = G[d[i + 1]], b = B[d[i + 2]];
    if (sat !== 1) { const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; r = l + (r - l) * sat; g = l + (g - l) * sat; b = l + (b - l) * sat; }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  x.putImageData(img, 0, 0); return c;
}

/* Unscharf maskieren (nach dem Verkleinern) */
export function sharpen(c, amount, radius = 0.9) {
  if (!(amount > 0.02)) return c;
  const bl = canvas(c.width, c.height), bx = bl.getContext('2d');
  bx.filter = `blur(${radius}px)`; bx.drawImage(c, 0, 0);
  const x = ctx2d(c), img = x.getImageData(0, 0, c.width, c.height), d = img.data, e = ctx2d(bl).getImageData(0, 0, c.width, c.height).data;
  const k = amount * 1.3, thr = 2;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 250) continue;
    for (let j = 0; j < 3; j++) { const diff = d[i + j] - e[i + j]; if (diff > thr || diff < -thr) d[i + j] = d[i + j] + diff * k; }
  }
  x.putImageData(img, 0, 0); return c;
}

/* ---------------- Einpassen ---------------- */
/* Begrenzungsrahmen des Produkts (ignoriert Halbtransparenz-Staub) */
export function alphaBox(c, thr = 24) {
  const { width: w, height: h } = c, d = ctx2d(c).getImageData(0, 0, w, h).data;
  const col = new Uint32Array(w), row = new Uint32Array(h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > thr) { col[x]++; row[y]++; }
  const minC = Math.max(1, Math.round(h * 0.0015)), minR = Math.max(1, Math.round(w * 0.0015));
  let x0 = 0, x1 = w - 1, y0 = 0, y1 = h - 1;
  while (x0 < w && col[x0] < minC) x0++; while (x1 > x0 && col[x1] < minC) x1--;
  while (y0 < h && row[y0] < minR) y0++; while (y1 > y0 && row[y1] < minR) y1--;
  if (x0 >= w || y0 >= h) return { x: 0, y: 0, w, h, empty: true };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* Produkt (freigestellt) zentriert in 900×900 auf 1200×1200 setzen → { layer, box, map(nx,ny) } */
export function placeProduct(cut, { frame = FRAME, size = OUT, offsetY = 0 } = {}) {
  const b = alphaBox(cut);
  const s = frame / Math.max(b.w, b.h);
  const crop = canvas(b.w, b.h); crop.getContext('2d').drawImage(cut, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  const sc = s < 1 ? resized(crop, b.w * s, b.h * s) : resized(crop, b.w * s, b.h * s);
  const layer = canvas(size, size), dx = Math.round((size - sc.width) / 2), dy = Math.round((size - sc.height) / 2 + offsetY);
  layer.getContext('2d').drawImage(sc, dx, dy);
  const box = { x: dx, y: dy, w: sc.width, h: sc.height };
  // normierte Koordinaten im Quellbild → Ausgabe-Pixel
  const map = (nx, ny) => ({ x: dx + (nx * cut.width - b.x) * s, y: dy + (ny * cut.height - b.y) * s });
  return { layer, box, scale: s, map };
}

/* ---------------- Schatten ---------------- */
function bottomProfile(layer, box) {
  const w = layer.width, d = ctx2d(layer).getImageData(0, 0, w, layer.height).data;
  const bot = new Float32Array(w).fill(-1);
  for (let x = box.x; x < box.x + box.w; x++) {
    for (let y = Math.min(layer.height - 1, box.y + box.h); y >= box.y; y--) if (d[(y * w + x) * 4 + 3] > 128) { bot[x] = y; break; }
  }
  return bot;
}
/* Untere konvexe Hülle der Unterkante → Punkte, auf denen das Produkt "steht" */
function hullContacts(bot, box) {
  const pts = [];
  for (let x = box.x; x < box.x + box.w; x++) if (bot[x] >= 0) pts.push([x, -bot[x]]);
  const h = [];
  for (const p of pts) {
    while (h.length >= 2) { const [o, a] = [h[h.length - 2], h[h.length - 1]]; if ((a[0] - o[0]) * (p[1] - o[1]) - (a[1] - o[1]) * (p[0] - o[0]) <= 0) h.pop(); else break; }
    h.push(p);
  }
  const H = box.h, tol = Math.max(2, H * 0.012), gx = x => { // Hüllen-Höhe an x
    for (let i = 1; i < h.length; i++) if (x <= h[i][0]) { const [a, b] = [h[i - 1], h[i]]; const t = (x - a[0]) / Math.max(1, b[0] - a[0]); return -(a[1] + (b[1] - a[1]) * t); }
    return -h[h.length - 1][1];
  };
  // zusammenhängende Abschnitte, die auf der Hülle liegen = Kontaktflächen
  const out = []; let run = null;
  for (let x = box.x; x < box.x + box.w; x++) {
    const on = bot[x] >= 0 && gx(x) - bot[x] <= tol;
    if (on) { if (!run) run = { x0: x, x1: x }; else run.x1 = x; }
    else if (run && x - run.x1 > box.w * 0.01) { out.push(run); run = null; }
  }
  if (run) out.push(run);
  const res = out.map(r => { const cx = Math.round((r.x0 + r.x1) / 2); return { x: cx, y: bot[cx] >= 0 ? bot[cx] : gx(cx) }; });
  // zusätzlich lokale Tiefpunkte knapp über der Hülle (z. B. hintere Räder in Schrägansicht)
  const win = Math.max(4, Math.round(box.w * 0.03));
  for (let x = box.x + win; x < box.x + box.w - win; x++) {
    if (bot[x] < 0) continue; const gap = gx(x) - bot[x];
    if (gap <= tol || gap > H * 0.12) continue;
    let isMax = true; for (let k = x - win; k <= x + win && isMax; k++) if (bot[k] > bot[x] || (bot[k] === bot[x] && k < x)) isMax = false;
    if (isMax && !res.some(p => Math.abs(p.x - x) < box.w * 0.05)) res.push({ x, y: bot[x], weak: true });
  }
  // nur Punkte im unteren Bereich des Produkts (Hüllen-Enden an Griffen/Dächern sind keine Bodenkontakte)
  return res.filter(p => p.y >= box.y + box.h * 0.72);
}
/* KI-Kontaktpunkt auf die tatsächliche Unterkante in der Nähe einrasten */
function snap(p, bot, box) {
  const win = box.w * 0.05; let best = null, bs = -Infinity;
  for (let x = Math.max(box.x, Math.round(p.x - win)); x <= Math.min(box.x + box.w - 1, Math.round(p.x + win)); x++) {
    if (bot[x] < 0) continue;
    const s = bot[x] - 0.35 * Math.abs(x - p.x) - 0.6 * Math.max(0, bot[x] - p.y - box.h * 0.04);
    if (s > bs) { bs = s; best = { x, y: bot[x] }; }
  }
  return best || p;
}
function convexHull(pts) {
  const P = [...pts].sort((a, b) => a.x - b.x || a.y - b.y); if (P.length < 3) return P;
  const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of P.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/* Kontaktpunkte bestimmen: manuell (Ausgabe-Pixel) > KI (normiert, eingerastet) > automatisch (Hülle) */
export function resolveContacts(placed, { manual, ai } = {}) {
  const bot = bottomProfile(placed.layer, placed.box);
  if (manual?.length) return { pts: manual.map(p => snap(p, bot, placed.box)), source: 'manuell', bot };
  if (ai?.length) return { pts: ai.map(p => snap(placed.map(p.x, p.y), bot, placed.box)), source: 'KI', bot };
  return { pts: hullContacts(bot, placed.box), source: 'auto', bot };
}

/* Schattenebene (schwarz mit Alpha) – opts: {mode: floor|flat|none, light: left|center|right, strength 0..1.5, contacts} */
export function buildShadow(placed, opts) {
  const { layer, box } = placed, S = canvas(layer.width, layer.height), sx = S.getContext('2d');
  const k = opts.strength ?? 1; if (opts.mode === 'none' || k <= 0) return { canvas: S, contacts: [] };
  const W = box.w, H = box.h, dir = opts.light === 'left' ? 1 : opts.light === 'right' ? -1 : 0;
  const blurLayer = (draw, blur, alpha, dx = 0, dy = 0) => {
    const t = canvas(S.width, S.height), tx = t.getContext('2d'); tx.fillStyle = '#000'; tx.strokeStyle = '#000'; draw(tx);
    sx.save(); sx.globalAlpha = Math.min(1, alpha * k); sx.filter = `blur(${Math.max(0.5, blur).toFixed(1)}px)`; sx.drawImage(t, dx, dy); sx.restore();
  };
  const silhouette = tx => { tx.drawImage(layer, 0, 0); tx.globalCompositeOperation = 'source-in'; tx.fillRect(0, 0, S.width, S.height); tx.globalCompositeOperation = 'source-over'; };

  if (opts.mode === 'flat') {
    blurLayer(silhouette, Math.max(W, H) * 0.012, 0.32, dir * W * 0.004, H * 0.008);
    blurLayer(silhouette, Math.max(W, H) * 0.04, 0.22, dir * W * 0.012, H * 0.025);
    return { canvas: S, contacts: [] };
  }

  // floor
  const C = resolveContacts(placed, opts.contacts || {}), bot = C.bot, pts = C.pts;
  if (!pts.length) return { canvas: S, contacts: [] };
  const tol = Math.max(2, H * 0.014), minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));

  // 1) Kontaktschatten entlang der Unterkante rund um jeden Kontaktpunkt (Kernschatten)
  const contactShape = tx => {
    for (const p of pts) {
      const win = W * 0.06;
      for (let x = Math.max(box.x, Math.round(p.x - win)); x <= Math.min(box.x + W - 1, Math.round(p.x + win)); x++) {
        if (bot[x] < 0 || p.y - bot[x] > tol) continue;
        const a = 1 - (p.y - bot[x]) / tol; tx.globalAlpha = Math.max(0.15, a);
        tx.fillRect(x, bot[x] - 1, 1, 2 + H * 0.004);
      }
    }
    tx.globalAlpha = 1;
  };
  blurLayer(contactShape, Math.max(1.2, H * 0.0035), 0.9);
  blurLayer(contactShape, Math.max(3, H * 0.012), 0.55, 0, H * 0.002);

  // 2) Bodenfläche unter dem Produkt = perspektivisches Viereck/Polygon aus allen Kontaktpunkten
  const hull = convexHull(pts), flatLine = hull.length < 3 || (Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y))) < H * 0.02;
  const footprint = tx => {
    tx.lineJoin = 'round'; tx.lineCap = 'round'; tx.lineWidth = flatLine ? H * 0.03 : H * 0.012;
    tx.beginPath(); hull.forEach((p, i) => (i ? tx.lineTo(p.x, p.y - (flatLine ? H * 0.006 : 0)) : tx.moveTo(p.x, p.y - (flatLine ? H * 0.006 : 0))));
    if (hull.length > 2) tx.closePath(), tx.fill(); tx.stroke();
  };
  blurLayer(footprint, Math.max(4, W * 0.02), flatLine ? 0.3 : 0.36, dir * W * 0.006, 0);
  // 3) weicher Umgebungsschatten (flache Ellipse), leicht vom Licht weg verschoben
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
  blurLayer(tx => { tx.beginPath(); tx.ellipse((minX + maxX) / 2, (minY + maxY) / 2 + H * 0.004, (maxX - minX) / 2 + W * 0.05, Math.max((maxY - minY) / 2, H * 0.012) + H * 0.018, 0, 0, Math.PI * 2); tx.fill(); },
    Math.max(10, W * 0.045), 0.2, dir * W * 0.03, H * 0.004);
  return { canvas: S, contacts: pts, source: C.source };
}

/* ---------------- Komposition ---------------- */
export function compose(placed, shadow, bg) {
  const o = canvas(placed.layer.width, placed.layer.height), x = o.getContext('2d');
  if (bg) { x.fillStyle = bg; x.fillRect(0, 0, o.width, o.height); }
  if (shadow) x.drawImage(shadow, 0, 0);
  x.drawImage(placed.layer, 0, 0); return o;
}

/* Kompletter Render-Durchlauf aus der Freisteller-Ebene */
export function renderFinal(cut, s) {
  const src = canvas(cut.width, cut.height); src.getContext('2d').drawImage(cut, 0, 0);
  if (s.toneOn && s.tone) applyTone(src, s.tone);
  const placed = placeProduct(src, { offsetY: s.offsetY || 0 });
  sharpen(placed.layer, s.toneOn && s.tone ? (s.tone.sharpen ?? 0.2) : 0.15);
  const sh = buildShadow(placed, { mode: s.shadowMode, light: s.light, strength: s.strength, contacts: { manual: s.manualContacts, ai: s.aiContacts } });
  return { placed, shadow: sh, jpg: compose(placed, sh.canvas, '#ffffff'), png: compose(placed, sh.canvas, null) };
}
