/* FUXTEC Foto Studio – Bildverarbeitung im Browser
 * Tonwerte (verlustfrei, nur Produktpixel) · Einpassen 900 in 1200 · Schärfen · Schatten · Export
 */
export const OUT = 1200, FRAME = 900;

export function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
const ctx2d = c => c.getContext('2d', { willReadFrequently: true });

/* TIFF erkennen (II*\0 / MM\0*) – Chrome kann TIFF nicht selbst dekodieren */
export async function isTiff(blob) {
  if (/\.tiff?$/i.test(blob.name || '') || /tiff/i.test(blob.type || '')) return true;
  const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a);
}
/* TIFF → Canvas (UTIF: unkomprimiert, LZW, ZIP, PackBits, JPEG; 8/16 Bit; RGB, Graustufen, CMYK; größte Seite/Ebene) */
export async function decodeTiff(blob) {
  const U = self.UTIF; if (!U) throw new Error('TIFF-Decoder nicht geladen');
  const buf = await blob.arrayBuffer();
  const ifds = U.decode(buf);
  let best = null;
  for (const f of ifds) { const w = f.t256?.[0], h = f.t257?.[0]; if (w && h && (!best || w * h > best.w * best.h)) best = { f, w, h }; }
  if (!best) throw new Error('TIFF enthält kein lesbares Bild');
  U.decodeImage(buf, best.f, ifds);
  const rgba = U.toRGBA8(best.f);
  if (!rgba || rgba.length < best.w * best.h * 4) throw new Error('TIFF-Variante wird nicht unterstützt (Kompression ' + (best.f.t259?.[0] ?? '?') + ')');
  const c = canvas(best.w, best.h);
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, best.w * best.h * 4), best.w, best.h), 0, 0);
  return c;
}

/* Datei → ImageBitmap (EXIF-Drehung wird berücksichtigt) */
export async function loadBitmap(blob) {
  if (await isTiff(blob)) return decodeTiff(blob);
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
export function sharpen(c, amount, radius = 0.9, edge = 0.7) {
  // Farbe UND Kante schärfen: auch halbtransparente Kantenpixel (Sägekette, Gitter) werden mitgeschärft,
  // die Alpha-Kante wird per Unscharfmaskierung gestrafft → im PNG kristallscharfe Konturen statt weicher Säume
  const bl = canvas(c.width, c.height), bx = bl.getContext('2d');
  bx.filter = `blur(${radius}px)`; bx.drawImage(c, 0, 0);
  const x = ctx2d(c), img = x.getImageData(0, 0, c.width, c.height), d = img.data, e = ctx2d(bl).getImageData(0, 0, c.width, c.height).data;
  const k = Math.max(0, amount) * 1.3, thr = 2;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]; if (a < 6) continue;
    if (k > 0.02) for (let j = 0; j < 3; j++) { const diff = d[i + j] - e[i + j]; if (diff > thr || diff < -thr) d[i + j] = d[i + j] + diff * k * (a < 250 ? 0.7 : 1); }
    if (edge > 0 && a < 250) d[i + 3] = a + (a - e[i + 3]) * edge;
  }
  x.putImageData(img, 0, 0); return c;
}

/* ---------------- Kanten-Rettung ----------------
 * Freisteller-KIs verschlucken feine Strukturen (Sägekette, Gitter, Speichen, Fäden). Bei einfarbigem Studiogrund lässt sich
 * das aus dem Originalfoto zurückholen: Pixel nahe der Freisteller-Kante, die sich klar vom (lokal geschätzten) Hintergrund
 * unterscheiden und Struktur haben, werden wieder deckend. Weiche Schatten (wenig Struktur) bleiben draußen.
 * cut = Freisteller (RGBA), src = Quellbild in gleicher Größe. Gibt { canvas, added } zurück. */
