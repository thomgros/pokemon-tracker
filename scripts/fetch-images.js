#!/usr/bin/env node
/**
 * fetch-images.js — résout l'illustration dans la LANGUE NATIVE de chaque carte
 * (FR→FR, JP→JP, EN→EN) côté serveur (runner GitHub = internet ouvert, ni CORS ni
 * ad-block ni proxy), en VÉRIFIANT que chaque URL renvoie bien une image (HTTP 200),
 * puis écrit images.json { [id]: { url, lang, source } }.
 *
 * L'app charge images.json et l'utilise en priorité sur la cascade live : les
 * illustrations natives s'affichent instantanément et de façon fiable. Si images.json
 * est absent/vide, l'app se comporte exactement comme avant (repli sur la cascade).
 *
 * Ordre des sources pour une carte FR : TCGdex FR (API + CDN) → pkmcards.fr →
 * Pokedexia → (dernier recours) TCGdex EN. Seules les URLs vérifiées sont écrites.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HTML = path.join(ROOT, "poke-tracker.html");
const OUT = path.join(ROOT, "images.json");

// ── Réutilise l'extraction de littéraux de fetch-prices ──────────────────────
function extractLiteral(src, name) {
  const anchor = src.indexOf(`const ${name} =`);
  if (anchor === -1) return null;
  let i = src.indexOf("=", anchor) + 1;
  while (/\s/.test(src[i])) i++;
  const open = src[i];
  const close = open === "[" ? "]" : "}";
  if (open !== "[" && open !== "{") return null;
  let depth = 0, str = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const ch = src[j], nx = src[j + 1];
    if (str) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === str) str = null; continue; }
    if (ch === "/" && nx === "/") { const e = src.indexOf("\n", j); j = e === -1 ? src.length : e; continue; }
    if (ch === "/" && nx === "*") { const e = src.indexOf("*/", j); j = e === -1 ? src.length : e + 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { str = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}
function evalLiteral(src, name) {
  const lit = extractLiteral(src, name);
  if (!lit) return [];
  try { return Function(`"use strict"; return (${lit});`)(); } catch { return []; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LANG_API = { FR: "fr", JP: "ja", EN: "en" };

// Slug façon pkmcards.fr : minuscules, accents retirés, non-alphanum → "-".
const slug = s => (s || "")
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Correspondance code interne (tcgdex) → { slug pkmcards, slug nom complet du set }.
// Étendable au fur et à mesure (les URLs non vérifiées sont ignorées sans risque).
const PKM = {
  "me03": { s: "por", full: "mega-evolution-equilibre-parfait" },
  "me04": { s: "cri", full: "mega-evolution-chaos-ascendant" },
  "sv03": { s: "obf", full: "ecarlate-et-violet-flammes-obsidiennes" },
  "plt":  { s: "pl",  full: "platine" },
};

// Vérifie qu'une URL renvoie bien une image (200/206 + content-type image).
async function isImage(url) {
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10000), headers: { Range: "bytes=0-0", "User-Agent": "Mozilla/5.0" } });
    if (!(r.status === 200 || r.status === 206)) return false;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    return ct.startsWith("image");
  } catch { return false; }
}

async function tcgdexApi(lang, id) {
  try {
    const r = await fetch(`https://api.tcgdex.net/v2/${lang}/cards/${id}`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.image ? `${d.image}/high.webp` : null;
  } catch { return null; }
}

// Construit la liste ordonnée d'URLs candidates pour une carte.
function candidates(card) {
  const [setCode, numRaw] = card.tcgdex.split("-");
  const num = numRaw;
  const pad = numRaw.padStart(3, "0");
  const lang = LANG_API[card.lang] || "en";
  const series = setCode.startsWith("SV") ? "SV" : (setCode.startsWith("M") ? "M" : null);
  const list = [];

  // 1. CDN TCGdex natif (deviné)
  if (series) for (const n of [pad, num]) list.push({ url: `https://assets.tcgdex.net/${lang}/${series}/${setCode}/${n}/high.webp`, lang, source: "tcgdex-cdn", api: false });
  // 2. API TCGdex natif (chemin exact)
  list.push({ apiLang: lang, source: "tcgdex-api", api: true });
  // 3. pkmcards.fr (FR uniquement, sets connus)
  if (card.lang === "FR" && PKM[setCode]) {
    const m = PKM[setCode];
    list.push({ url: `https://static.pkmcards.fr/cards/fr/${m.s}/image-cartes-a-collectionner-pokemon-card-game-tcg-pkmcards-${m.s}-fr-${pad}-${m.full}-${slug(card.name)}.webp`, lang: "fr", source: "pkmcards", api: false });
  }
  // 4. Pokedexia (promos ME FR) — motif déjà utilisé par l'app
  if (card.lang === "FR" && setCode === "mep") {
    list.push({ url: `https://cdn.pokedexia.com/cards/me/promos-mega-evolution/cards/MEP-${pad}-high.webp`, lang: "fr", source: "pokedexia", api: false });
    list.push({ url: `https://cdn.pokedexia.com/cards/me/promos-mega-evolution/cards/MEP-${pad}-v2-high.webp`, lang: "fr", source: "pokedexia", api: false });
  }
  // 5. Dernier recours : EN via API TCGdex
  if (card.lang !== "EN") list.push({ apiLang: "en", source: "tcgdex-api-en", api: true, en: true });
  return list;
}

async function resolve(card) {
  for (const c of candidates(card)) {
    let url = c.url;
    if (c.api) {
      url = (await tcgdexApi(c.apiLang, card.tcgdex)) || (await tcgdexApi(c.apiLang, `${card.tcgdex.split("-")[0]}-${card.tcgdex.split("-")[1].padStart(3, "0")}`));
      if (!url) continue;
    }
    if (await isImage(url)) return { url, lang: c.en ? "en" : (c.lang || LANG_API[card.lang]), source: c.source };
  }
  return null;
}

async function main() {
  const html = fs.readFileSync(HTML, "utf8");
  const CLASSEUR = evalLiteral(html, "CLASSEUR_CARDS");
  // On résout les cartes qui ont un code tcgdex et PAS d'image codée en dur
  // (celles-là s'appuient sur la cascade live et peuvent tomber en repli EN).
  const cards = CLASSEUR.filter(c => c.tcgdex && !c.img);
  console.log(`${cards.length} cartes à résoudre (sur ${CLASSEUR.length})`);

  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")).cards || {}; } catch {}

  const out = {};
  let fr = 0, ja = 0, en = 0, miss = 0;
  for (const card of cards) {
    // Conserve une résolution native déjà trouvée (évite de retomber en EN si la source flanche un jour)
    const p = prev[card.id];
    if (p && p.lang === (LANG_API[card.lang] || "en") && p.lang !== "en") { out[card.id] = p; if (p.lang === "fr") fr++; else if (p.lang === "ja") ja++; continue; }
    const r = await resolve(card);
    // On n'écrit QUE du natif (FR/JP) — jamais un repli EN pour une carte FR/JP :
    // sinon on court-circuiterait la cascade live qui peut trouver le natif ailleurs.
    if (r && (r.lang !== "en" || card.lang === "EN")) {
      out[card.id] = r; if (r.lang === "fr") fr++; else if (r.lang === "ja") ja++; else en++;
    } else { miss++; }
    await sleep(60);
  }

  const payload = { generatedAt: new Date().toISOString(), count: Object.keys(out).length, cards: out };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`✅ images.json — ${fr} FR, ${ja} JP, ${en} EN(repli), ${miss} introuvables`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
