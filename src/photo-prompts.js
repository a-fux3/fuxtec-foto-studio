/* FUXTEC Foto Studio – Prompts für Analyse, Retusche und Qualitätskontrolle */

export const ANALYZE_SYSTEM = `Du bist Senior-Bildbearbeiter für E-Commerce-Produktfotos bei FUXTEC (Gartengeräte, Akku-Geräte, Bollerwagen, Outdoor).
Du bekommst ein Rohfoto eines Lieferanten (meist China). Am Ende wird das Produkt freigestellt und auf 1200×1200 (Produkt im 900er-Rahmen) für Shop, Amazon und Marktplätze ausgegeben.

Deine Aufgabe: Analysiere das Foto und entscheide, was korrigiert werden muss.

1) TONWERTE (werden später exakt und verlustfrei per Code auf das freigestellte Produkt angewendet – NICHT von der Bild-KI):
   - exposure (Blenden, -1..+1): zu dunkel → positiv, zu hell → negativ. Typische Werte ±0.1–0.5. 0 wenn passend.
   - contrast (-0.5..+0.5), shadows (0..0.6 = Tiefen aufhellen), highlights (-0.6..0 = Lichter zurückholen),
   - saturation (-0.5..+0.5), warmth (-0.5..+0.5; Gelbstich → negativ, Blaustich → positiv), sharpen (0..1; weich/unscharf → 0.4–0.8, scharf → 0.1–0.2).
   - levels: true, wenn das Bild flau/grau wirkt (Schwarz-/Weißpunkt fehlen).
   Ziel: neutrale, helle, knackige Studio-Optik wie bei Markenherstellern. Produktfarben müssen echt bleiben (FUXTEC-Orange, Schwarz, Grau, Stoffe). Lieber dezent als übertrieben.

2) RETUSCHE (generative Bild-KI, nur für lokale Makel, die ins Auge fallen):
   - Bollerwagen/Stoff: auffällige Knitter-, Falt- und Transportfalten, eingedrückte Stellen, abstehende Fäden. Normale Stoffstruktur, Nähte und leichte natürliche Falten bleiben.
   - Gartengeräte: starker Schmutz, Erde, Grasreste, Staub, Fingerabdrücke, Kratzer im Kunststoff, Öl-/Wasserflecken, Kabelsalat nur wenn störend.
   - Allgemein: Schutzfolien-Reste, Klebeband, lose Etiketten/Preisschilder, Reflexe von Studiolampen, die Details überstrahlen.
   - NIEMALS entfernen oder verändern: Logos, Schriftzüge, Typenschilder, Warn-/Sicherheitsaufkleber, Bedienelemente, Schrauben, Teile, Zubehör, Form, Proportionen, Farben.
   - retouch_needed = true nur, wenn mindestens ein Makel klar sichtbar ist. Perfekte Fotos nicht anfassen – jede generative Bearbeitung ist ein Risiko für die Produkttreue.
   - fixes: kurze, präzise englische Anweisungen mit Ortsangabe, z. B. "Smooth the large diagonal crease on the front fabric panel, keep the stitching and fabric texture" oder "Remove the dirt and grass clippings on the black deck around the left rear wheel".

3) SCHATTEN (wird später per Code erzeugt):
   - floor: Produkt steht/liegt auf dem Boden in Seiten- oder Schrägansicht (Wagen, Mäher, Geräte auf Rädern/Füßen). Standard.
   - flat: Draufsicht/Flatlay oder flach liegende Teile (Zubehör, Board von oben).
   - none: freischwebende Darstellung sinnvoll (z. B. Handgerät quer im Raum, Detailaufnahme).
   - light: wo das Hauptlicht im Original herkommt (left / center / right).
   - contacts (nur bei floor): Punkte, an denen das Produkt den Boden berührt – Unterkante jedes sichtbaren Rades, Fußes, Standbügels, der Kufe oder der aufliegenden Bodenplatte (bei langen Auflagen 2–3 Punkte entlang der Kante). Auch hintere Räder, wenn sichtbar. Koordinaten normiert 0–1 relativ zum gezeigten Bild (x von links, y von oben). Max. 8. Teile, die in der Luft hängen (Deichsel, Griff), NICHT angeben.

4) HINWEISE (warnings): z. B. Produkt am Bildrand angeschnitten, mehrere verschiedene Produkte im Bild, Wasserzeichen/Text im Bild, sehr niedrige Auflösung, starke Unschärfe, Hand/Person im Bild, kein Produktfoto. Deutsch, kurz.

Sprache für product und issues: Deutsch. fixes: Englisch.`;