export function refineAlpha(cut, src, { radius } = {}) {
  const w = cut.width, h = cut.height, N = w * h;
  const C = ctx2d(cut).getImageData(0, 0, w, h), cd = C.data;
  const sc = canvas(w, h); sc.getContext('2d').drawImage(src, 0, 0, w, h);
  const sd = ctx2d(sc).getImageData(0, 0, w, h).data;
  const R = radius || Math.max(4, Math.round(Math.max(w, h) * 0.006));
  // Abstand zum Produkt (grob, über wiederholtes Dilatieren mit 3×3)
  const dist = new Uint16Array(N).fill(65535); let front = [];
  for (let i = 0; i < N; i++) if (cd[i * 4 + 3] > 24) { dist[i] = 0; front.push(i); }
  const FAR = R + 14;
  for (let k = 1; k <= FAR && front.length; k++) {
    const nx = [];
    for (const i of front) { const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const j = Y * w + X; if (dist[j] > k) { dist[j] = k; nx.push(j); } } }
    front = nx;
  }
  // Hintergrund lokal schätzen: 24er-Raster aus fernen Hintergrundpixeln, Lücken auffüllen
  const G = 24, gw = Math.ceil(w / G), gh = Math.ceil(h / G), acc = new Float32Array(gw * gh * 4);
  let n = 0, s1 = 0, s2 = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const i = y * w + x; if (dist[i] <= FAR) continue;
    const g = ((y / G) | 0) * gw + ((x / G) | 0), L = (sd[i * 4] + sd[i * 4 + 1] + sd[i * 4 + 2]) / 3;
    acc[g * 4] += sd[i * 4]; acc[g * 4 + 1] += sd[i * 4 + 1]; acc[g * 4 + 2] += sd[i * 4 + 2]; acc[g * 4 + 3]++; n++; s1 += L; s2 += L * L;
  }
  if (n < 500) return { canvas: cut, added: 0, skipped: 'zu wenig Hintergrund' };
  const sd2 = Math.sqrt(Math.max(0, s2 / n - (s1 / n) ** 2));
  if (sd2 > 28) return { canvas: cut, added: 0, skipped: 'unruhiger Hintergrund' };
  const bg = new Float32Array(gw * gh * 3), has = new Uint8Array(gw * gh);
  for (let g = 0; g < gw * gh; g++) if (acc[g * 4 + 3] > 3) { for (let c = 0; c < 3; c++) bg[g * 3 + c] = acc[g * 4 + c] / acc[g * 4 + 3]; has[g] = 1; }
  for (let pass = 0; pass < gw + gh; pass++) { let changed = 0;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) { const g = gy * gw + gx; if (has[g]) continue; let c2 = 0; const sum = [0, 0, 0];
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = gx + ox, Y = gy + oy; if (X < 0 || Y < 0 || X >= gw || Y >= gh) continue; const q = Y * gw + X; if (has[q] === 1) { for (let c = 0; c < 3; c++) sum[c] += bg[q * 3 + c]; c2++; } }
      if (c2) { for (let c = 0; c < 3; c++) bg[g * 3 + c] = sum[c] / c2; has[g] = 2; changed++; } }
    for (let g = 0; g < gw * gh; g++) if (has[g] === 2) has[g] = 1;
    if (!changed) break; }
  const bgAt = (x, y, c) => { // bilinear
    const fx = Math.min(gw - 1.001, Math.max(0, x / G - 0.5)), fy = Math.min(gh - 1.001, Math.max(0, y / G - 0.5)), x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
    const q = (X, Y) => bg[(Math.min(gh - 1, Y) * gw + Math.min(gw - 1, X)) * 3 + c];
    return q(x0, y0) * (1 - tx) * (1 - ty) + q(x0 + 1, y0) * tx * (1 - ty) + q(x0, y0 + 1) * (1 - tx) * ty + q(x0 + 1, y0 + 1) * tx * ty;
  };
  // Luminanz für Struktur-Test
  const Lum = new Float32Array(N); for (let i = 0; i < N; i++) Lum[i] = 0.2126 * sd[i * 4] + 0.7152 * sd[i * 4 + 1] + 0.0722 * sd[i * 4 + 2];
  const ss = (e0, e1, v) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  // Kandidaten im Saum: deutlich anders als Hintergrund UND strukturiert (Schatten sind glatt)
  const cand = new Float32Array(N);
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x; if (dist[i] === 0 && cd[i * 4 + 3] > 230) continue; if (dist[i] > R) continue;
    const dr = sd[i * 4] - bgAt(x, y, 0), dg = sd[i * 4 + 1] - bgAt(x, y, 1), db = sd[i * 4 + 2] - bgAt(x, y, 2);
    const d = Math.sqrt(dr * dr + dg * dg + db * db); if (d < 20) continue;
    let mn = 255, mx = 0; for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) { const k = i + oy * w + ox; if (cd[k * 4 + 3] > 128) continue; const v = Lum[k]; if (v < mn) mn = v; if (v > mx) mx = v; } // nur Nicht-Produkt-Nachbarn: Schatten direkt am Produkt bleiben glatt
    if (mx < mn) continue;
    cand[i] = ss(20, 70, d) * ss(14, 40, mx - mn);
  }
  // nur zusammenhängend vom Produkt aus wachsen (keine Staubkörner im Hintergrund)
  const out = new Uint8ClampedArray(cd), vis = new Uint8Array(N); let q = [];
  for (let i = 0; i < N; i++) if (cd[i * 4 + 3] > 64) { vis[i] = 1; q.push(i); }
  let added = 0;
  while (q.length) { const nq = [];
    for (const i of q) { const x = i % w, y = (i / w) | 0;
      for (const j of [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1]) {
        if (j < 0 || j >= N || vis[j]) continue; const X = j % w; if (Math.abs(X - x) > 1) continue;
        vis[j] = 1; const a = cand[j]; if (a < 0.25) continue;
        const na = Math.round(a * 255); if (na <= out[j * 4 + 3]) { nq.push(j); continue; }
        // Farbe vom Hintergrund entmischen: F = B + (S − B) / a
        const Y = (j / w) | 0, af = na / 255;
        for (let c = 0; c < 3; c++) { const B = bgAt(X, Y, c); out[j * 4 + c] = B + (sd[j * 4 + c] - B) / Math.max(af, 0.35); }
        out[j * 4 + 3] = na; added++; nq.push(j);
      } }
    q = nq; }
  // Matte leicht straffen: fast-transparenter Schleier weg, fast-deckende Pixel ganz deckend
  for (let i = 3; i < out.length; i += 4) { const a = out[i]; if (a && a < 255) out[i] = Math.max(0, Math.min(255, (a - 14) * 255 / 226)); }
  // Halbtransparente Kantenpixel entfärben (sonst heller/grauer Saum vom Studiogrund im PNG)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, a = out[i * 4 + 3]; if (a < 12 || a > 243) continue;
    const af = Math.max(a / 255, 0.3);
    for (let c = 0; c < 3; c++) { const B = bgAt(x, y, c); out[i * 4 + c] = B + (sd[i * 4 + c] - B) / af; }
  }
  const o = canvas(w, h); o.getContext('2d').putImageData(new ImageData(out, w, h), 0, 0);
  return { canvas: o, added };
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

