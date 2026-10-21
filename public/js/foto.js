/* FUXTEC Foto Studio – Bulk-Pipeline: Upload → Analyse → Retusche (+QA) → Freistellen → Tonwerte/Rahmen/Schatten → JPG + PNG */
import * as fx from './photofx.js';
import { removeLightBackground } from './imgtools.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WORK_MAX = 3200;          // Arbeitsauflösung: hoch genug für feine Details beim Freistellen, unter den Kie-Limits (4096 px, 16 MP, 5 MB)
const UPLOAD_MAX_BYTES = 4.6e6;  // Freisteller-Modell nimmt max. 5 MB
const STEPS = { ready: 'Bereit – auf Start drücken', queued: 'Wartet', prep: 'Vorbereiten', upload: 'Hochladen', analyze: 'KI-Analyse', retouch: 'Retusche', qa: 'Qualitätskontrolle', cutout: 'Freistellen', compare: 'Freisteller-Vergleich', shadow: 'KI-Schatten', render: 'Schatten & Export', done: 'Fertig', error: 'Fehler' };

let CFG = { kie: false, claude: false };
const items = []; let running = 0, current = null;
const opt = () => ({
  retouch: document.querySelector('input[name=retouch]:checked').value,
  editModel: document.querySelector('input[name=editModel]:checked')?.value || 'gpt-image-2-5-flare-image-to-image',
  conc: +document.querySelector('input[name=conc]:checked').value,
  strength: +$('#strength').value / 100,
  qa: $('#qa').checked,
  shadowSrc: document.querySelector('input[name=shadowSrc]:checked')?.value || 'ai',
  shadowModel: document.querySelector('input[name=shadowModel]:checked')?.value || 'gpt-image-2-5-flare-image-to-image'
});
const EDIT_MODEL_LABEL = { 'gpt-image-2-5-flare-image-to-image': 'GPT Image 2.5', 'nano-banana-2': 'Nano Banana 2', 'nano-banana-pro': 'NB Pro' };
const SHADOW_MODEL_LABEL = { 'nano-banana-2': 'Nano Banana 2', 'nano-banana-2-1': 'Nano Banana 2.1', 'nano-banana-pro': 'NB Pro', 'gpt-image-2-5-flare-image-to-image': 'GPT Image 2.5' };

