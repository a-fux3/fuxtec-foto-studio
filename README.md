# FUXTEC Foto Studio

Bulk-Bearbeitung von Lieferanten-Produktfotos statt Agentur. Läuft als eigener Cloudflare Worker, Bedienung im Chrome.

**Pro Bild:** Upload in den Kie-Speicher → KI-Analyse (Claude) → Retusche nur bei Bedarf (Nano Banana 2 / Pro) → Qualitätskontrolle Original vs. Retusche → Freistellen (recraft) → im Browser: Farbkorrektur, Produkt im **900 × 900**-Rahmen auf **1200 × 1200**, Schärfen, **KI-Schatten** → **JPG weiß + PNG transparent**, alles als ZIP.

Bilder werden nicht bei Cloudflare gespeichert: Sie liegen 24 h im Kie-Speicher und ansonsten nur im Browser-Tab.

---

## 1. Einrichten (Cloudflare-Dashboard, ca. 5 Minuten)

1. **Worker anlegen:** dash.cloudflare.com → *Workers & Pages* → *Create* → *Import a repository* → GitHub → `a-fux3/fuxtec-foto-studio` auswählen.
   Projektname `fuxtec-foto-studio`, Build-Befehl leer lassen, Deploy-Befehl `npx wrangler deploy` → *Deploy*.
2. **Schlüssel hinterlegen:** Worker `fuxtec-foto-studio` → *Settings* → *Variables and Secrets* → *Add*:
   - Typ **Secret**, Name `KIE_API_KEY`, Wert = derselbe Kie-Key wie im Banner Studio
   - Typ **Secret**, Name `APP_PASSWORD`, Wert = Passwort für den Zugang (frei wählbar)
   → *Deploy*.
3. **Öffnen:** Adresse steht unter *Settings → Domains & Routes*, z. B. `https://fuxtec-foto-studio.<konto>.workers.dev`. Im Chrome öffnen → Passwort eingeben (Benutzername egal).
4. **Test:** `…/api/diag` aufrufen. Dort sollten `credits` (Kie-Guthaben) und `claude.ok: true` stehen.

Updates: Jeder Push auf `main` deployt automatisch.

**Optional:** eigene Adresse wie `fotos.fuxtec.de` unter *Settings → Domains & Routes*. Login fürs ganze Team per Firmen-E-Mail über Cloudflare Zero Trust → Access.

## 2. Bedienung

- Fotos ins Fenster ziehen (JPG, PNG, WebP, TIFF – beliebig viele). TIFF wird im Browser gelesen (8/16 Bit, LZW/ZIP/unkomprimiert, RGB/CMYK). HEIC vorher umwandeln.
- Oben: **KI-Retusche** (KI entscheidet / Aus), **Bildmodell** (Nano Banana 2 / NB Pro), **Parallel** (1–4), **Schatten-Stärke**, **Qualitätskontrolle**.
- **Klick auf ein fertiges Bild** öffnet die Detailansicht:
  - Ansicht JPG weiß / PNG transparent / Original / Retusche, 900er-Rahmen einblenden
  - Retusche an/aus, eigene Anweisung + „Retusche neu“
  - Farbe & Licht: alle KI-Werte als Regler, Tonwertkorrektur
  - Schatten: Boden / Flach / Ohne, Lichtrichtung, Stärke
  - **Bodenpunkte bearbeiten:** Klick setzt oder entfernt einen Punkt, an dem das Produkt den Boden berührt (Rad, Fuß). Daraus entsteht der Schatten.
- **Alle als ZIP:** `JPG/`, `PNG/` und `protokoll.csv` (Produkt, Retusche, QA-Ergebnis, Hinweise).
- Tab offen lassen, bis das ZIP heruntergeladen ist.