/* ---------------- KI-Schatten ----------------
 * Die Bild-KI bekommt das Produkt auf Weiß (ohne Schatten) und malt einen Schatten dazu. Übernommen wird NUR der Schatten:
 * KI-Bild auf unser Produkt ausrichten → Abdunklung gegenüber dem Weiß außerhalb des Produkts = Schatten-Alpha.
 * Das Produkt selbst bleibt pixelgenau unser Freisteller (die KI zeichnet es leicht neu). */
export function productOnWhite(placed) { return compose(placed, null, '#ffffff'); }

function lumArr(c, size) {
  const t = resized(c, size, size), d = ctx2d(t).getImageData(0, 0, size, size).data, L = new Float32Array(size * size);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) L[j] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return L;
}
function alphaArr(c, size) {
  const t = resized(c, size, size), d = ctx2d(t).getImageData(0, 0, size, size).data, A = new Uint8Array(size * size);
  for (let i = 3, j = 0; i < d.length; i += 4, j++) A[j] = d[i]; return A;
}
/* Beste Ausrichtung (Skalierung um die Bildmitte + Verschiebung), gemessen nur auf Produktpixeln */
function align(P, A, M, n, cands) {
  const c = n / 2; let best = { cost: Infinity };
  const idx = []; for (let y = 0; y < n; y += 2) for (let x = 0; x < n; x += 2) if (M[y * n + x] > 230) idx.push(y * n + x);
  if (idx.length < 50) return { cost: Infinity };
  for (const s of cands.s) for (const dy of cands.d) for (const dx of cands.d) {
    let sum = 0, cnt = 0;
    for (const i of idx) {
      const x = i % n, y = (i / n) | 0, X = Math.round((x - c) * s + c + dx), Y = Math.round((y - c) * s + c + dy);
      if (X < 0 || Y < 0 || X >= n || Y >= n) { sum += 60; cnt++; continue; }
      sum += Math.abs(A[Y * n + X] - P[i]); cnt++;
    }
    const cost = sum / cnt; if (cost < best.cost) best = { cost, s, dx, dy };
  }
  return best;
}
const range = (a, b, st) => { const r = []; for (let v = a; v <= b + 1e-9; v += st) r.push(+v.toFixed(4)); return r; };