/* ---------------- Kosten (Kie-Credits → Euro) ---------------- */
let batch = null, balance = null, lastBatch = null;
const eur = v => (Math.round(v * 100) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const credEur = () => CFG.creditEur || 0.0045;
function calib() { try { return Math.min(3, Math.max(0.4, +localStorage.getItem('foto-cost-cal') || 1)); } catch { return 1; } }
/* Schätzung pro Bild in Euro: min = ohne Retusche, max = Retusche mit 2. Versuch, avg = Erfahrungswert (~40 % brauchen Retusche) */
function estimate() {
  const c = CFG.costs || {}, o = opt(), live = CFG.kie && CFG.claude;
  if (!live) return { min: 0, max: 0, avg: 0 };
  const base = (c.analyze || 5) + (c.recraft || 1) + (c.keyout || 12) + (c.compare || 5) + (c.shadow?.[o.shadowModel] || 8);
  const ret = o.retouch === 'auto' ? (c.retouch?.[o.editModel] || 12) + (o.qa ? (c.qa || 5) : 0) : 0;
  const k = credEur() * calib();
  return { min: base * k, max: (base + ret * 2) * k, avg: (base + ret * 0.5) * k };
}
function spend(it, credits) { const v = credits * credEur() * calib(); it.credits = (it.credits || 0) + v; if (batch && !batch.closed) batch.spent += v; updateProgress(); }
async function getCredits() { if (!(CFG.kie)) return null; try { const r = await api('/api/photo/credits'); return typeof r.credits === 'number' ? r.credits : null; } catch { return null; } }
async function refreshBalance() { const c = await getCredits(); if (c != null) { balance = c; health.kieErr = null; updateProgress(); } else if (CFG.kie) health.kieErr = 'Guthaben nicht abrufbar'; paintBalance(); renderStatus(); }
function paintBalance() {
  const v = $('#balanceVal'); if (!v) return;
  if (balance == null) { v.textContent = CFG.kie ? '–' : 'Testmodus'; return; }
  v.textContent = eur(balance * credEur()).replace(/\s/g, '');
  $('#balancePill').classList.toggle('low', balance * credEur() < 2);
  $('#balancePill').title = `${Math.round(balance)} Kie-Credits`;
  renderStatus();
}
/* ---------------- Status (Kopfleiste) ---------------- */
const health = { kieErr: null, claudeErr: null, diag: null, checked: null };
function renderStatus() {
  const live = CFG.kie && CFG.claude, kieOk = CFG.kie && !health.kieErr && balance != null, clOk = CFG.claude && !health.claudeErr && health.diag?.claude?.ok !== false;
  const dot = $('#statusDot'); dot.className = 'dot ' + (!cfgLoaded ? '' : !live ? 'warn' : kieOk && clOk ? 'ok' : (CFG.kie || CFG.claude) ? 'warn' : 'err');
  const row = (ok, name, state, desc) => `<div class="svc"><i class="dot ${ok === true ? 'ok' : ok === false ? 'err' : 'warn'}"></i><span>${name}</span><em>${state}</em><small>${desc}</small></div>`;
  const em = m => EDIT_MODEL_LABEL[m] || SHADOW_MODEL_LABEL[m] || m;
  const d = health.diag;
  $('#statusPop').innerHTML = !cfgLoaded ? '<b>Verbindung wird geprüft …</b>' : `<b>${live && kieOk && clOk ? 'Alles verbunden' : !live ? 'Testmodus – KI nicht verbunden' : 'Eingeschränkt'}</b>
    ${row(CFG.kie ? (health.kieErr ? false : balance != null ? true : null) : false, 'Kie.ai', CFG.kie ? (health.kieErr ? 'Fehler' : balance != null ? 'verbunden' : 'prüfe …') : 'kein Schlüssel',
      health.kieErr ? esc(health.kieErr) : `Bild-KI: Retusche ${em(opt().editModel)}, Freisteller Recraft + Greenscreen (Nano Banana 2), Schatten ${em(opt().shadowModel)}`)}
    ${row(CFG.claude ? (health.claudeErr || d?.claude?.ok === false ? false : d?.claude?.ok ? true : true) : false, 'Claude', CFG.claude ? (health.claudeErr || d?.claude?.ok === false ? 'Fehler' : d?.claude?.ok ? `antwortet (${(d.claude.ms / 1000).toFixed(1)} s)` : 'verbunden') : 'fehlt',
      health.claudeErr ? esc(health.claudeErr) : d?.claude?.ok === false ? esc(d.claude.error || '') : `Analyse, Qualitätskontrolle, Freisteller-Vergleich · ${esc(CFG.model || '')} über Kie`)}
    ${row(balance != null ? balance * credEur() >= 2 : null, 'Guthaben', balance != null ? eur(balance * credEur()) : '–', balance != null ? `${Math.round(balance)} Kie-Credits${balance * credEur() < 2 ? ' – bald aufladen' : ''}` : 'Wird mit dem Kie-Schlüssel abgefragt')}
    <button class="btn" id="diagBtn">Verbindung testen</button>
    <a class="btn ghost" href="/api/logout" style="margin-top:6px;width:100%">Abmelden</a>
    <p class="stamp">${health.checked ? 'Zuletzt geprüft ' + health.checked.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''}</p>`;
  const db = $('#diagBtn'); if (db) db.onclick = runDiag;
}
async function runDiag() {
  const b = $('#diagBtn'); if (b) { b.disabled = true; b.textContent = 'Teste …'; }
  try { health.diag = await api('/api/diag'); health.claudeErr = health.diag.claude?.ok === false ? (health.diag.claude.error || 'keine Antwort') : null; }
  catch (e) { health.claudeErr = e.message; }
  await refreshBalance(); health.checked = new Date(); renderStatus();
}
async function closeBatch() {
  if (!batch || batch.closed) return; batch.closed = true;
  const end = await getCredits(), b = batch;
  if (end != null) { balance = end; paintBalance(); }
  if (b.startCredits != null && end != null && b.startCredits >= end) {
    b.actual = (b.startCredits - end) * credEur();
    // Schätzung nachkalibrieren (gedämpft), damit die nächste Vorhersage näher dran ist
    if (b.spent > 0.05 && b.actual > 0) { const f = Math.min(3, Math.max(0.4, b.actual / (b.spent / calib()))); try { localStorage.setItem('foto-cost-cal', String(calib() * 0.5 + f * 0.5)); } catch { } }
  }
  lastBatch = b; updateProgress();
}

/* ---------------- Start ---------------- */
let cfgLoaded = false;
async function loadConfig() {
  try { CFG = await api('/api/photo/config'); } catch (e) { toast('Konfiguration nicht ladbar: ' + e.message, true); }
  health.checked = new Date(); renderStatus(); paintBalance();
  refreshBalance();
  if (!CFG.kie || !CFG.claude) toast('Testmodus: ohne Kie/Claude wird nur lokal freigestellt (Weiß-Hintergrund), keine KI-Analyse/Retusche.', true);
  // Standard ist bei jedem Öffnen gleich (keine gespeicherten Abweichungen) – Erweiterte Einstellungen gelten nur für diese Sitzung
  for (const [name, v] of [['editModel', CFG.editModel], ['shadowModel', CFG.shadowModel]]) { const r = v && document.querySelector(`input[name=${name}][value="${v}"]`); if (r) r.checked = true; }
  try { localStorage.removeItem('foto-opts'); } catch { }
  cfgLoaded = true; pump();
}
init();
async function init() {
  fetch('/assets/logo/fuxkopf_path.txt').then(r => r.text()).then(p => { $('#brandLogo').innerHTML = `<path fill-rule="evenodd" d="${p}"/>`; }).catch(() => { });
  $('#namePrefix').addEventListener('input', updateNames); updateNames();
  loadConfig(); // läuft parallel – Bilder können sofort reingezogen werden, die Verarbeitung startet, sobald die Konfiguration da ist
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

  $('#zipBtn').onclick = zipAll; $('#gprogZip').onclick = zipAll; $('#startBtn').onclick = startBatch;
  $('#clearBtn').onclick = () => {
    if (running && !confirm('Es laufen noch Bilder. Trotzdem alles leeren?')) return;
    for (const it of items) it.cancelled = true; items.length = 0; $('#grid').innerHTML = ''; batch = null; lastBatch = null; updateProgress();
  };
  window.addEventListener('beforeunload', e => { if (items.some(i => i.status !== 'error' && !i.zipped)) { e.preventDefault(); e.returnValue = ''; } });
  initDetail();
  document.querySelectorAll('.pop-wrap > button').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation(); const w = b.parentElement, open = !w.classList.contains('open');
    document.querySelectorAll('.pop-wrap.open').forEach(x => { x.classList.remove('open'); x.firstElementChild.setAttribute('aria-expanded', 'false'); });
    w.classList.toggle('open', open); b.setAttribute('aria-expanded', String(open));
  }));
  document.addEventListener('click', e => { if (!e.target.closest('.pop')) document.querySelectorAll('.pop-wrap.open').forEach(x => x.classList.remove('open')); });
  $('.dz').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileIn').click(); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.pop-wrap.open').forEach(x => x.classList.remove('open')); });
  renderStatus();
}
function saveOpts() {
  pump();
}

