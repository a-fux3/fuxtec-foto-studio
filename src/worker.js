/* FUXTEC Foto Studio – Cloudflare Worker (API + statische App)
 * Bindings: ASSETS (statische Dateien)
 * Secrets:  KIE_API_KEY, APP_PASSWORD (optional: ANTHROPIC_API_KEY bei CLAUDE_PROVIDER "anthropic")
 * Vars:     CLAUDE_PROVIDER, CLAUDE_MODEL, CLAUDE_PHOTO_MODEL, KIE_EDIT_MODEL, KIE_REMOVE_BG_MODEL
 * Bilder werden nicht bei Cloudflare gespeichert – nur im Kie-Speicher (24 h) und im Browser.
 */
import { handlePhoto } from './photo.js';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (msg, status = 400) => json({ error: msg }, status);

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    // Anmeldung: eigene Seite + Sitzungs-Cookie (30 Tage) statt Browser-Passwortfenster
    if (p === '/api/login' && req.method === 'POST') return login(req, env, url);
    if (p === '/api/logout') return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    const open = p === '/login' || p.startsWith('/assets/') || p.startsWith('/css/');
    const ok = !env.APP_PASSWORD || await authorized(req, env);
    if (p === '/login' && ok && env.APP_PASSWORD) return Response.redirect(url.origin + safeNext(url.searchParams.get('next')), 302);
    if (!open && !ok) {
      if (p.startsWith('/api/')) return err('Nicht angemeldet', 401);
      return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(p + url.search)}`, 302);
    }
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (p === '/api/diag') return json(await diagnose(env));
      if (p.startsWith('/api/photo/')) return await handlePhoto(req, env, url, { json, err, claude, claudeReady, kieCreate, kieStatus, imgBlock, sniff });
      return err('Unbekannte Route', 404);
    } catch (e) {
      console.error(e);
      return err(e.message || String(e), e.status || 500);
    }
  }
};

/* ---------- Anmeldung ----------
 * Cookie = Ablaufzeit + HMAC(APP_PASSWORD). Nichts wird gespeichert; ein neues Passwort meldet automatisch alle ab. */
const COOKIE = 'fs_session', DAYS = 30;
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sign(env, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode('fotostudio:' + env.APP_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function safeNext(n) { return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/'; }
async function authorized(req, env) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (m) {
    const [exp, sig] = m[1].split('.');
    if (+exp > Date.now() / 1000 && sig && same(sig, await sign(env, 'v1.' + exp))) return true;
  }
  const h = req.headers.get('authorization') || ''; // weiterhin möglich, z. B. für Skripte
  if (h.startsWith('Basic ')) { try { const [, pass] = atob(h.slice(6)).split(/:(.*)/s); return same(pass || '', env.APP_PASSWORD); } catch { } }
  return false;
}
async function login(req, env, url) {
  let pass = '', next = '/';
  try { const f = await req.formData(); pass = String(f.get('password') || ''); next = safeNext(String(f.get('next') || '/')); } catch { }
  if (!env.APP_PASSWORD) return Response.redirect(url.origin + next, 303);
  if (!same(pass, env.APP_PASSWORD)) {
    await new Promise(r => setTimeout(r, 700)); // bremst Durchprobieren
    return Response.redirect(`${url.origin}/login?e=1&next=${encodeURIComponent(next)}`, 303);
  }
  const exp = Math.floor(Date.now() / 1000) + DAYS * 86400;
  return new Response(null, { status: 303, headers: { location: next, 'set-cookie': `${COOKIE}=${exp}.${await sign(env, 'v1.' + exp)}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` } });
}

/* Diagnose (nach Login): prüft Kie-Guthaben und Claude über Kie */
async function diagnose(env) {
  const out = { provider: viaKie(env) ? 'kie' : 'anthropic', model: env.CLAUDE_PHOTO_MODEL || env.CLAUDE_MODEL, kieKey: !!env.KIE_API_KEY, password: !!env.APP_PASSWORD };
  if (!env.KIE_API_KEY) return out;
  try { const r = await fetch('https://api.kie.ai/api/v1/chat/credit', { headers: { authorization: `Bearer ${env.KIE_API_KEY}` } }); out.credits = (await r.json()).data; } catch (e) { out.credits = 'Fehler: ' + e.message; }
  try {
    const t0 = Date.now();
    const r = await claudeOnce(env, { system: 'Antworte kurz.', tool: { name: 'ok', input_schema: { type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'] } }, maxTokens: 40, model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'Sag ok.' }] });
    out.claude = { ok: true, ms: Date.now() - t0, answer: r };
  } catch (e) { out.claude = { ok: false, error: e.message }; }
  return out;
}

/* Bildtyp an den ersten Bytes erkennen – Kie-Server liefern oft 'application/octet-stream' */
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
function sniff(buf, fallback) {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  return fallback && fallback.startsWith('image/') ? fallback : 'image/png';
}

/* ---------- Claude (direkt bei Anthropic oder über Kie) ---------- */
const viaKie = env => (env.CLAUDE_PROVIDER || '').toLowerCase() === 'kie';
const claudeReady = env => viaKie(env) ? !!env.KIE_API_KEY : !!env.ANTHROPIC_API_KEY;
const SAFE_MODEL = 'claude-sonnet-5-5';
/* Ruft Claude auf. Streaming (SSE) hält die Verbindung offen → keine Abbrüche bei langen Opus-Antworten.
 * Schlägt das gewählte Modell fehl, wird einmal mit Sonnet wiederholt; die Antwort enthält dann _fallback. */
async function claude(env, opts) {
  const chosen = opts.model || env.CLAUDE_MODEL || SAFE_MODEL;
  try { return await claudeOnce(env, { ...opts, model: chosen }); }
  catch (e) {
    if (chosen === SAFE_MODEL || e.noFallback) throw e;
    console.warn(`Modell ${chosen} fehlgeschlagen (${e.message}) → ${SAFE_MODEL}`);
    const out = await claudeOnce(env, { ...opts, model: SAFE_MODEL });
    out._fallback = { from: chosen, to: SAFE_MODEL, reason: e.message.slice(0, 300) };
    return out;
  }
}
async function claudeOnce(env, { system, tool, messages, maxTokens = 4000, model }) {
  const kie = viaKie(env);
  const key = kie ? env.KIE_API_KEY : env.ANTHROPIC_API_KEY;
  const url = env.CLAUDE_API_URL || (kie ? 'https://api.kie.ai/claude/v1/messages' : 'https://api.anthropic.com/v1/messages');
  const headers = kie
    ? { authorization: `Bearer ${key}`, 'x-api-key': `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream, application/json' }
    : { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
  // Kie bricht bei erzwungenem Tool-Aufruf mit 429 ab → dort JSON als Text anfordern (Schema im System-Prompt)
  const jsonMode = kie || env.CLAUDE_JSON_MODE === '1';
  const payload = jsonMode
    ? { model, max_tokens: maxTokens, stream: true, messages,
        system: `${system}\n\nAUSGABEFORMAT (zwingend): Antworte ausschließlich mit EINEM gültigen JSON-Objekt – kein Text davor oder danach, keine Markdown-Codeblöcke, keine Kommentare. Das Objekt muss diesem JSON-Schema entsprechen (Feld-Beschreibungen beachten):\n${JSON.stringify(tool.input_schema)}` }
    : { model, max_tokens: maxTokens, system, messages, tools: [tool], tool_choice: { type: 'tool', name: tool.name }, stream: true };
  const who = `Claude${kie ? ' über Kie' : ''} (${model})`;
  let lastErr = '';
  // Kie lehnt zeitweise Streaming ODER normale Anfragen mit 429 ab → abwechselnd versuchen
  const waits = [3000, 10000, 20000];
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    payload.stream = attempt % 2 === 0;
    const r = await fetch(url, { method: 'POST', body: JSON.stringify(payload), headers });
    const ct = r.headers.get('content-type') || '';
    if (!r.ok || !ct.includes('event-stream')) {
      const raw = await r.text();
      let j = {}; try { j = JSON.parse(raw); } catch { }
      const msg = j.error?.message || j.msg || j.message || raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      const kieCode = j.code && j.code !== 200 ? j.code : null;
      if (r.ok && !kieCode && (j.content || j.data?.content)) return extractResult(j.content ? j : j.data);
      lastErr = `${who}: HTTP ${r.status}${kieCode ? ' / Code ' + kieCode : ''} – ${msg || 'keine Details'}`;
      const retry = r.status === 429 || r.status === 529 || r.status >= 500 || kieCode === 429 || kieCode >= 500;
      if (retry && attempt < waits.length) { await new Promise(s => setTimeout(s, waits[attempt])); continue; }
      throw Object.assign(new Error(lastErr), { noFallback: r.status === 401 || r.status === 402 || kieCode === 401 || kieCode === 402 });
    }
    // SSE lesen
    const blocks = []; let buf = '', streamErr = null;
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += value; let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const evt = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = evt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let d; try { d = JSON.parse(data); } catch { continue; }
        if (d.type === 'content_block_start') blocks[d.index] = { ...d.content_block, _json: '', text: d.content_block.text || '' };
        else if (d.type === 'content_block_delta' && blocks[d.index]) {
          if (d.delta?.type === 'input_json_delta') blocks[d.index]._json += d.delta.partial_json || '';
          else if (d.delta?.type === 'text_delta') blocks[d.index].text += d.delta.text || '';
        } else if (d.type === 'error' || (d.code && d.code !== 200)) streamErr = d.error?.message || d.msg || JSON.stringify(d).slice(0, 200);
      }
    }
    if (streamErr) { lastErr = `${who}: ${streamErr}`; if (attempt < waits.length && /overload|rate|capacity|timeout|internal/i.test(streamErr)) { await new Promise(s => setTimeout(s, waits[attempt])); continue; } throw new Error(lastErr); }
    const content = blocks.filter(Boolean).map(b => b.type === 'tool_use' ? { type: 'tool_use', name: b.name, input: b._json ? safeJson(b._json) : b.input } : { type: 'text', text: b.text });
    return extractResult({ content });
  }
  throw new Error(lastErr || `${who}: keine Antwort`);
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function extractResult(j) {
  const tu = j.content?.find(c => c.type === 'tool_use' && c.input);
  if (tu) return tu.input;
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const v = parseJsonText(txt);
  if (v) return v;
  throw new Error('Claude hat kein verwertbares JSON geliefert: ' + txt.slice(0, 160));
}
function parseJsonText(txt) {
  let t = (txt || '').replace(/```(?:json)?/gi, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  t = t.slice(a, b + 1);
  return safeJson(t) || safeJson(t.replace(/,\s*([}\]])/g, '$1')); // tolerant gegenüber Komma vor Klammer
}
function imgBlock(dataUrl) {
  const mt = /^data:(image\/\w+);base64,/.exec(dataUrl || '');
  return { type: 'image', source: { type: 'base64', media_type: mt ? mt[1] : 'image/jpeg', data: mt ? dataUrl.slice(mt[0].length) : dataUrl } };
}
/* ---------- Kie ---------- */
const KIE_DEFAULT = 'https://api.kie.ai/api/v1/jobs';
async function kieCreate(env, model, input) {
  const r = await fetch(`${env.KIE_API_BASE || KIE_DEFAULT}/createTask`, { method: 'POST', headers: { authorization: `Bearer ${env.KIE_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, input }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code && j.code !== 200) || !j.data?.taskId) throw new Error(`Kie: ${j.msg || j.message || r.status}`);
  return j.data.taskId;
}
async function kieStatus(env, taskId) {
  const r = await fetch(`${env.KIE_API_BASE || KIE_DEFAULT}/recordInfo?taskId=${encodeURIComponent(taskId)}`, { headers: { authorization: `Bearer ${env.KIE_API_KEY}` } });
  const j = await r.json().catch(() => ({})); const d = j.data || {};
  let res = d.resultJson; if (typeof res === 'string') { try { res = JSON.parse(res); } catch { res = {}; } }
  const urls = res?.resultUrls || res?.result_urls || d.resultUrls || (res?.image ? [res.image] : []) || [];
  const state = d.state === 'success' ? 'success' : d.state === 'fail' ? 'fail' : 'running';
  return { state, urls, error: d.failMsg || (state === 'fail' ? 'Generierung fehlgeschlagen' : undefined) };
}