export function extractAiShadow(ai, placed) {
  const N = placed.layer.width, white = productOnWhite(placed);
  // 1) grob (200 px), dann fein (600 px) ausrichten
  let n = 200, P = lumArr(white, n), A = lumArr(ai, n), M = alphaArr(placed.layer, n);
  const g = align(P, A, M, n, { s: range(0.95, 1.05, 0.01), d: range(-14, 14, 1) });
  if (!(g.cost < 40)) return { ok: false, reason: 'KI-Bild passt nicht zum Produkt (Ausrichtung)', cost: g.cost };
  n = 600; P = lumArr(white, n); A = lumArr(ai, n); M = alphaArr(placed.layer, n);
  const al = alignXY(P, A, M, n, { s: g.s, dx: g.dx * 3, dy: g.dy * 3 }); // fein um die Grobposition
  if (!(al.cost < 26)) return { ok: false, reason: 'KI hat das Produkt zu stark verändert', cost: al.cost };
  // 2) KI-Bild ausgerichtet auf 1200 zeichnen
  const W = canvas(N, N), wx = W.getContext('2d'), k = N / n, cx = N / 2, s = al.s, dx = al.dx * k, dy = al.dy * k;
  wx.fillStyle = '#fff'; wx.fillRect(0, 0, N, N); wx.imageSmoothingQuality = 'high';
  wx.setTransform(1 / s, 0, 0, 1 / s, cx - (cx + dx) / s, cx - (cx + dy) / s); wx.drawImage(ai, 0, 0, N, N); wx.setTransform(1, 0, 0, 1, 0, 0);
  const d = wx.getImageData(0, 0, N, N).data, pa = ctx2d(placed.layer).getImageData(0, 0, N, N).data;
  // 3) Bereich, in dem Schatten liegen darf (rund ums Produkt, Schwerpunkt unten)
  const b = placed.box, x0 = b.x - b.w * 0.14, x1 = b.x + b.w * 1.14, y0 = b.y + b.h * 0.2, y1 = b.y + b.h * 1.2, fx = b.w * 0.07 + 8, fy = b.h * 0.07 + 8;
  const region = (x, y) => Math.min(1, Math.max(0, (x - x0) / fx), Math.max(0, (x1 - x) / fx)) * Math.min(1, Math.max(0, (y - y0) / fy), Math.max(0, (y1 - y) / fy));
  // Produkt + 4 px Rand ausschließen (dort zeichnet die KI ihr eigenes Produkt)
  const ex = new Uint8Array(N * N); for (let i = 0; i < N * N; i++) if (pa[i * 4 + 3] > 8) ex[i] = 1;
  for (let r = 0; r < 4; r++) { const e2 = ex.slice(); for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) { const i = y * N + x; if (!ex[i] && (ex[i - 1] || ex[i + 1] || ex[i - N] || ex[i + N])) e2[i] = 1; } ex.set(e2); }
  // 4) Referenz-Weiß = helle Umgebung außerhalb des Schattenbereichs
  const ref = (() => { const h = new Uint32Array(256); let n2 = 0;
    for (let y = 0; y < N; y += 3) for (let x = 0; x < N; x += 3) { const i = y * N + x; if (ex[i] || region(x, y) > 0) continue; h[Math.round(0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2])]++; n2++; }
    let acc = 0, v = 255; while (v > 0 && (acc += h[v]) < n2 * 0.1) v--; return n2 > 100 ? Math.max(v, 1) : 255; })();
  if (ref < 170) return { ok: false, reason: 'KI-Hintergrund nicht weiß', cost: al.cost };
  // 5) Schatten-Alpha
  const a = new Float32Array(N * N), filled = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x; if (ex[i]) continue; filled[i] = 1;
    const w = region(x, y); if (!w) continue;
    const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2], L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    let v = (ref - L) / ref; if (v <= 0.012) continue; v = (v - 0.012) / 0.988;
    const ch = Math.max(R, G, B) - Math.min(R, G, B); if (ch > 26) v *= Math.max(0, 1 - (ch - 26) / 24); // farbig = kein Schatten
    a[i] = Math.min(1, v) * w;
  }
  // 6) Lücke am Produktrand von außen auffüllen (sonst weißer Saum an den Kontaktstellen)
  for (let pass = 0; pass < 8; pass++) {
    const nf = []; for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const i = y * N + x; if (filled[i]) continue; let s2 = 0, c2 = 0;
      for (const j of [i - 1, i + 1, i - N, i + N]) if (filled[j]) { s2 += a[j]; c2++; }
      if (c2) nf.push([i, s2 / c2]);
    }
    if (!nf.length) break; for (const [i, v] of nf) { a[i] = v; filled[i] = 1; }
  }
  const S = canvas(N, N), sxc = ctx2d(S), img = sxc.createImageData(N, N);
  for (let i = 0; i < N * N; i++) img.data[i * 4 + 3] = Math.round(a[i] * 255);
  sxc.putImageData(img, 0, 0);
  const out = canvas(N, N), ox = out.getContext('2d'); ox.filter = 'blur(1.2px)'; ox.drawImage(S, 0, 0);
  return { ok: true, canvas: out, cost: al.cost, ref, align: { s, dx, dy } };
}
function alignXY(P, A, M, n, g) {
  const c = n / 2; let best = { cost: Infinity };
  const idx = []; for (let y = 0; y < n; y += 3) for (let x = 0; x < n; x += 3) if (M[y * n + x] > 230) idx.push(y * n + x);
  for (const s of range(g.s - 0.006, g.s + 0.006, 0.003)) for (let dy = g.dy - 4; dy <= g.dy + 4; dy++) for (let dx = g.dx - 4; dx <= g.dx + 4; dx++) {
    let sum = 0;
    for (const i of idx) { const x = i % n, y = (i / n) | 0, X = Math.round((x - c) * s + c + dx), Y = Math.round((y - c) * s + c + dy); sum += (X < 0 || Y < 0 || X >= n || Y >= n) ? 60 : Math.abs(A[Y * n + X] - P[i]); }
    const cost = sum / idx.length; if (cost < best.cost) best = { cost, s, dx, dy };
  }
  return best;
}
/* KI-Schatten mit Stärke k skalieren: a' = 1 − (1 − a)^k (bleibt weich, kann verstärken) */
export function scaleShadow(sh, k) {
  if (Math.abs(k - 1) < 0.01) return sh;
  const o = canvas(sh.width, sh.height), x = ctx2d(o); x.drawImage(sh, 0, 0);
  const img = x.getImageData(0, 0, o.width, o.height), d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) d[i] = Math.round(255 * (1 - Math.pow(1 - d[i] / 255, k)));
  x.putImageData(img, 0, 0); return o;
}

