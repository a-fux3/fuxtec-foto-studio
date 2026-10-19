/* FUXTEC Foto Studio – Bulk-Pipeline: Upload → Analyse → Retusche (+QA) → Freistellen → Tonwerte/Rahmen/Schatten → JPG + PNG */
import * as fx from './photofx.js';
import { removeLightBackground } from './imgtools.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WORK_MAX = 2400;          // Arbeitsauflösung (reicht für 900 px Produkt, bleibt unter Kie-Limits)
const STEPS = { queued: 'Wartet', prep: 'Vorbereiten', upload: 'Hochladen', analyze: 'KI-Analyse', retouch: 'Retusche', qa: 'Qualitätskontrolle', cutout: 'Freistellen', shadow: 'KI-Schatten', render: 'Schatten & Export', done: 'Fertig', error: 'Fehler' };

let CFG = { kie: false, claude: false };
const items = []; let running = 0, current = null;
const opt = () => ({
  retouch: document.querySelector('input[name=retouch]:checked').value,
  editModel: document.querySelector('input[name=editModel]:checked').value,
  conc: +document.querySelector('input[name=conc]:checked').value,
  strength: +$('#strength').value / 100,
  qa: $('#qa').checked,
  shadowSrc: document.querySelector('input[name=shadowSrc]:checked')?.value || 'ai',
  shadowModel: document.querySelector('input[name=shadowModel]:checked')?.value || 'nano-banana-2'
});
const SHADOW_MODEL_LABEL = { 'nano-banana-2': 'Nano Banana 2', 'nano-banana-2-1': 'Nano Banana 2.1', 'nano-banana-pro': 'NB Pro', 'gpt-image-2-5-flare-image-to-image': 'GPT Image 2.5' };

/* ---------------- Start ---------------- */
init();
async function init() {
  try { const p = await (await fetch('/assets/logo/fuxkopf_path.txt')).text(); $('#brandLogo').innerHTML = `<path fill-rule="evenodd" d="${p}"/>`; } catch { }
  try { CFG = await api('/api/photo/config'); } catch (e) { toast('Konfiguration nicht ladbar: ' + e.message, true); }
  $('#status').innerHTML = `<span class="pill ${CFG.claude ? 'on' : 'off'}">Claude${CFG.claude ? '' : ' fehlt'}</span><span class="pill ${CFG.kie ? 'on' : 'off'}">Kie${CFG.kie ? '' : ' fehlt'}</span>`;
  if (!CFG.kie || !CFG.claude) toast('Testmodus: ohne Kie/Claude wird nur lokal freigestellt (Weiß-Hintergrund), keine KI-Analyse/Retusche.', true);
  if (CFG.editModel) { const r = document.querySelector(`input[name=editModel][value="${CFG.editModel}"]`); if (r) r.checked = true; }
  try { const s = JSON.parse(localStorage.getItem('foto-opts') || '{}');
    for (const [k, v] of Object.entries(s)) { const r = document.querySelector(`input[name=${k}][value="${v}"]`); if (r) r.checked = true; }
    if (s.strength != null) $('#strength').value = s.strength; if (s.qa != null) $('#qa').checked = s.qa;
  } catch { }
  $('#strengthOut').textContent = $('#strength').value + ' %';
  document.querySelector('.fbar-opts').addEventListener('change', saveOpts);
  $('#strength').addEventListener('input', () => { $('#strengthOut').textContent = $('#strength').value + ' %'; });
  $('#strength').addEventListener('change', async () => { // globale Stärke auf alle ohne eigene Einstellung übertragen
    for (const it of items) { if (it.r.ownStrength) continue; it.r.strength = opt().strength; if (it.status === 'done') await rerender(it); }
  });

  const drop = $('#drop'), fin = $('#fileIn');
  fin.addEventListener('change', () => { addFiles(fin.files); fin.value = ''; });
  ['dragenter', 'dragover'].forEach(e => document.addEventListener(e, ev => { if ([...(ev.dataTransfer?.types || [])].includes('Files')) { ev.preventDefault(); drop.classList.add('over'); } }));
  ['dragleave', 'drop'].forEach(e => document.addEventListener(e, ev => { if (e === 'dragleave' && ev.relatedTarget) return; drop.classList.remove('over'); }));
  document.addEventListener('drop', ev => { if (!ev.dataTransfer?.files?.length) return; ev.preventDefault(); addFiles(ev.dataTransfer.files); });

  $('#zipBtn').onclick = zipAll;
  $('#clearBtn').onclick = () => {
    if (running && !confirm('Es laufen noch Bilder. Trotzdem alles leeren?')) return;
    for (const it of items) it.cancelled = true; items.length = 0; $('#grid').innerHTML = ''; updateProgress();
  };
  window.addEventListener('beforeunload', e => { if (items.some(i => i.status !== 'error' && !i.zipped)) { e.preventDefault(); e.returnValue = ''; } });
  initDetail();
}
function saveOpts() {
  const o = opt(); try { localStorage.setItem('foto-opts', JSON.stringify({ retouch: o.retouch, editModel: o.editModel, conc: o.conc, strength: $('#strength').value, qa: o.qa, shadowSrc: o.shadowSrc, shadowModel: o.shadowModel })); } catch { }
  pump();
}