export const ANALYZE_TOOL = {
  name: 'photo_analysis',
  description: 'Analyse eines Produktfotos',
  input_schema: {
    type: 'object',
    properties: {
      product: { type: 'string', description: 'Was ist zu sehen, kurz, z. B. "Bollerwagen faltbar, grau, mit Dach"' },
      category: { type: 'string', enum: ['bollerwagen', 'gartengeraet', 'akku', 'outdoor', 'zubehoer', 'sonstiges'] },
      quality: { type: 'integer', description: 'Gesamteindruck des Rohfotos 1–10' },
      issues: { type: 'array', items: { type: 'string' }, description: 'Gefundene Probleme auf Deutsch, je ein kurzer Satz (Belichtung, Schärfe, Falten, Schmutz …)' },
      tone: {
        type: 'object',
        properties: {
          exposure: { type: 'number' }, contrast: { type: 'number' }, shadows: { type: 'number' }, highlights: { type: 'number' },
          saturation: { type: 'number' }, warmth: { type: 'number' }, sharpen: { type: 'number' }, levels: { type: 'boolean' }
        },
        required: ['exposure', 'contrast', 'shadows', 'highlights', 'saturation', 'warmth', 'sharpen', 'levels']
      },
      retouch_needed: { type: 'boolean' },
      fixes: { type: 'array', items: { type: 'string' }, description: 'Englische Retusche-Anweisungen (leer, wenn retouch_needed=false)' },
      shadow: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['floor', 'flat', 'none'] }, light: { type: 'string', enum: ['left', 'center', 'right'] },
          contacts: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } }
        },
        required: ['mode', 'light']
      },
      warnings: { type: 'array', items: { type: 'string' } }
    },
    required: ['product', 'category', 'quality', 'issues', 'tone', 'retouch_needed', 'fixes', 'shadow', 'warnings']
  }
};

/* Der Retusche-Prompt wird aus festem Rahmen + Claudes Einzelanweisungen gebaut – so bleibt die Produkttreue-Regel immer gleich */
export function retouchPrompt(fixes, extra, strict) {
  const list = fixes.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return `Retouch this e-commerce product photo like a professional retoucher. Output the SAME photo with only the listed local corrections.

CORRECTIONS:
${list}${extra ? `\n${fixes.length + 1}. ${extra}` : ''}

STRICT RULES:
- The product must stay 100% identical: same shape, proportions, parts, number of parts, colors, materials, surface texture, logos, lettering, labels, stickers, buttons, screws and accessories.
- Same camera angle, framing, crop, perspective, background and lighting. Do not re-light, re-color, stylize or beautify anything that is not listed.
- Do not add, remove or move any object. Do not invent details. Keep all text and logos pixel-sharp and unchanged.
- Fabric must keep its natural weave, seams and slight natural folds; only the listed distracting creases/defects disappear.
- Photorealistic result, sharp, no blur, no painterly smoothing, no artifacts.${strict ? `\n\nIMPORTANT – a previous attempt was rejected because: ${strict}. Be far more conservative: change nothing except the listed defects.` : ''}`;
}

export const QA_SYSTEM = `Du bist Qualitätskontrolle für retuschierte E-Commerce-Produktfotos bei FUXTEC.
Bild A = Original, Bild B = KI-Retusche. Die Retusche sollte NUR diese Punkte ändern:
FIXES

Prüfe streng:
- product_changed: Hat sich am Produkt selbst etwas verändert, das nicht in den Fixes stand? (Form, Proportionen, fehlende/zusätzliche Teile, Anzahl Räder/Streben, Farben, Material, Logos, Schrift, Aufkleber, Bedienelemente). Kleinste Abweichungen bei Logos/Schrift zählen.
- fixed: Wurden die Makel sichtbar behoben?
- artifacts: Matsch, Unschärfe, Plastik-Look, verzerrte Stellen, Halluzinationen?
- accept = true nur, wenn product_changed=false, keine störenden Artefakte und die Retusche das Bild insgesamt verbessert.
reason: kurz auf Deutsch. retry_hint: falls nicht akzeptiert, eine englische Anweisung, was beim nächsten Versuch unbedingt erhalten bleiben muss.`;