/* ---------------- Warteschlange ---------------- */
function addFiles(list) {
  const files = [...list].filter(f => /^image\/(jpeg|png|webp|tiff)$/.test(f.type) || /\.(jpe?g|png|webp|tiff?)$/i.test(f.name));
  const skipped = list.length - files.length;
  if (skipped) toast(`${skipped} Datei(en) übersprungen (nur JPG, PNG, WebP, TIFF – HEIC bitte vorher umwandeln).`, true);
  for (const f of files) {
    const base = f.name.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').trim() || 'bild';
    const it = { id: Math.random().toString(36).slice(2, 10), file: f, name: f.name, base, status: 'ready', log: [], credits: 0,
      r: { toneOn: true, shadowMode: 'floor', light: 'center', strength: opt().strength, useRetouch: true, shadowSource: opt().shadowSrc } };
    items.push(it); $('#grid').append(card(it));
    quickThumb(it);
  }
  updateProgress(); refreshBalance();
}
/* Vorschaubild sofort nach dem Reinziehen (TIFF erst beim Start, das Dekodieren ist schwer) */
async function quickThumb(it) {
  try {
    if (await fx.isTiff(it.file)) { it.thumbNote = 'TIFF'; paint(it); return; }
    const bm = await createImageBitmap(it.file, { imageOrientation: 'from-image', resizeWidth: 480, resizeQuality: 'medium' });
    const c = fx.canvas(bm.width, bm.height); c.getContext('2d').drawImage(bm, 0, 0); bm.close?.();
    if (!it.thumb) { it.thumb = c.toDataURL('image/jpeg', 0.8); paint(it); }
  } catch { }
}
/* Start: alle bereitliegenden Bilder in die Warteschlange */
async function startBatch() {
  const ready = items.filter(i => i.status === 'ready'); if (!ready.length) return;
  if (!batch || batch.closed) batch = { startCredits: await getCredits(), est: 0, spent: 0, items: [], closed: false };
  batch.est += ready.length * estimate().avg;
  for (const it of ready) { it.status = 'queued'; batch.items.push(it); paint(it); }
  pump();
}
function pump() {
  if (!cfgLoaded) { updateProgress(); return; }
  const max = opt().conc;
  while (running < max) {
    const it = items.find(i => i.status === 'queued'); if (!it) break;
    running++; it.status = 'prep';
    process(it).catch(e => fail(it, e)).finally(() => { running--; updateProgress(); pump(); });
  }
  if (!running && batch && !batch.closed && !items.some(i => i.status === 'queued')) closeBatch();
  updateProgress();
}
function fail(it, e) {
  if (it.cancelled) return;
  console.error(it.name, e); it.status = 'error'; it.error = e.message || String(e); paint(it);
}
const step = (it, s, sub) => { if (it.cancelled) throw new Error('abgebrochen'); it.status = s; it.sub = sub || ''; paint(it); updateProgress(); };

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
/* Freisteller-Variante: a = Recraft (+ Kanten-Rettung), b = KI-Greenscreen (schon fertig verarbeitet) */
const cutPick = it => it.cutVariants?.[it.cutKey]?.pick || 'a';
const cutId = it => it.cutKey + ':' + cutPick(it);
const srcFor = (it, key) => key === 'ret' ? getRet(it) : getWork(it);
async function refineA(it, blob, key) {
  const cut = await blobCanvas(blob, 1800);
  if (it.alphaIn) return cut;
  // feine Details (Sägekette, Gitter, Speichen) aus dem Originalfoto zurückholen, Kanten entfärben
  const src = await srcFor(it, key); if (!src) return cut;
  const r = fx.refineAlpha(cut, src);
  if (!it.refineLogged) { it.refineLogged = true; it.log.push(r.skipped ? `Kanten-Rettung übersprungen (${r.skipped})` : `Kanten-Rettung: ${r.added} Detailpixel zurückgeholt`); }
  return r.canvas;
}
const getCut = it => cached(it.id + ':cut:' + cutId(it), () => cutPick(it) === 'b' ? blobCanvas(it.cutBlobs[it.cutKey], 1800) : refineA(it, it.cutBlobs[it.cutKey], it.cutKey));
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
    if (live) spend(it, CFG.costs?.analyze || 5);
    it.analysis = a.mock ? mockAnalysis() : a;
    if (a._fallback) it.log.push(`Analyse mit ${a._fallback.to} (Fallback)`);
    it.r.tone = { ...it.analysis.tone }; it.r.shadowMode = it.analysis.shadow.mode; it.r.light = it.analysis.shadow.light;
    it.r.aiContacts = it.analysis.shadow.contacts || [];
    it.r.croppedSides = a.mock ? undefined : (it.analysis.cropped_sides || []);
  }

  // 3) Retusche (nur wenn die KI Makel findet)
  if (live && !it.alphaIn && o.retouch === 'auto' && it.analysis.retouch_needed && !it.retouch) await runRetouch(it, { qa: o.qa, model: o.editModel });

  // 4) Freistellen
  await ensureCutout(it);

  // 5) KI-Schatten (Bild-KI malt den Schatten, übernommen wird nur der Schatten)
  if (it.r.shadowSource === 'ai') await ensureAiShadow(it);

  // 5) Tonwerte, Rahmen, Schatten
  step(it, 'render'); await rerender(it);
  it.status = 'done'; paint(it); if (prefix()) for (const x of items) paint(x);
}
async function ensureUpload(it) {
  if (it.origUrl && Date.now() - it.origAt < 20 * 3600e3) return;
  step(it, 'upload');
  const work = await getWork(it); let q = 0.93, data = fx.jpegDataUrl(work, WORK_MAX, q);
  while (data.length * 0.75 > UPLOAD_MAX_BYTES && q > 0.6) { q -= 0.07; data = fx.jpegDataUrl(work, WORK_MAX, q); }
  it.origUrl = (await api('/api/photo/upload', { base64Data: data, uploadPath: 'fuxtec-foto', fileName: `${it.id}-orig.jpg` })).url;
  it.origAt = Date.now();
}