/* ---------------- Warteschlange ---------------- */
function addFiles(list) {
  const files = [...list].filter(f => /^image\/(jpeg|png|webp|tiff)$/.test(f.type) || /\.(jpe?g|png|webp|tiff?)$/i.test(f.name));
  const skipped = list.length - files.length;
  if (skipped) toast(`${skipped} Datei(en) übersprungen (nur JPG, PNG, WebP, TIFF – HEIC bitte vorher umwandeln).`, true);
  for (const f of files) {
    const base = f.name.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').trim() || 'bild';
    const it = { id: Math.random().toString(36).slice(2, 10), file: f, name: f.name, base, status: 'queued', log: [],
      r: { toneOn: true, shadowMode: 'floor', light: 'center', strength: opt().strength, useRetouch: true, shadowSource: opt().shadowSrc } };
    items.push(it); $('#grid').append(card(it));
  }
  updateProgress(); pump();
}
function pump() {
  const max = opt().conc;
  while (running < max) {
    const it = items.find(i => i.status === 'queued'); if (!it) break;
    running++; it.status = 'prep';
    process(it).catch(e => fail(it, e)).finally(() => { running--; updateProgress(); pump(); });
  }
  updateProgress();
}
function fail(it, e) {
  if (it.cancelled) return;
  console.error(it.name, e); it.status = 'error'; it.error = e.message || String(e); paint(it);
}
const step = (it, s, sub) => { if (it.cancelled) throw new Error('abgebrochen'); it.status = s; it.sub = sub || ''; paint(it); };

/* ---------------- Speicher ----------------
 * Große Canvas-Daten werden nicht pro Bild gehalten (100 Bilder × 2400 px würden den Tab sprengen):
 * Freisteller/Retusche liegen als komprimierte Blobs am Bild, dekodiert wird bei Bedarf über einen kleinen Cache. */