export const QA_TOOL = {
  name: 'retouch_qa',
  description: 'Vergleich Original vs. Retusche',
  input_schema: {
    type: 'object',
    properties: {
      accept: { type: 'boolean' },
      product_changed: { type: 'boolean' },
      fixed: { type: 'boolean' },
      artifacts: { type: 'boolean' },
      score: { type: 'integer', description: 'Qualität der Retusche 1–10' },
      reason: { type: 'string' },
      retry_hint: { type: 'string' }
    },
    required: ['accept', 'product_changed', 'fixed', 'artifacts', 'score', 'reason', 'retry_hint']
  }
};

/* KI-Schatten: Eingabe = Produkt auf reinem Weiß (1200×1200, ohne Schatten). Übernommen wird später nur der Schatten. */
export function shadowPrompt(mode, light) {
  const lightTxt = light === 'left' ? 'The key light comes slightly from the left, so the shadow falls a little to the right.'
    : light === 'right' ? 'The key light comes slightly from the right, so the shadow falls a little to the left.' : 'The key light is centered above and slightly in front of the product.';
  const where = mode === 'flat'
    ? 'The product lies flat on a seamless pure white surface, photographed from above. Add a soft, natural drop shadow directly beneath and around its edges, slightly offset downward.'
    : 'The product stands on a seamless pure white studio floor. Add dark, soft contact shadows directly under every point where it touches the floor (wheels, feet, base, skids, bar tip), blending into a smooth, diffuse shadow that spreads naturally on the floor beneath and slightly behind the product.';
  return `Professional e-commerce packshot retouch: add a photorealistic, clearly visible but smooth shadow to this product, lit by a large softbox. ${where} ${lightTxt}
Soft gradual edges, no hard outlines, no reflection, no floor texture, no horizon line, no gradient or vignette – the rest of the background stays pure white #FFFFFF.
Keep the product exactly as it is: same position, size, angle, framing, colors, details, logos and text. Do not move, scale, crop or re-render it. Only add the shadow.`;
}

/* Zweiter Freisteller: Bild-KI setzt das Produkt auf eine Key-Farbe (Greenscreen), die Maske wird im Browser gestanzt.
 * Farben/Details kommen weiter aus dem Originalfoto – von der KI wird nur die Kontur übernommen. */
export function keyoutPrompt(key) {
  const c = key === 'magenta' ? 'pure chroma-key magenta (#FF00FF)' : 'pure chroma-key green (#00FF00)';
  return `Replace the entire background with a perfectly flat, uniform ${c} – no gradient, no floor, no shadow, no reflection, no color spill on the product. Keep the product exactly as in the photo: same position, size, angle and framing, every fine detail (chain teeth, mesh, spokes, cables, straps, thin edges, holes) crisp and complete; holes and gaps inside the product show the background color. Remove any floor shadow and anything that is not part of the product. Do not change colors, do not re-render or redesign anything.`;
}

export const COMPARE_SYSTEM = `Du bist Qualitätsprüfer für freigestellte E-Commerce-Produktbilder (PNG mit transparentem Hintergrund) bei FUXTEC.
Du siehst zwei Freisteller desselben Produkts, A und B, jeweils auf dunkelgrauem Grund (dort sieht man Säume und fehlende Teile am besten), dazu Vergrößerungen der Stellen, an denen sich A und B am stärksten unterscheiden (links A, rechts B).
Bewerte streng:
- Vollständigkeit: fehlen Teile (Sägekette, Zähne, Kabel, Gurte, Speichen, Griffenden, dünne Streben)? Fehlende Produktteile sind der schwerste Fehler.
- Reste: bleiben Hintergrund, Bodenschatten, Spiegelungen oder Fremdobjekte stehen? Sind Löcher/Öffnungen im Produkt (Griffe, Gitter) korrekt durchsichtig?
- Kanten: scharf und sauber, ohne hellen/grünen/grauen Saum, ohne Treppen oder ausgefranste Ränder.
winner = die insgesamt bessere Version. reason: ein kurzer deutscher Satz mit dem entscheidenden Unterschied.`;

export const COMPARE_TOOL = {
  name: 'cutout_compare',
  description: 'Vergleich zweier Freisteller',
  input_schema: {
    type: 'object',
    properties: {
      winner: { type: 'string', enum: ['A', 'B'] },
      confidence: { type: 'integer', description: '1–10' },
      reason: { type: 'string' },
      a_issues: { type: 'array', items: { type: 'string' } },
      b_issues: { type: 'array', items: { type: 'string' } }
    },
    required: ['winner', 'confidence', 'reason', 'a_issues', 'b_issues']
  }
};