async function runRetouch(it, { qa, model, extra }) {
  const fixes = it.analysis.fixes || [];
  let strict = '', last = null;
  for (let attempt = 1; attempt <= (qa ? 2 : 1); attempt++) {
    step(it, 'retouch', attempt > 1 ? '2. Versuch' : '');
    const t = await api('/api/photo/retouch', { imageUrl: it.origUrl, fixes, extra, strict, model, w: it.w, h: it.h });
    spend(it, CFG.costs?.retouch?.[t.model] || 12);
    const blob = await fetchBlob(await pollTask(it, t.taskId));
    // als JPG neu in den Kie-Speicher: GPT liefert große PNGs, der Freisteller nimmt max. 5 MB / 4096 px
    const rc = await blobCanvas(blob, WORK_MAX); let jq = 0.94, data = fx.jpegDataUrl(rc, WORK_MAX, jq);
    while (data.length * 0.75 > UPLOAD_MAX_BYTES && jq > 0.6) { jq -= 0.07; data = fx.jpegDataUrl(rc, WORK_MAX, jq); }
    const url = (await api('/api/photo/upload', { base64Data: data, uploadPath: 'fuxtec-foto', fileName: `${it.id}-ret${attempt}.jpg` })).url;
    last = { url, blob, model: t.model, attempt, extra };
    if (!qa) break;
    step(it, 'qa');
    const can = await blobCanvas(blob, 1100);
    spend(it, CFG.costs?.qa || 5);
    const q = await api('/api/photo/qa', { original: fx.jpegDataUrl(await getWork(it), 1100, 0.85), retouched: fx.jpegDataUrl(can, 1100, 0.85), fixes: extra ? [...fixes, extra] : fixes });
    last.qa = q.mock ? null : q;
    if (q.mock || q.accept) break;
    strict = [q.reason, q.retry_hint].filter(Boolean).join(' – ');
  }
  const ok = !last.qa || last.qa.accept;
  it.retouch = { ...last, accepted: ok };
  it.r.useRetouch = ok;
  if (it.cutBlobs) delete it.cutBlobs.ret; if (it.cutVariants) delete it.cutVariants.ret;
  it.log.push(ok ? `Retusche übernommen (Versuch ${last.attempt})` : 'Retusche verworfen: ' + (last.qa?.reason || ''));
}

async function ensureCutout(it) {
  const useRet = it.r.useRetouch && it.retouch?.url;
  const key = useRet ? 'ret' : 'orig';
  it.cutBlobs = it.cutBlobs || {}; it.cutVariants = it.cutVariants || {};
  if (!it.cutBlobs[key]) {
    if (it.alphaIn) { step(it, 'cutout'); it.cutBlobs[key] = it.src; }
    else if (CFG.kie && CFG.claude) {
      // zwei Verfahren parallel: A = Recraft, B = KI-Greenscreen (Nano Banana) → bessere Version gewinnt
      step(it, 'cutout', '2 Verfahren parallel');
      const imageUrl = useRet ? it.retouch.url : it.origUrl;
      const keyColor = fx.keyColorFor(await srcFor(it, key));
      const pa = (async () => { const t = await api('/api/photo/cutout', { imageUrl }); spend(it, CFG.costs?.recraft || 1); return fetchBlob(await pollTask(it, t.taskId)); })();
      const pb = (async () => { try { const t = await api('/api/photo/keyout', { imageUrl, key: keyColor }); spend(it, CFG.costs?.keyout || 12); return { blob: await fetchBlob(await pollTask(it, t.taskId)) }; } catch (e) { if (it.cancelled) throw e; return { err: e.message }; } })();
      const [aBlob, bRes] = await Promise.all([pa, pb]);
      const v = { a: aBlob, b: null, pick: 'a' };
      if (bRes.blob) {
        step(it, 'compare');
        const A = await refineA(it, aBlob, key), src = await srcFor(it, key);
        await sleep(0);
        const k = fx.keyAlpha(await blobCanvas(bRes.blob), src, A, keyColor);
        if (k.ok) {
          v.b = await fx.toBlob(k.canvas, 'image/png');
          const sh = fx.compareSheets(A, k.canvas);
          try {
            const c = await api('/api/photo/compare', { full: sh.full, crops: sh.crops, product: it.analysis?.product });
            if (c.mock) { v.pick = 'b'; v.why = 'Ohne KI-Vergleich: Greenscreen-Verfahren gewählt'; }
            else { spend(it, CFG.costs?.compare || 5); v.pick = c.winner === 'B' ? 'b' : 'a'; v.why = c.reason; v.cmp = c; }
          } catch (e) { v.pick = k.iou > 0.92 ? 'b' : 'a'; v.why = 'Vergleich nicht möglich – automatisch gewählt'; }
        } else v.bFail = k.reason;
      } else v.bFail = bRes.err;
      it.cutVariants[key] = v; it.cutBlobs[key] = v.pick === 'b' ? v.b : v.a;
      it.log.push(v.b ? `Freisteller: ${v.pick === 'b' ? 'B (KI-Greenscreen)' : 'A (Recraft)'} gewählt – ${v.why}` : `Freisteller: A (Recraft); B nicht verwendbar (${v.bFail})`);
    } else {
      step(it, 'cutout');
      const w = await getWork(it), c = fx.canvas(w.width, w.height); c.getContext('2d').drawImage(w, 0, 0);
      it.cutBlobs[key] = await fx.toBlob(removeLightBackground(c), 'image/png');
    }
  }
  it.cutKey = key;
}