const cache = new Map(); const CACHE_MAX = 8;
async function cached(key, make) {
  if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
  const v = await make(); cache.set(key, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return v;
}
const blobCanvas = async (blob, max = 0) => { const bm = await fx.loadBitmap(blob); const c = max ? fx.fitMax(bm, max) : null; if (c && c !== bm) return c; const o = fx.canvas(bm.width, bm.height); o.getContext('2d').drawImage(bm, 0, 0); return o; };
const getWork = it => cached(it.id + ':work', () => blobCanvas(it.src || it.file, WORK_MAX));
const getRet = it => it.retouch?.blob ? cached(it.id + ':ret:' + it.retouch.url, () => blobCanvas(it.retouch.blob)) : null;
const getCut = it => cached(it.id + ':cut:' + it.cutKey, () => blobCanvas(it.cutBlobs[it.cutKey], 1800));
function dropCache(it) { for (const k of [...cache.keys()]) if (k.startsWith(it.id + ':')) cache.delete(k); }

/* Eingangsdatei einmal lesen: Originalmaße merken; TIFF & Co. (vom Browser nicht lesbar) in eine
 * Arbeitsdatei (max. 2400 px, JPG bzw. PNG bei Transparenz) umwandeln, damit nicht jedes Mal neu dekodiert wird */
let tiffLock = Promise.resolve();
async function normalizeInput(it) {
  const tiff = await fx.isTiff(it.file);
  if (tiff) { // große TIFFs (45 MP, 16 Bit) nacheinander dekodieren, sonst wird der Speicher knapp
    step(it, 'prep', 'TIFF wartet');
    const prev = tiffLock; let release; tiffLock = new Promise(r => (release = r));
    await prev;
    try { step(it, 'prep', 'TIFF wird gelesen'); await sleep(30); return await readInput(it, true); } finally { release(); }
  }
  return readInput(it, false);
}
async function readInput(it, tiff) {
  const bm = await fx.loadBitmap(it.file);
  it.w = bm.width; it.h = bm.height;
  if (!tiff) { bm.close?.(); it.src = it.file; return; }
  const c = fx.fitMax(bm, WORK_MAX), alpha = fx.hasAlpha(c);
  it.src = alpha ? await fx.toBlob(c, 'image/png') : await fx.toBlob(c, 'image/jpeg', 0.95);
  if (bm !== c && bm.width) { bm.width = 0; bm.height = 0; } // großen Puffer sofort freigeben
  it.log.push(`TIFF ${it.w}×${it.h}px eingelesen`);
}

/* ---------------- Pipeline pro Bild ---------------- */
async function process(it) {
  const o = opt();
  step(it, 'prep');
  if (!it.src) await normalizeInput(it);
  const work = await getWork(it);
  if (!it.thumb) {
    it.alphaIn = fx.hasAlpha(work);
    it.thumb = fx.jpegDataUrl(work, 480, 0.8); paint(it);
  }
  const live = CFG.kie && CFG.claude;

  // 1) Upload zu Kie (24 h gültig)
  if (live && !it.alphaIn) await ensureUpload(it);

  // 2) Analyse
  if (!it.analysis) {
    step(it, 'analyze');
    const a = live ? await api('/api/photo/analyze', { image: fx.jpegDataUrl(work, 1400, 0.86), name: it.name, width: it.w, height: it.h }) : { mock: true };
    it.analysis = a.mock ? mockAnalysis() : a;
    if (a._fallback) it.log.push(`Analyse mit ${a._fallback.to} (Fallback)`);
    it.r.tone = { ...it.analysis.tone }; it.r.shadowMode = it.analysis.shadow.mode; it.r.light = it.analysis.shadow.light;
    it.r.aiContacts = it.analysis.shadow.contacts || [];
  }

  // 3) Retusche (nur wenn die KI Makel findet)
  if (live && !it.alphaIn && o.retouch === 'auto' && it.analysis.retouch_needed && !it.retouch) await runRetouch(it, { qa: o.qa, model: o.editModel });

  // 4) Freistellen
  await ensureCutout(it);

  // 5) KI-Schatten (Bild-KI malt den Schatten, übernommen wird nur der Schatten)
  if (it.r.shadowSource === 'ai') await ensureAiShadow(it);

  // 5) Tonwerte, Rahmen, Schatten
  step(it, 'render'); await rerender(it);
  it.status = 'done'; paint(it);
}
async function ensureUpload(it) {
  if (it.origUrl && Date.now() - it.origAt < 20 * 3600e3) return;
  step(it, 'upload');
  it.origUrl = (await api('/api/photo/upload', { base64Data: fx.jpegDataUrl(await getWork(it), WORK_MAX, 0.93), uploadPath: 'fuxtec-foto', fileName: `${it.id}-orig.jpg` })).url;
  it.origAt = Date.now();
}

async function runRetouch(it, { qa, model, extra }) {
  const fixes = it.analysis.fixes || [];
  let strict = '', last = null;
  for (let attempt = 1; attempt <= (qa ? 2 : 1); attempt++) {
    step(it, 'retouch', attempt > 1 ? '2. Versuch' : '');
    const t = await api('/api/photo/retouch', { imageUrl: it.origUrl, fixes, extra, strict, model });
    const url = await pollTask(it, t.taskId);
    const blob = await fetchBlob(url);
    last = { url, blob, model: t.model, attempt, extra };
    if (!qa) break;
    step(it, 'qa');
    const can = await blobCanvas(blob, 1100);
    const q = await api('/api/photo/qa', { original: fx.jpegDataUrl(await getWork(it), 1100, 0.85), retouched: fx.jpegDataUrl(can, 1100, 0.85), fixes: extra ? [...fixes, extra] : fixes });
    last.qa = q.mock ? null : q;
    if (q.mock || q.accept) break;
    strict = [q.reason, q.retry_hint].filter(Boolean).join(' – ');
  }
  const ok = !last.qa || last.qa.accept;
  it.retouch = { ...last, accepted: ok };
  it.r.useRetouch = ok;
  if (it.cutBlobs) delete it.cutBlobs.ret;
  it.log.push(ok ? `Retusche übernommen (Versuch ${last.attempt})` : 'Retusche verworfen: ' + (last.qa?.reason || ''));
}

async function ensureCutout(it) {
  const useRet = it.r.useRetouch && it.retouch?.url;
  const key = useRet ? 'ret' : 'orig';
  it.cutBlobs = it.cutBlobs || {};
  if (!it.cutBlobs[key]) {
    step(it, 'cutout');
    if (it.alphaIn) it.cutBlobs[key] = it.src;
    else if (CFG.kie && CFG.claude) {
      const t = await api('/api/photo/cutout', { imageUrl: useRet ? it.retouch.url : it.origUrl });
      it.cutBlobs[key] = await fetchBlob(await pollTask(it, t.taskId));
    } else {
      const w = await getWork(it), c = fx.canvas(w.width, w.height); c.getContext('2d').drawImage(w, 0, 0);
      it.cutBlobs[key] = await fx.toBlob(removeLightBackground(c), 'image/png');
    }
  }
  it.cutKey = key;
}

const aiShadowFresh = it => it.aiShadow && it.aiShadow.key === it.cutKey;
async function ensureAiShadow(it, { force = false, model } = {}) {
  const r = it.r;
  if (!(CFG.kie && CFG.claude) || r.shadowMode === 'none') { r.shadowSource = 'calc'; return; }
  if (aiShadowFresh(it) && !force) return;
  step(it, 'shadow');
  const placed = fx.prepareProduct(await getCut(it), r);
  const up = await api('/api/photo/upload', { base64Data: fx.jpegDataUrl(fx.productOnWhite(placed), 1200, 0.94), uploadPath: 'fuxtec-foto', fileName: `${it.id}-weiss.jpg` });
  const t = await api('/api/photo/shadow', { imageUrl: up.url, mode: r.shadowMode, light: r.light, model: model || opt().shadowModel });
  const ai = await blobCanvas(await fetchBlob(await pollTask(it, t.taskId)));
  const big = fx.canvas(placed.layer.width, placed.layer.height); big.getContext('2d').drawImage(ai, 0, 0, big.width, big.height);
  await sleep(0);
  const ex = fx.extractAiShadow(big, placed);
  if (!ex.ok) {
    it.log.push(`KI-Schatten (${SHADOW_MODEL_LABEL[t.model] || t.model}) verworfen: ${ex.reason} – berechneter Schatten`);
    it.aiShadowFail = ex.reason; r.shadowSource = 'calc'; return;
  }
  it.aiShadow = { key: it.cutKey, blob: await fx.toBlob(ex.canvas, 'image/png'), model: t.model, cost: ex.cost, at: Date.now() };
  it.aiShadowFail = null;
  it.log.push(`KI-Schatten: ${SHADOW_MODEL_LABEL[t.model] || t.model} (Abweichung Produkt ${ex.cost.toFixed(1)})`);
}

async function rerender(it) {
  if (!it.cutBlobs?.[it.cutKey]) return;
  const r = it.r, cut = await getCut(it);
  const aiSh = r.shadowSource === 'ai' && aiShadowFresh(it) ? await cached(it.id + ':sh:' + it.aiShadow.at, () => blobCanvas(it.aiShadow.blob)) : null;
  const out = fx.renderFinal(cut, { ...r, manualContacts: r.manualContacts, aiContacts: r.aiContacts }, aiSh);
  it.resultThumb = fx.jpegDataUrl(out.jpg, 480, 0.82);
  it.contacts = out.shadow.contacts; it.contactSource = out.shadow.source;
  it.zipped = false; paint(it);
  if (current === it) { it.out = out; drawDetail(); } else it.out = null;
  return out;
}
const ensureOut = async it => it.out || await rerender(it);

/* ---------------- Kie / API ---------------- */
async function api(path, body) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    let j = {}; try { j = await r.json(); } catch { }
    if (r.ok) return j;
    const msg = j.error || `HTTP ${r.status}`;
    if (attempt < 2 && (r.status === 429 || r.status >= 500) && !/401|402|Guthaben|credit/i.test(msg)) { await sleep(4000 * (attempt + 1)); continue; }
    throw new Error(msg);
  }
}
async function pollTask(it, id, timeout = 300000) {
  const t0 = Date.now();
  for (;;) {
    if (it.cancelled) throw new Error('abgebrochen');
    await sleep(2500);
    const t = await api('/api/photo/task/' + id);
    if (t.state === 'success' && t.urls?.[0]) return t.urls[0];
    if (t.state === 'fail') throw new Error('Kie: ' + (t.error || 'fehlgeschlagen'));
    if (Date.now() - t0 > timeout) throw new Error('Kie: Zeitüberschreitung');
  }
}
async function fetchBlob(url) {
  for (let i = 0; ; i++) {
    const r = await fetch('/api/photo/fetch?url=' + encodeURIComponent(url));
    if (r.ok) return r.blob();
    if (i >= 2) throw new Error('Ergebnis nicht ladbar (' + r.status + ')');
    await sleep(3000);
  }
}
function mockAnalysis() {
  return { mock: true, product: 'Testmodus (keine KI)', category: 'sonstiges', quality: 0, issues: [], warnings: [], retouch_needed: false, fixes: [],
    tone: { exposure: 0, contrast: 0.05, shadows: 0, highlights: 0, saturation: 0, warmth: 0, sharpen: 0.25, levels: true }, shadow: { mode: 'floor', light: 'center', contacts: [] } };
}