### KI-Schatten
Das freigestellte Produkt geht auf Weiß an die Bild-KI (Standard GPT Image 2.5, bei Problemen automatisch Nano Banana 2; umschaltbar auf NB 2, 2.1, Pro), die einen weichen Studioschatten malt. Übernommen wird **nur der Schatten**: Das Tool richtet das KI-Bild auf das Produkt aus und rechnet die Abdunklung außerhalb des Produkts als Schattenebene heraus. Das Produkt selbst bleibt pixelgenau der eigene Freisteller, auch im PNG mit transparentem Hintergrund.
Zeichnet die KI das Produkt zu stark neu oder färbt den Hintergrund, wird automatisch der berechnete Schatten genommen (Hinweis „Schatten berechnet“). In der Detailansicht: KI-Schatten/Berechnet umschalten, Modell wählen, „KI-Schatten neu erzeugen“, Stärke 0–200 %.

### Standard ohne Einstellen
Bei jedem Öffnen gilt derselbe Standard: Retusche nach KI-Entscheidung, Qualitätskontrolle an, KI-Schatten mit GPT Image 2.5, 3 Bilder parallel. „Erweiterte Einstellungen“ sind eingeklappt und gelten nur bis zum Neuladen. Oben zeigt eine Leiste den Gesamtfortschritt aller hochgeladenen Bilder, am Ende mit „Alle als ZIP herunterladen“.

### Kanten-Rettung (PNG)
Freisteller-KIs verschlucken gern feine Strukturen (Sägekette, Gitter, Speichen). Bei einfarbigem Studiogrund holt das Tool diese Details aus dem Originalfoto zurück und entfärbt halbtransparente Kanten, damit im PNG kein heller Saum bleibt. Die Freistellung läuft dafür mit bis zu 3200 px.

## 3. Einstellungen (`wrangler.jsonc` → `vars`)

| Variable | Standard | Zweck |
|---|---|---|
| `CLAUDE_PROVIDER` | `kie` | `kie` = Claude über den Kie-Key · `anthropic` = eigener Key (`ANTHROPIC_API_KEY` als Secret) |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Analyse + Qualitätskontrolle (fällt bei Fehler einmal auf Sonnet zurück) |
| `KIE_EDIT_MODEL` | `nano-banana-2` | Standard-Retuschemodell |
| `KIE_REMOVE_BG_MODEL` | `recraft/remove-background` | Freistellen |
| `KIE_SHADOW_MODEL` | `gpt-image-2-5-flare-image-to-image` | Standardmodell für den KI-Schatten (Fallback: nano-banana-2) |

## 4. Lokal testen

```bash
npm install
cp .dev.vars.example .dev.vars   # Keys eintragen – oder leer lassen für den Testmodus
npm run dev                      # → http://localhost:8787
```
Ohne Keys läuft ein Testmodus: keine KI, einfacher Weiß-Freisteller, Schatten und Export funktionieren normal.

## 5. Aufbau

```
src/worker.js         Passwortschutz, Claude (über Kie), Kie-Aufgaben, /api/diag
src/photo.js          API /api/photo/*: Upload, Analyse, Retusche, QA, Freistellen, Fetch-Proxy
src/photo-prompts.js  Analyse-, Retusche- und QA-Prompts (hier nachschärfen)
public/index.html     Oberfläche
public/js/foto.js     Pipeline, Warteschlange, Detailansicht, ZIP
public/js/photofx.js  Farbkorrektur, 900er-Rahmen, Schärfen, Schatten, Export
```

## 6. Bekannte Grenzen

- **Produkttreue:** Generative Retusche kann Details verändern. Die Qualitätskontrolle fängt das meist ab; im Zweifel in der Detailansicht „Retusche verwenden“ ausschalten.
- **Bodenpunkte:** Die KI schätzt sie, der Code rastet sie an der echten Unterkante ein. Bei ungewöhnlichen Ansichten in der Detailansicht nachsetzen.
- **Kie-Schnittstelle:** Aufrufe in `kieCreate` / `kieStatus` (`src/worker.js`) und Upload in `src/photo.js`, falls Kie Feldnamen ändert.