const aiShadowFresh = it => it.aiShadow && it.aiShadow.key === cutId(it);
async function ensureAiShadow(it, { force = false, model } = {}) {
  const r = it.r;
  if (!(CFG.kie && CFG.claude)) { r.shadowSource = 'calc'; return; }
  if (fx.prepareProduct(await getCut(it), r).bleed.b) return; // unten angeschnitten: kein Bodenschatten nötig
  if (aiShadowFresh(it) && !force) return;
  if (r.shadowMode === 'none') r.shadowMode = 'floor'; // jedes Produkt bekommt einen Schatten
  const placed = fx.prepareProduct(await getCut(it), r);
  const up = await api('/api/photo/upload', { base64Data: fx.jpegDataUrl(fx.productOnWhite(placed), 1200, 0.94), uploadPath: 'fuxtec-foto', fileName: `${it.id}-weiss.jpg` });
  // gewähltes Modell, bei Problemen automatisch Nano Banana 2, erst danach berechneter Schatten
  const first = model || opt().shadowModel, chain = [first, ...(first !== 'nano-banana-2' ? ['nano-banana-2'] : [])];
  let lastErr = '';
  for (const m of chain) {
    step(it, 'shadow', m !== first ? 'zweiter Versuch' : '');
    try {
      const t = await api('/api/photo/shadow', { imageUrl: up.url, mode: r.shadowMode, light: r.light, model: m });
      spend(it, CFG.costs?.shadow?.[m] || 8);
      const ai = await blobCanvas(await fetchBlob(await pollTask(it, t.taskId)));
      const big = fx.canvas(placed.layer.width, placed.layer.height); big.getContext('2d').drawImage(ai, 0, 0, big.width, big.height);
      await sleep(0);
      const ex = fx.extractAiShadow(big, placed);
      if (!ex.ok) { lastErr = `${SHADOW_MODEL_LABEL[m] || m}: ${ex.reason}`; it.log.push('KI-Schatten verworfen – ' + lastErr); continue; }
      it.aiShadow = { key: cutId(it), blob: await fx.toBlob(ex.canvas, 'image/png'), model: t.model, cost: ex.cost, at: Date.now() };
      it.aiShadowFail = null; r.shadowSource = 'ai';
      it.log.push(`KI-Schatten: ${SHADOW_MODEL_LABEL[t.model] || t.model} (Abweichung Produkt ${ex.cost.toFixed(1)})`);
      return;
    } catch (e) { if (it.cancelled) throw e; lastErr = `${SHADOW_MODEL_LABEL[m] || m}: ${e.message}`; it.log.push('KI-Schatten fehlgeschlagen – ' + lastErr); }
  }
  it.aiShadowFail = lastErr || 'unbekannt'; r.shadowSource = 'calc';
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
    if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('Nicht angemeldet'); }
    const msg = j.error || `HTTP ${r.status}`;
    if (/Claude/.test(msg)) health.claudeErr = msg.slice(0, 160); else if (/Kie/.test(msg)) health.kieErr = msg.slice(0, 160);
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
/* Hover-Hinweis als schwebende Karte (wird nicht von der Kachel abgeschnitten) */
const tipTag = (label, title, lines, icon) => `<span class="tag warn has-tip" tabindex="0" data-tip="${esc(JSON.stringify({ title, lines }))}">${icon ? '<svg class="i"><use href="#i-alert"/></svg>' : ''}${esc(label)}</span>`;
(() => {
  let box = null;
  const hide = () => { box?.classList.remove('on'); };
  const show = el => {
    let d; try { d = JSON.parse(el.dataset.tip); } catch { return; }
    if (!box) { box = document.createElement('div'); box.className = 'tip'; box.setAttribute('role', 'tooltip'); document.body.append(box); }
    box.innerHTML = `<b><svg class="i"><use href="#i-alert"/></svg>${esc(d.title)}</b><ul>${d.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
    const r = el.getBoundingClientRect(), w = Math.min(300, innerWidth - 16);
    box.style.width = w + 'px';
    box.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
    box.classList.add('on');
    const h = box.offsetHeight, up = r.top > h + 14;
    box.style.top = (up ? r.top - h - 8 : r.bottom + 8) + 'px'; box.classList.toggle('below', !up);
  };
  document.addEventListener('mouseover', e => { const t = e.target.closest?.('.has-tip'); t ? show(t) : hide(); });
  document.addEventListener('focusin', e => { const t = e.target.closest?.('.has-tip'); t ? show(t) : hide(); });
  document.addEventListener('focusout', hide); addEventListener('scroll', hide, true);
})();
function card(it) {
  const el = document.createElement('article'); el.className = 'fcard'; el.id = 'c-' + it.id;
  el.innerHTML = `<div class="fc-img"></div><div class="fc-meta"><b class="fc-name"></b><span class="fc-out"></span><span class="fc-step"></span><div class="fc-tags"></div></div>
    <div class="fc-act"><button class="btn ghost fc-regen" title="Dieses Bild komplett neu bearbeiten (kostet erneut Credits)"><svg class="i"><use href="#i-refresh"/></svg>Neu</button><button class="btn icon ghost fc-retry" title="Erneut versuchen"><svg class="i"><use href="#i-refresh"/></svg></button><button class="btn icon ghost fc-del" title="Entfernen"><svg class="i"><use href="#i-x"/></svg></button></div>`;
  el.querySelector('.fc-img').onclick = () => it.status === 'done' && openDetail(it);
  el.querySelector('.fc-retry').onclick = e => { e.stopPropagation(); it.status = 'queued'; it.error = ''; paint(it); if (!batch || batch.closed) batch = { startCredits: null, est: estimate().avg, spent: 0, items: [it], closed: false }; pump(); };
  el.querySelector('.fc-regen').onclick = e => { e.stopPropagation(); regenerate(it); };
  el.querySelector('.fc-del').onclick = e => { e.stopPropagation(); it.cancelled = true; items.splice(items.indexOf(it), 1); el.remove(); updateProgress(); };
  paint(it, el); return el;
}
/* Bild komplett neu bearbeiten: Analyse, Retusche, Freisteller und Schatten werden verworfen und neu erzeugt */
function regenerate(it) {
  if (it.status !== 'done' || !confirm(`„${it.name}“ komplett neu bearbeiten?\nDas kostet erneut Credits (ca. ${eur(Math.max(it.credits, estimate().avg))}).`)) return;
  dropCache(it);
  for (const k of ['analysis', 'retouch', 'cutVariants', 'cutBlobs', 'cutKey', 'aiShadow', 'aiShadowFail', 'out']) delete it[k];
  it.credits = 0; it.error = ''; it.log.push('Neu generiert');
  it.r = { toneOn: true, shadowMode: 'floor', light: 'center', strength: opt().strength, useRetouch: true, shadowSource: opt().shadowSrc };
  it.status = 'queued'; paint(it);
  if (!batch || batch.closed) batch = { startCredits: null, est: 0, spent: 0, items: [], closed: false };
  batch.est += estimate().avg; batch.items.push(it); pump();
}
function paint(it, el = document.getElementById('c-' + it.id)) {
  if (!el) return;
  el.dataset.status = it.status;
  const img = el.querySelector('.fc-img'), src = it.resultThumb || it.thumb;
  if (src && img.dataset.src !== src) { img.innerHTML = `<img src="${src}" alt="">`; img.dataset.src = src; }
  else if (!src && it.thumbNote && !img.dataset.note) { img.innerHTML = `<span class="fc-note">${esc(it.thumbNote)}</span>`; img.dataset.note = 1; }
  img.classList.toggle('busy', !['done', 'error', 'queued', 'ready'].includes(it.status));
  el.querySelector('.fc-name').textContent = it.name;
  const on = it.status === 'done' && prefix() ? outNames(it) : null;
  el.querySelector('.fc-out').textContent = on ? 'Nr. ' + (on.png.match(/_(\d+)\.png$/) || [, ''])[1] + ' · ' + prefix() : '';
  el.querySelector('.fc-out').title = on ? `${on.png}\n${on.jpg}` : '';
  el.querySelector('.fc-step').textContent = it.status === 'error' ? it.error : STEPS[it.status] + (it.sub ? ' · ' + it.sub : '');
  // Karte bleibt ruhig: nur Abweichungen vom Normalfall als Tag, alles andere steht in der Detailansicht
  const a = it.analysis, tags = [];
  if (it.retouch) tags.push(it.retouch.accepted ? '<span class="tag ok">Retuschiert</span>' : '<span class="tag warn">Retusche verworfen</span>');
  if (it.status === 'done' && it.aiShadowFail && it.r.shadowSource !== 'ai') tags.push(tipTag('Schatten berechnet', 'Hinweis', [`KI-Schatten nicht übernommen: ${it.aiShadowFail}`, 'Stattdessen wurde ein berechneter Schatten verwendet.']));
  if (a?.warnings?.length) tags.push(tipTag(`${a.warnings.length} Hinweis${a.warnings.length > 1 ? 'e' : ''}`, 'Hinweise der KI-Analyse', a.warnings, true));
  if (it.status === 'done' && it.credits > 0) tags.push(`<span class="tag" title="geschätzte Kosten für dieses Bild">ca. ${eur(it.credits)}</span>`);
  el.querySelector('.fc-tags').innerHTML = tags.join('');
  el.querySelector('.fc-retry').hidden = it.status !== 'error';
  el.querySelector('.fc-regen').hidden = it.status !== 'done';
}
const STEP_PCT = { ready: 0, compare: 66, queued: 0, prep: 4, upload: 10, analyze: 18, retouch: 35, qa: 50, cutout: 58, shadow: 72, render: 95, done: 100, error: 100 };
function updateProgress() {
  const ready = items.filter(i => i.status === 'ready'), act = items.filter(i => i.status !== 'ready');
  const done = items.filter(i => i.status === 'done').length, err = items.filter(i => i.status === 'error').length, total = act.length;
  const pct = total ? act.reduce((s, i) => s + (STEP_PCT[i.status] ?? 0), 0) / total : 0;
  const finished = total > 0 && done + err === total && !running;
  $('#progressTxt').textContent = items.length ? `${done}/${items.length} fertig${err ? ` · ${err} Fehler` : ''}` : '';
  $('#zipBtn').disabled = !done;
  document.body.classList.toggle('has-items', items.length > 0);
  $('#emptyHint').hidden = items.length > 0;
  const g = $('#gprog'); g.hidden = !items.length; g.classList.toggle('finished', finished && !ready.length); g.classList.toggle('has-err', err > 0); g.classList.toggle('idle', !total);
  $('#gprogBar').style.width = (!total ? 0 : finished ? 100 : Math.max(2, pct)).toFixed(1) + '%';
  $('#gprogPct').textContent = total ? Math.round(finished ? 100 : pct) + ' %' : '';
  $('#gprogTxt').textContent = !total ? `${ready.length} ${ready.length === 1 ? 'Bild' : 'Bilder'} bereit` : finished
    ? `Fertig: ${done} von ${total} Bildern${err ? ` · ${err} mit Fehler (auf der Karte ↻ erneut versuchen)` : ''}`
    : `${done} von ${total} Bildern fertig · ${running} in Arbeit${err ? ` · ${err} Fehler` : ''}`;
  $('#gprogZip').hidden = !finished || !done;
  $('#zipBtn').hidden = !$('#gprogZip').hidden || !items.length;
  // Start + Kostenschätzung
  const e = estimate(), live = CFG.kie && CFG.claude, sb = $('#startBtn');
  sb.hidden = !ready.length; sb.disabled = !cfgLoaded;
  sb.innerHTML = `<svg class="i"><use href="#i-play"/></svg>${total ? `${ready.length} weitere starten` : `Start – ${ready.length} ${ready.length === 1 ? 'Bild' : 'Bilder'} bearbeiten`}`;
  const est = ready.length * e.avg, bal = balance != null ? balance * credEur() : null;
  const lines = [];
  if (ready.length && live) lines.push(`Geschätzte Kosten: <b>ca. ${eur(est)}</b> für ${ready.length} ${ready.length === 1 ? 'Bild' : 'Bilder'} <span class="dim">(${eur(e.min)}–${eur(e.max)} pro Bild, je nachdem ob retuschiert wird)</span>`);
  if (ready.length && live && bal != null && est > bal) lines.push(`<span class="warn">Kie-Guthaben (ca. ${eur(bal)}) reicht voraussichtlich nicht – bitte aufladen.</span>`);
  if (ready.length && !live) lines.push('<span class="dim">Testmodus – keine Kosten.</span>');
  if (batch && !batch.closed && total) lines.push(`Bisher verbraucht: <b>ca. ${eur(batch.spent)}</b> <span class="dim">von geschätzt ${eur(batch.est)}</span>`);
  if (finished && lastBatch && lastBatch.closed && (!batch || batch === lastBatch)) {
    const n = lastBatch.items.filter(i => i.status === 'done').length || 1;
    lines.push(lastBatch.actual != null
      ? `Kosten dieses Laufs: <b>${eur(lastBatch.actual)}</b> laut Kie-Guthaben <span class="dim">(ca. ${eur(lastBatch.actual / n)} pro Bild · geschätzt waren ${eur(lastBatch.est)})</span>`
      : `Kosten dieses Laufs: <b>ca. ${eur(lastBatch.spent)}</b> <span class="dim">(geschätzt, ca. ${eur(lastBatch.spent / n)} pro Bild)</span>`);
  }
  $('#gprogCost').innerHTML = lines.join('<br>');
}

/* ---------------- Export ---------------- */
async function outBlobs(it) {
  const out = await ensureOut(it);
  return { jpg: await fx.toBlob(out.jpg, 'image/jpeg', 0.93), png: await fx.toBlob(out.png, 'image/png') };
}
/* Dateinamen: mit Artikelnummer → PRÄFIX_freigestellt_01.png / PRÄFIX_whitepack_01.jpg (Nummer = Reihenfolge der fertigen Bilder) */
function prefix() { return ($('#namePrefix').value || '').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '').trim().replace(/\s+/g, '-'); }
function outNames(it) {
  const p = prefix();
  if (!p) return { png: it.base + '.png', jpg: it.base + '.jpg' };
  const list = items.filter(i => i.status === 'done'), idx = list.indexOf(it) + 1 || list.length + 1, nr = String(idx).padStart(2, '0');
  return { png: `${p}_freigestellt_${nr}.png`, jpg: `${p}_whitepack_${nr}.jpg` };
}
function updateNames() {
  const p = prefix();
  $('#namePrev').innerHTML = p ? `<b>${esc(p)}_freigestellt_01.png</b><br><b>${esc(p)}_whitepack_01.jpg</b>` : 'Leer lassen = Originalnamen';
  for (const it of items) paint(it);
}

async function zipAll() {
  const done = items.filter(i => i.status === 'done'); if (!done.length) return;
  const btn = $('#zipBtn'); btn.disabled = true; const label = btn.innerHTML; btn.textContent = 'ZIP wird erstellt …';
  try {
    const zip = new JSZip(), used = new Set(), rows = [['Original', 'PNG', 'JPG', 'Produkt', 'Retusche', 'QA', 'Hinweise', 'Probleme']];
    for (const it of done) {
      const nm = outNames(it); let jn = nm.jpg, pn = nm.png, k = 2;
      while (used.has(jn.toLowerCase()) || used.has(pn.toLowerCase())) { jn = nm.jpg.replace(/\.jpg$/, `_${k}.jpg`); pn = nm.png.replace(/\.png$/, `_${k}.png`); k++; }
      used.add(jn.toLowerCase()); used.add(pn.toLowerCase());
      const b = await outBlobs(it);
      zip.file(`JPG/${jn}`, b.jpg); zip.file(`PNG/${pn}`, b.png);
      const a = it.analysis || {};
      rows.push([it.name, pn, jn, a.product || '', it.retouch ? (it.r.useRetouch ? 'ja' : 'verworfen') : 'nein', it.retouch?.qa ? `${it.retouch.qa.score}/10 ${it.retouch.qa.reason}` : '', (a.warnings || []).join(' | '), (a.issues || []).join(' | ')]);
      it.zipped = true;
    }
    zip.file('protokoll.csv', '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n'));
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    download(blob, `${prefix() || 'FUXTEC_Produktfotos'}_${new Date().toISOString().slice(0, 10)}.zip`);
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
      ${it.retouch ? `<p class="hint">${esc(EDIT_MODEL_LABEL[it.retouch.model] || it.retouch.model)} · Versuch ${it.retouch.attempt}${q ? ` · QA ${q.score}/10: ${esc(q.reason)}` : ''}</p>` : `<p class="hint">${a.retouch_needed ? 'Vorgeschlagen, aber nicht ausgeführt.' : 'Nicht nötig.'}</p>`}
      ${a.fixes?.length ? list(a.fixes, 'en') : ''}
      ${it.retouch ? `<label class="tgl small"><input type="checkbox" id="sUseRet" ${r.useRetouch ? 'checked' : ''}><span class="sw"></span><span><b>Retusche verwenden</b><small>Aus = Original freistellen</small></span></label>` : ''}
      ${CFG.kie && !it.alphaIn ? `<textarea id="sExtra" rows="2" placeholder="Eigene Anweisung (Englisch oder Deutsch), z. B. „Falte am Seitenteil links glätten“"></textarea>
      <button class="btn" id="sRetouch"><svg class="i"><use href="#i-wand"/></svg>${it.retouch ? 'Retusche neu' : 'Retusche ausführen'}</button>` : ''}
    </section>
    ${(() => { const v = it.cutVariants?.[it.cutKey]; if (!v) return ''; return `<section><h3>Freistellung</h3>
      ${v.b ? `<div class="seg"><label><input type="radio" name="sCut" value="a" ${v.pick === 'a' ? 'checked' : ''}><span>A · Recraft</span></label><label><input type="radio" name="sCut" value="b" ${v.pick === 'b' ? 'checked' : ''}><span>B · KI-Greenscreen</span></label></div>
      <p class="hint">${v.cmp ? `KI-Vergleich: <b>${v.cmp.winner}</b> besser (${v.cmp.confidence}/10) – ${esc(v.cmp.reason)}` : esc(v.why || '')}</p>
      ${v.cmp?.a_issues?.length || v.cmp?.b_issues?.length ? `<ul class="fd-list en">${(v.cmp.a_issues || []).map(t => `<li>A: ${esc(t)}</li>`).join('')}${(v.cmp.b_issues || []).map(t => `<li>B: ${esc(t)}</li>`).join('')}</ul>` : ''}`
      : `<p class="hint">Nur Verfahren A (Recraft) – B nicht verwendbar: ${esc(v.bFail || '–')}</p>`}
    </section>`; })()}
    <section><h3>Farbe & Licht <label class="tgl inline"><input type="checkbox" id="sToneOn" ${r.toneOn ? 'checked' : ''}><span class="sw"></span></label></h3>
      <div class="fd-sliders">${TONE_UI.map(([k, l, mi, ma, st]) => `<label class="rng"><span>${l}<output>${(+(r.tone?.[k] ?? 0)).toFixed(2)}</output></span><input type="range" data-tone="${k}" min="${mi}" max="${ma}" step="${st}" value="${r.tone?.[k] ?? 0}"></label>`).join('')}</div>
      <label class="tgl small"><input type="checkbox" id="sLevels" ${r.tone?.levels ? 'checked' : ''}><span class="sw"></span><span><b>Tonwertkorrektur (Schwarz-/Weißpunkt)</b></span></label>
      <button class="btn ghost" id="sToneReset">KI-Werte wiederherstellen</button>
    </section>
    <section><h3>Anschnitt</h3>
      <div class="seg multi">${[['left', 'Links'], ['right', 'Rechts'], ['top', 'Oben'], ['bottom', 'Unten']].map(([k, l]) => `<label><input type="checkbox" name="sCrop" value="${k}" ${(r.croppedSides || []).includes(k) ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      <p class="hint">Seiten, an denen das Produkt im Originalfoto abgeschnitten ist: Dort läuft es bis an den Rand, die anderen Seiten halten den 900er-Rahmen.</p>
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
  s.querySelectorAll('input[name=sCrop]').forEach(x => x.onchange = () => redo(it, async () => {
    r.croppedSides = [...s.querySelectorAll('input[name=sCrop]:checked')].map(i => i.value);
    if (r.shadowSource === 'ai') await ensureAiShadow(it, { force: true });
  }));
  s.querySelectorAll('input[name=sMode]').forEach(x => x.onchange = () => { r.shadowMode = x.value; re(); renderSide(); });
  s.querySelectorAll('input[name=sCut]').forEach(x => x.onchange = () => redo(it, async () => {
    const v = it.cutVariants[it.cutKey]; v.pick = x.value; it.cutBlobs[it.cutKey] = x.value === 'b' ? v.b : v.a;
    it.log.push(`Freisteller manuell auf ${x.value.toUpperCase()} gestellt`);
    if (r.shadowSource === 'ai') await ensureAiShadow(it);
  }));
  s.querySelectorAll('input[name=sSrc]').forEach(x => x.onchange = () => {
    r.shadowSource = x.value;
    if (x.value === 'ai' && !aiShadowFresh(it)) { if (r.shadowMode === 'none') r.shadowMode = 'floor'; redo(it, () => ensureAiShadow(it)); }
    else { re(); renderSide(); }
  });
  const sn = $('#sShadowNew'); if (sn) sn.onclick = () => redo(it, () => { r.shadowSource = 'ai'; if (r.shadowMode === 'none') r.shadowMode = 'floor'; return ensureAiShadow(it, { force: true, model: s.querySelector('input[name=sShModel]:checked')?.value }); });
  s.querySelectorAll('input[name=sLight]').forEach(x => x.onchange = () => { r.light = x.value; re(); });
  $('#sStrength').oninput = e => { r.strength = +e.target.value / 100; r.ownStrength = true; e.target.previousElementSibling.querySelector('output').textContent = e.target.value + ' %'; schedule(re); };
  $('#sJpg').onclick = async () => download((await outBlobs(it)).jpg, outNames(it).jpg);
  $('#sPng').onclick = async () => download((await outBlobs(it)).png, outNames(it).png);
  const ur = $('#sUseRet'); if (ur) ur.onchange = () => redo(it, async () => { r.useRetouch = ur.checked; await ensureCutout(it); if (r.shadowSource === 'ai') await ensureAiShadow(it); });
  const rb = $('#sRetouch'); if (rb) rb.onclick = () => {
    const extra = $('#sExtra').value.trim();
    if (!extra && !it.analysis.fixes?.length) return toast('Bitte eine Anweisung eingeben.', true);
    redo(it, async () => {
      await ensureUpload(it);
      it.retouch = null; if (it.cutBlobs) delete it.cutBlobs.ret; if (it.cutVariants) delete it.cutVariants.ret;
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