/* ---------------- Karten ---------------- */
function card(it) {
  const el = document.createElement('article'); el.className = 'fcard'; el.id = 'c-' + it.id;
  el.innerHTML = `<div class="fc-img"></div><div class="fc-meta"><b class="fc-name"></b><span class="fc-step"></span><div class="fc-tags"></div></div>
    <div class="fc-act"><button class="btn icon ghost fc-retry" title="Erneut versuchen"><svg class="i"><use href="#i-refresh"/></svg></button><button class="btn icon ghost fc-del" title="Entfernen"><svg class="i"><use href="#i-x"/></svg></button></div>`;
  el.querySelector('.fc-img').onclick = () => it.status === 'done' && openDetail(it);
  el.querySelector('.fc-retry').onclick = e => { e.stopPropagation(); it.status = 'queued'; it.error = ''; paint(it); pump(); };
  el.querySelector('.fc-del').onclick = e => { e.stopPropagation(); it.cancelled = true; items.splice(items.indexOf(it), 1); el.remove(); updateProgress(); };
  paint(it, el); return el;
}
function paint(it, el = document.getElementById('c-' + it.id)) {
  if (!el) return;
  el.dataset.status = it.status;
  const img = el.querySelector('.fc-img'), src = it.resultThumb || it.thumb;
  if (src && img.dataset.src !== src) { img.innerHTML = `<img src="${src}" alt="">`; img.dataset.src = src; }
  img.classList.toggle('busy', !['done', 'error', 'queued'].includes(it.status));
  el.querySelector('.fc-name').textContent = it.name;
  el.querySelector('.fc-step').textContent = it.status === 'error' ? it.error : STEPS[it.status] + (it.sub ? ' · ' + it.sub : '');
  const a = it.analysis, tags = [];
  if (a && !a.mock) tags.push(`<span class="tag">${esc(a.product)}</span>`);
  if (it.retouch) tags.push(it.retouch.accepted ? '<span class="tag ok">Retuschiert</span>' : '<span class="tag warn">Retusche verworfen</span>');
  else if (a && !a.mock && !a.retouch_needed) tags.push('<span class="tag">Keine Retusche nötig</span>');
  if (it.status === 'done') tags.push(it.r.shadowSource === 'ai' && aiShadowFresh(it) ? '<span class="tag ok">KI-Schatten</span>' : it.aiShadowFail ? `<span class="tag warn" title="${esc(it.aiShadowFail)}">Schatten berechnet</span>` : '');
  if (a?.warnings?.length) tags.push(`<span class="tag warn" title="${esc(a.warnings.join('\n'))}"><svg class="i"><use href="#i-alert"/></svg>${a.warnings.length}</span>`);
  el.querySelector('.fc-tags').innerHTML = tags.join('');
  el.querySelector('.fc-retry').hidden = it.status !== 'error';
}
function updateProgress() {
  const done = items.filter(i => i.status === 'done').length, err = items.filter(i => i.status === 'error').length;
  $('#progressTxt').textContent = items.length ? `${done}/${items.length} fertig${err ? ` · ${err} Fehler` : ''}${running ? ` · ${running} in Arbeit` : ''}` : '';
  $('#zipBtn').disabled = !done;
  document.body.classList.toggle('has-items', items.length > 0);
}

