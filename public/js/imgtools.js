/* Bild-Helfer im Browser: laden, zuschneiden, Weiß-Hintergrund entfernen, exportieren */
export function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => rej(new Error('Bild nicht ladbar: ' + src)); im.src = src;
  });
}
export function toCanvas(img, maxSide = 0) {
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (maxSide && Math.max(w, h) > maxSide) { const s = maxSide / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h); return c;
}
/* Transparente Ränder abschneiden */
export function trimAlpha(c, thr = 10, pad = 2) {
  const ctx = c.getContext('2d', { willReadFrequently: true }), { width: w, height: h } = c;
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return c;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const o = document.createElement('canvas'); o.width = x1 - x0 + 1; o.height = y1 - y0 + 1;
  o.getContext('2d').drawImage(c, x0, y0, o.width, o.height, 0, 0, o.width, o.height); return o;
}
/* Hat das Bild schon Transparenz? */
export function hasAlpha(c) {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] < 200) n++;
  return n > d.length / 16 * 0.02;
}
/* Fallback ohne Kie: hellen Hintergrund vom Rand her per Flood-Fill entfernen (für Produktfotos auf Weiß) */
export function removeLightBackground(c, tol = 22) {
  const w = c.width, h = c.height, ctx = c.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  // Referenzfarbe = Median der Randpixel
  const border = [];
  for (let x = 0; x < w; x += 4) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y += 4) border.push(y * w, y * w + w - 1);
  const lum = i => d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2];
  const sorted = border.map(i => lum(i)).sort((a, b) => a - b); const ref = sorted[Math.floor(sorted.length / 2)];
  const refPix = border.find(i => lum(i) === ref) ?? 0;
  const R = d[refPix * 4], G = d[refPix * 4 + 1], B = d[refPix * 4 + 2];
  const close = i => Math.abs(d[i * 4] - R) + Math.abs(d[i * 4 + 1] - G) + Math.abs(d[i * 4 + 2] - B) < tol * 3;
  const seen = new Uint8Array(w * h), stack = border.filter(close);
  while (stack.length) {
    const i = stack.pop(); if (seen[i]) continue; seen[i] = 1;
    if (!close(i)) continue;
    d[i * 4 + 3] = 0;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1); if (x < w - 1) stack.push(i + 1); if (y > 0) stack.push(i - w); if (y < h - 1) stack.push(i + w);
  }
  // Kante weich: Pixel neben transparenten halbtransparent
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x; if (d[i * 4 + 3] === 0) continue;
    if (!d[(i - 1) * 4 + 3] || !d[(i + 1) * 4 + 3] || !d[(i - w) * 4 + 3] || !d[(i + w) * 4 + 3]) d[i * 4 + 3] = 140;
  }
  ctx.putImageData(img, 0, 0); return c;
}
export const toBlob = (c, type = 'image/png', q) => new Promise(r => c.toBlob(r, type, q));
export function thumbDataUrl(c, max = 512) {
  const s = Math.min(1, max / Math.max(c.width, c.height)), t = document.createElement('canvas');
  t.width = Math.round(c.width * s); t.height = Math.round(c.height * s);
  const x = t.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, t.width, t.height); x.drawImage(c, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.82);
}
export function shapeOf(aspect) { return aspect > 2 ? 'long' : aspect < 0.62 ? 'tall' : 'compact'; }
export function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