/* Produkt vorbereiten: Tonwerte, Einpassen, Schärfen */
export function prepareProduct(cut, s) {
  const src = canvas(cut.width, cut.height); src.getContext('2d').drawImage(cut, 0, 0);
  if (s.toneOn && s.tone) applyTone(src, s.tone);
  const placed = placeProduct(src, { offsetY: s.offsetY || 0 });
  sharpen(placed.layer, s.toneOn && s.tone ? (s.tone.sharpen ?? 0.2) : 0.15, 0.9, s.edgeSharpen ?? 0.7);
  return placed;
}
export const AI_SHADOW_GAIN = 1.3; // KI-Schatten sind eher zart – Grundverstärkung

/* Kompletter Render-Durchlauf. aiShadow = extrahierte KI-Schattenebene (1200×1200) oder null */
export function renderFinal(cut, s, aiShadow) {
  const placed = prepareProduct(cut, s);
  let sh;
  if (s.shadowSource === 'ai' && aiShadow) sh = { canvas: scaleShadow(aiShadow, (s.strength ?? 1) * AI_SHADOW_GAIN), contacts: [], source: 'KI' };
  else sh = buildShadow(placed, { mode: s.shadowMode, light: s.light, strength: s.strength, contacts: { manual: s.manualContacts, ai: s.aiContacts } });
  return { placed, shadow: sh, jpg: compose(placed, sh.canvas, '#ffffff'), png: compose(placed, sh.canvas, null) };
}