/* ---------------- Export ---------------- */
async function outBlobs(it) {
  const out = await ensureOut(it);
  return { jpg: await fx.toBlob(out.jpg, 'image/jpeg', 0.93), png: await fx.toBlob(out.png, 'image/png') };
}
async function zipAll() {
  const done = items.filter(i => i.status === 'done'); if (!done.length) return;
  const btn = $('#zipBtn'); btn.disabled = true; const label = btn.innerHTML; btn.textContent = 'ZIP wird erstellt …';
  try {
    const zip = new JSZip(), used = new Set(), rows = [['Datei', 'Produkt', 'Retusche', 'QA', 'Hinweise', 'Probleme']];
    for (const it of done) {
      let n = it.base, k = 2; while (used.has(n.toLowerCase())) n = `${it.base}_${k++}`; used.add(n.toLowerCase());
      const b = await outBlobs(it);
      zip.file(`JPG/${n}.jpg`, b.jpg); zip.file(`PNG/${n}.png`, b.png);
      const a = it.analysis || {};
      rows.push([n, a.product || '', it.retouch ? (it.r.useRetouch ? 'ja' : 'verworfen') : 'nein', it.retouch?.qa ? `${it.retouch.qa.score}/10 ${it.retouch.qa.reason}` : '', (a.warnings || []).join(' | '), (a.issues || []).join(' | ')]);
      it.zipped = true;
    }
    zip.file('protokoll.csv', '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n'));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    download(blob, `FUXTEC_Produktfotos_${new Date().toISOString().slice(0, 10)}.zip`);
    toast(`${done.length} Bilder exportiert.`);
  } catch (e) { toast('ZIP fehlgeschlagen: ' + e.message, true); }
  finally { btn.innerHTML = label; btn.disabled = false; }
}
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

