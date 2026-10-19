/* FUXTEC Foto Studio – API (/api/photo/*)
 * Bilder werden NICHT in KV gespeichert: Der Browser schickt sie direkt (durchgereicht) in den Kie-Speicher (24 h),
 * alle Kie-Aufgaben arbeiten mit diesen URLs, Ergebnisse holt der Browser über /api/photo/fetch.
 * Vars: KIE_EDIT_MODEL (nano-banana-2), KIE_REMOVE_BG_MODEL, CLAUDE_PHOTO_MODEL (sonst CLAUDE_MODEL)
 */
import { ANALYZE_SYSTEM, ANALYZE_TOOL, QA_SYSTEM, QA_TOOL, retouchPrompt, shadowPrompt } from './photo-prompts.js';

const KIE_UPLOAD = 'https://kieai.redpandaai.co/api/file-base64-upload';
const EDIT_MODELS = ['nano-banana-2', 'nano-banana-pro'];
const SHADOW_MODELS = ['nano-banana-2', 'nano-banana-2-1', 'nano-banana-pro', 'gpt-image-2-5-flare-image-to-image'];

export async function handlePhoto(req, env, url, h) {
  const { json, err, claude, claudeReady, kieCreate, kieStatus, imgBlock, sniff } = h;
  const p = url.pathname.slice('/api/photo'.length), m = req.method;
  const body = () => req.json();
  const model = env.CLAUDE_PHOTO_MODEL || env.CLAUDE_MODEL;

  if (p === '/config') return json({
    claude: claudeReady(env), kie: !!env.KIE_API_KEY, model, editModel: env.KIE_EDIT_MODEL || 'nano-banana-2', editModels: EDIT_MODELS,
    shadowModel: env.KIE_SHADOW_MODEL || 'nano-banana-2', shadowModels: SHADOW_MODELS
  });

  /* Upload: Body {base64Data, fileName} wird ungeparst an Kie weitergereicht (spart Worker-CPU) */
  if (p === '/upload' && m === 'POST') {
    if (!env.KIE_API_KEY) return json({ mock: true });
    const r = await fetch(KIE_UPLOAD, { method: 'POST', body: req.body, headers: { authorization: `Bearer ${env.KIE_API_KEY}`, 'content-type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    const u = j.data?.downloadUrl || j.data?.fileUrl || j.data?.url;
    if (!r.ok || (j.code && j.code !== 200) || !u) return err(`Kie-Upload: ${j.msg || j.message || r.status}`, 502);
    return json({ url: u });
  }

  /* Analyse (Claude sieht das Rohfoto) */
  if (p === '/analyze' && m === 'POST') {
    const b = await body(); if (!claudeReady(env)) return json({ mock: true });
    const text = `Dateiname: ${b.name || '-'}\nOriginalgröße: ${b.width}×${b.height}px${b.note ? `\nHinweis vom Nutzer: ${b.note}` : ''}\nAnalysiere dieses Produktfoto.`;
    const out = await claude(env, { system: ANALYZE_SYSTEM, tool: ANALYZE_TOOL, maxTokens: 2500, model, messages: [{ role: 'user', content: [imgBlock(b.image), { type: 'text', text }] }] });
    return json(sanitizeAnalysis(out));
  }

  /* Retusche starten (Kie Bild-Edit) */
  if (p === '/retouch' && m === 'POST') {
    const b = await body(); if (!env.KIE_API_KEY) return json({ mock: true });
    const fixes = (b.fixes || []).filter(Boolean).slice(0, 8);
    if (!fixes.length && !b.extra) return err('Keine Retusche-Anweisungen');
    const editModel = EDIT_MODELS.includes(b.model) ? b.model : (env.KIE_EDIT_MODEL || 'nano-banana-2');
    const prompt = retouchPrompt(fixes, b.extra, b.strict);
    const input = { prompt, image_input: [b.imageUrl], aspect_ratio: b.aspect || 'auto', resolution: '2K', output_format: 'jpg' };
    return json({ taskId: await kieCreate(env, editModel, input), prompt, model: editModel });
  }

  /* Qualitätskontrolle: Original vs. Retusche */
  if (p === '/qa' && m === 'POST') {
    const b = await body(); if (!claudeReady(env)) return json({ mock: true });
    const system = QA_SYSTEM.replace('FIXES', (b.fixes || []).map(f => '- ' + f).join('\n') || '-');
    const content = [{ type: 'text', text: 'Bild A – Original:' }, imgBlock(b.original), { type: 'text', text: 'Bild B – Retusche:' }, imgBlock(b.retouched), { type: 'text', text: 'Vergleiche A und B.' }];
    return json(await claude(env, { system, tool: QA_TOOL, maxTokens: 1200, model, messages: [{ role: 'user', content }] }));
  }

  /* KI-Schatten: Produkt auf Weiß → Bild-KI malt den Schatten (übernommen wird im Browser nur der Schatten) */
  if (p === '/shadow' && m === 'POST') {
    const b = await body(); if (!env.KIE_API_KEY) return json({ mock: true });
    const model = SHADOW_MODELS.includes(b.model) ? b.model : (env.KIE_SHADOW_MODEL || 'nano-banana-2');
    const prompt = shadowPrompt(b.mode, b.light);
    const input = model.startsWith('gpt-image')
      ? { prompt, input_urls: [b.imageUrl], aspect_ratio: '1:1', resolution: '1K' }
      : { prompt, image_input: [b.imageUrl], aspect_ratio: '1:1', resolution: '1K', output_format: 'png' };
    return json({ taskId: await kieCreate(env, model, input), model });
  }

  /* Freistellen */
  if (p === '/cutout' && m === 'POST') {
    const b = await body(); if (!env.KIE_API_KEY) return json({ mock: true });
    return json({ taskId: await kieCreate(env, env.KIE_REMOVE_BG_MODEL || 'recraft/remove-background', { image: b.imageUrl }) });
  }

  let mm;
  if ((mm = p.match(/^\/task\/([\w-]+)$/))) return json(await kieStatus(env, mm[1]));

  /* Ergebnisse von Kie holen (Canvas braucht same-origin; Kie liefert oft application/octet-stream) */
  if (p === '/fetch') {
    const target = url.searchParams.get('url') || '';
    if (!/^https:\/\//.test(target)) return err('url fehlt');
    const r = await fetch(target);
    if (!r.ok) return err(`Ergebnis nicht ladbar (${r.status})`, 502);
    const buf = await r.arrayBuffer();
    return new Response(buf, { headers: { 'content-type': sniff(buf, r.headers.get('content-type')), 'cache-control': 'private, max-age=3600' } });
  }
  return err('Unbekannte Route', 404);
}

const clamp = (v, a, b, d = 0) => (Number.isFinite(+v) ? Math.min(b, Math.max(a, +v)) : d);
function sanitizeAnalysis(o) {
  const t = o.tone || {};
  o.tone = {
    exposure: clamp(t.exposure, -1, 1), contrast: clamp(t.contrast, -0.5, 0.5), shadows: clamp(t.shadows, 0, 0.6), highlights: clamp(t.highlights, -0.6, 0),
    saturation: clamp(t.saturation, -0.5, 0.5), warmth: clamp(t.warmth, -0.5, 0.5), sharpen: clamp(t.sharpen, 0, 1, 0.2), levels: !!t.levels
  };
  o.fixes = (Array.isArray(o.fixes) ? o.fixes : []).filter(f => typeof f === 'string' && f.trim()).slice(0, 8);
  o.retouch_needed = !!o.retouch_needed && o.fixes.length > 0;
  o.issues = Array.isArray(o.issues) ? o.issues : [];
  o.warnings = Array.isArray(o.warnings) ? o.warnings : [];
  const contacts = (Array.isArray(o.shadow?.contacts) ? o.shadow.contacts : []).map(c => ({ x: clamp(c?.x, 0, 1, -1), y: clamp(c?.y, 0, 1, -1) })).filter(c => c.x >= 0 && c.y >= 0).slice(0, 8);
  o.shadow = { mode: ['floor', 'flat', 'none'].includes(o.shadow?.mode) ? o.shadow.mode : 'floor', light: ['left', 'center', 'right'].includes(o.shadow?.light) ? o.shadow.light : 'center', contacts };
  return o;
}