/* ---------------- Detailansicht ---------------- */
const TONE_UI = [['exposure', 'Belichtung', -1, 1, 0.05], ['contrast', 'Kontrast', -0.5, 0.5, 0.05], ['shadows', 'Tiefen', 0, 0.6, 0.05], ['highlights', 'Lichter', -0.6, 0, 0.05],
  ['saturation', 'Sättigung', -0.5, 0.5, 0.05], ['warmth', 'Wärme', -0.5, 0.5, 0.05], ['sharpen', 'Schärfe', 0, 1, 0.05]];
function initDetail() {
  const dlg = $('#detail');
  $('#dClose').onclick = () => dlg.close();
  dlg.addEventListener('close', () => { if (current) { current.out = null; current.view = null; } current = null; });
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  const nav = d => { const list = items.filter(i => i.status === 'done'); const i = list.indexOf(current); if (i >= 0 && list[i + d]) openDetail(list[i + d]); };
  $('#dPrev').onclick = () => nav(-1); $('#dNext').onclick = () => nav(1);
  dlg.addEventListener('keydown', e => { if (e.target.matches('input,textarea')) return; if (e.key === 'ArrowLeft') nav(-1); if (e.key === 'ArrowRight') nav(1); });
  document.querySelectorAll('input[name=view]').forEach(r => r.onchange = drawDetail);
  $('#dFrame').onchange = drawDetail; $('#dEditContacts').onchange = drawDetail;
  $('#dResetContacts').onclick = () => { if (!current) return; current.r.manualContacts = null; rerender(current).then(renderSide); };
  $('#dCanvas').addEventListener('click', e => {
    if (!current?.out || !$('#dEditContacts').checked || viewMode() !== 'jpg' && viewMode() !== 'png') return;
    if (current.r.shadowSource === 'ai') return toast('Bodenpunkte gelten nur für den berechneten Schatten – rechts auf „Berechnet“ umstellen.', true);
    const c = e.currentTarget, rect = c.getBoundingClientRect(); // object-fit: contain → Letterbox herausrechnen
    const k = Math.min(rect.width / c.width, rect.height / c.height), ox = (rect.width - c.width * k) / 2, oy = (rect.height - c.height * k) / 2;
    const p = { x: (e.clientX - rect.left - ox) / k, y: (e.clientY - rect.top - oy) / k };
    const pts = (current.r.manualContacts || current.out.shadow.contacts || []).map(q => ({ x: q.x, y: q.y }));
    const hit = pts.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) < 28);
    if (hit >= 0) pts.splice(hit, 1); else pts.push(p);
    current.r.manualContacts = pts; current.r.shadowMode = 'floor'; rerender(current).then(renderSide);
  });
}
const viewMode = () => document.querySelector('input[name=view]:checked').value;
async function openDetail(it) {
  if (current && current !== it) { current.out = null; current.view = null; }
  current = it; $('#dTitle').textContent = it.name;
  await ensureOut(it);
  it.view = { work: await getWork(it), ret: await getRet(it) };
  if (current !== it) return;
  $('#dSub').textContent = `${it.w}×${it.h}px`;
  document.querySelector('input[name=view][value=ret]').disabled = !it.retouch;
  if (!it.retouch && viewMode() === 'ret') document.querySelector('input[name=view][value=jpg]').checked = true;
  renderSide(); drawDetail();
  if (!$('#detail').open) $('#detail').showModal();
}
function drawDetail() {
  const it = current; if (!it?.out) return;
  const c = $('#dCanvas'), v = viewMode(), x = c.getContext('2d');
  const src = v === 'png' ? it.out.png : v === 'orig' ? it.view?.work : v === 'ret' ? it.view?.ret : it.out.jpg;
  if (!src) return;
  c.width = src.width; c.height = src.height; x.clearRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0);
  $('#dCanvasWrap').classList.toggle('checker', v === 'png');
  $('#dCanvasWrap').classList.toggle('edit', $('#dEditContacts').checked && (v === 'jpg' || v === 'png'));
  if ((v === 'jpg' || v === 'png')) {
    if ($('#dFrame').checked) { x.save(); x.strokeStyle = 'rgba(254,138,0,.9)'; x.setLineDash([10, 8]); x.lineWidth = 2; x.strokeRect(150, 150, 900, 900); x.restore(); }
    if ($('#dEditContacts').checked) for (const p of it.out.shadow.contacts || []) {
      x.beginPath(); x.arc(p.x, p.y, 9, 0, Math.PI * 2); x.fillStyle = 'rgba(254,138,0,.95)'; x.fill(); x.lineWidth = 3; x.strokeStyle = '#fff'; x.stroke();
    }
  }
}
function renderSide() {
  const it = current, a = it.analysis || {}, r = it.r, s = $('#dSide');
  const list = (arr, cls = '') => arr?.length ? `<ul class="fd-list ${cls}">${arr.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="hint">–</p>';
  const q = it.retouch?.qa;
  s.innerHTML = `
    <section><h3>KI-Analyse</h3>
      ${a.mock ? '<p class="hint">Testmodus – keine KI-Analyse.</p>' : `<p class="fd-prod">${esc(a.product)} <span class="hint">· Rohfoto ${a.quality}/10</span></p>${list(a.issues)}`}
      ${a.warnings?.length ? `<div class="fd-warn"><svg class="i"><use href="#i-alert"/></svg>${a.warnings.map(esc).join('<br>')}</div>` : ''}
    </section>
    <section><h3>Retusche</h3>
      ${it.retouch ? `<p class="hint">${esc(it.retouch.model)} · Versuch ${it.retouch.attempt}${q ? ` · QA ${q.score}/10: ${esc(q.reason)}` : ''}</p>` : `<p class="hint">${a.retouch_needed ? 'Vorgeschlagen, aber nicht ausgeführt.' : 'Nicht nötig.'}</p>`}
      ${a.fixes?.length ? list(a.fixes, 'en') : ''}
      ${it.retouch ? `<label class="tgl small"><input type="checkbox" id="sUseRet" ${r.useRetouch ? 'checked' : ''}><span class="sw"></span><span><b>Retusche verwenden</b><small>Aus = Original freistellen</small></span></label>` : ''}
      ${CFG.kie && !it.alphaIn ? `<textarea id="sExtra" rows="2" placeholder="Eigene Anweisung (Englisch oder Deutsch), z. B. „Falte am Seitenteil links glätten“"></textarea>
      <button class="btn" id="sRetouch"><svg class="i"><use href="#i-wand"/></svg>${it.retouch ? 'Retusche neu' : 'Retusche ausführen'}</button>` : ''}
    </section>
    <section><h3>Farbe & Licht <label class="tgl inline"><input type="checkbox" id="sToneOn" ${r.toneOn ? 'checked' : ''}><span class="sw"></span></label></h3>
      <div class="fd-sliders">${TONE_UI.map(([k, l, mi, ma, st]) => `<label class="rng"><span>${l}<output>${(+(r.tone?.[k] ?? 0)).toFixed(2)}</output></span><input type="range" data-tone="${k}" min="${mi}" max="${ma}" step="${st}" value="${r.tone?.[k] ?? 0}"></label>`).join('')}</div>
      <label class="tgl small"><input type="checkbox" id="sLevels" ${r.tone?.levels ? 'checked' : ''}><span class="sw"></span><span><b>Tonwertkorrektur (Schwarz-/Weißpunkt)</b></span></label>
      <button class="btn ghost" id="sToneReset">KI-Werte wiederherstellen</button>
    </section>
    <section><h3>Schatten</h3>
      ${CFG.kie && CFG.claude ? `<div class="seg"><label><input type="radio" name="sSrc" value="ai" ${r.shadowSource === 'ai' ? 'checked' : ''}><span>KI-Schatten</span></label><label><input type="radio" name="sSrc" value="calc" ${r.shadowSource !== 'ai' ? 'checked' : ''}><span>Berechnet</span></label></div>` : ''}
      ${r.shadowSource === 'ai' ? `<p class="hint">${aiShadowFresh(it) ? `${esc(SHADOW_MODEL_LABEL[it.aiShadow.model] || it.aiShadow.model)} · nur der Schatten wird übernommen, das Produkt bleibt unverändert.` : 'Noch kein KI-Schatten für diese Version.'}</p>
      <div class="seg" id="sShModel">${Object.entries(SHADOW_MODEL_LABEL).map(([k, l]) => `<label><input type="radio" name="sShModel" value="${k}" ${(it.aiShadow?.model || opt().shadowModel) === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <button class="btn" id="sShadowNew"><svg class="i"><use href="#i-refresh"/></svg>KI-Schatten neu erzeugen</button>` : ''}
      ${it.aiShadowFail && r.shadowSource !== 'ai' ? `<div class="fd-warn"><svg class="i"><use href="#i-alert"/></svg>KI-Schatten verworfen: ${esc(it.aiShadowFail)}</div>` : ''}
      <div class="seg" ${r.shadowSource === 'ai' ? 'hidden' : ''}><label><input type="radio" name="sMode" value="floor" ${r.shadowMode === 'floor' ? 'checked' : ''}><span>Boden</span></label><label><input type="radio" name="sMode" value="flat" ${r.shadowMode === 'flat' ? 'checked' : ''}><span>Flach</span></label><label><input type="radio" name="sMode" value="none" ${r.shadowMode === 'none' ? 'checked' : ''}><span>Ohne</span></label></div>
      <div class="seg" ${r.shadowSource === 'ai' ? 'hidden' : ''}><label><input type="radio" name="sLight" value="left" ${r.light === 'left' ? 'checked' : ''}><span>Licht links</span></label><label><input type="radio" name="sLight" value="center" ${r.light === 'center' ? 'checked' : ''}><span>Mitte</span></label><label><input type="radio" name="sLight" value="right" ${r.light === 'right' ? 'checked' : ''}><span>rechts</span></label></div>
      <label class="rng"><span>Stärke<output>${Math.round(r.strength * 100)} %</output></span><input type="range" id="sStrength" min="0" max="200" step="5" value="${Math.round(r.strength * 100)}"></label>
      ${r.shadowSource !== 'ai' ? `<p class="hint">Bodenpunkte: ${it.contactSource || '–'} (${it.contacts?.length || 0})</p>` : ''}
    </section>
    <section class="fd-dl">
      <button class="btn" id="sJpg"><svg class="i"><use href="#i-download"/></svg>JPG</button>
      <button class="btn" id="sPng"><svg class="i"><use href="#i-download"/></svg>PNG</button>
    </section>
    ${it.log.length ? `<section><h3>Protokoll</h3>${list(it.log)}</section>` : ''}`;

  const re = () => rerender(it);
  s.querySelectorAll('[data-tone]').forEach(inp => inp.oninput = () => { r.tone = { ...r.tone, [inp.dataset.tone]: +inp.value }; inp.previousElementSibling.querySelector('output').textContent = (+inp.value).toFixed(2); r.toneOn = true; $('#sToneOn').checked = true; schedule(re); });
  $('#sToneOn').onchange = e => { r.toneOn = e.target.checked; re(); };
  $('#sLevels').onchange = e => { r.tone = { ...r.tone, levels: e.target.checked }; re(); };
  $('#sToneReset').onclick = () => { r.tone = { ...it.analysis.tone }; r.toneOn = true; re(); renderSide(); };
  s.querySelectorAll('input[name=sMode]').forEach(x => x.onchange = () => { r.shadowMode = x.value; re(); renderSide(); });
  s.querySelectorAll('input[name=sSrc]').forEach(x => x.onchange = () => {
    r.shadowSource = x.value;
    if (x.value === 'ai' && !aiShadowFresh(it)) { if (r.shadowMode === 'none') r.shadowMode = 'floor'; redo(it, () => ensureAiShadow(it)); }
    else { re(); renderSide(); }
  });
  const sn = $('#sShadowNew'); if (sn) sn.onclick = () => redo(it, () => { r.shadowSource = 'ai'; if (r.shadowMode === 'none') r.shadowMode = 'floor'; return ensureAiShadow(it, { force: true, model: s.querySelector('input[name=sShModel]:checked')?.value }); });
  s.querySelectorAll('input[name=sLight]').forEach(x => x.onchange = () => { r.light = x.value; re(); });
  $('#sStrength').oninput = e => { r.strength = +e.target.value / 100; r.ownStrength = true; e.target.previousElementSibling.querySelector('output').textContent = e.target.value + ' %'; schedule(re); };
  $('#sJpg').onclick = async () => download((await outBlobs(it)).jpg, it.base + '.jpg');
  $('#sPng').onclick = async () => download((await outBlobs(it)).png, it.base + '.png');
  const ur = $('#sUseRet'); if (ur) ur.onchange = () => redo(it, async () => { r.useRetouch = ur.checked; await ensureCutout(it); if (r.shadowSource === 'ai') await ensureAiShadow(it); });
  const rb = $('#sRetouch'); if (rb) rb.onclick = () => {
    const extra = $('#sExtra').value.trim();
    if (!extra && !it.analysis.fixes?.length) return toast('Bitte eine Anweisung eingeben.', true);
    redo(it, async () => {
      await ensureUpload(it);
      it.retouch = null; if (it.cutBlobs) delete it.cutBlobs.ret;
      await runRetouch(it, { qa: opt().qa, model: opt().editModel, extra });
      await ensureCutout(it);
      if (r.shadowSource === 'ai') await ensureAiShadow(it);
    });
  };
}
let tmr; function schedule(fn) { clearTimeout(tmr); tmr = setTimeout(fn, 60); }
async function redo(it, fn) {
  const side = $('#dSide'); side.classList.add('busy'); running++; updateProgress();
  try { await fn(); step(it, 'render'); await rerender(it); it.status = 'done'; paint(it); toast('Aktualisiert.'); }
  catch (e) { toast(e.message, true); if (it.out) { it.status = 'done'; paint(it); } }
  finally { running--; updateProgress(); side.classList.remove('busy'); if (current === it) { openDetail(it); } }
}

/* ---------------- Toast ---------------- */
let tt; function toast(msg, isErr = false) {
  const t = $('#toast'); t.textContent = msg; t.classList.toggle('err', isErr); t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), isErr ? 6500 : 3000);
}
