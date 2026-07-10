#!/usr/bin/env node
/**
 * fetch-prices.js — récupère les prix RAW des cartes côté serveur (GitHub Action)
 * et écrit prices.json à la racine du repo. Tourne sur les runners GitHub (accès
 * internet ouvert), donc pas de blocage CORS comme dans le navigateur.
 *
 * Source: pokemontcg.io (gratuit). Renvoie cardmarket.prices (EUR) et
 * tcgplayer.prices (USD) pour la carte EN correspondante — c'est une valeur RAW
 * indicative (le marché FR/JP réel peut différer, d'où le champ `sourceLang`).
 *
 * Les identités de cartes sont extraites directement de poke-tracker.html
 * (CLASSEUR_CARDS, DEFAULT_OWNED, GRADING_META, DEFAULT_WATCH) pour éviter toute
 * duplication de données.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HTML = path.join(ROOT, "poke-tracker.html");
const OUT = path.join(ROOT, "prices.json");
const API = "https://api.pokemontcg.io/v2/cards";
const API_KEY = process.env.POKEMONTCG_IO_API_KEY || "";

// ── Extraction robuste d'un littéral `const NAME = [...]` / `{...}` ───────────
// Scanner conscient des chaînes et des commentaires, pour ne pas se faire piéger
// par un // commentaire contenant une apostrophe ou un crochet.
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
    if (str) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === str) str = null;
      continue;
    }
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
  if (!lit) { console.warn(`⚠️  ${name} introuvable`); return name.endsWith("META") ? {} : []; }
  try {
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${lit});`)();
  } catch (e) {
    console.warn(`⚠️  éval ${name} échouée: ${e.message}`);
    return name.endsWith("META") ? {} : [];
  }
}

// ── Construction de la requête pokemontcg.io par carte ───────────────────────
function watchQuery(c) {
  const num = (c.number || "").split("/")[0].replace(/[^0-9A-Za-z]/g, "");
  const nm = (c.name || "").replace(/"/g, "").split(" (")[0];
  if (!nm) return null;
  return num ? `name:"${nm}" number:${num}` : `name:"${nm}"`;
}

async function apiPrices(query) {
  const url = `${API}?q=${encodeURIComponent(query)}&pageSize=1&select=id,name,cardmarket,tcgplayer`;
  const headers = API_KEY ? { "X-Api-Key": API_KEY } : {};
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (r.status === 429) { await sleep(2500); throw new Error("429 rate-limited"); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  const card = d?.data?.[0];
  if (!card) return null;
  const cm = card.cardmarket?.prices || null;
  const tp = card.tcgplayer?.prices || null;
  let raw = null, currency = null, source = null, extra = {};
  if (cm && (cm.trendPrice || cm.averageSellPrice || cm.avg30)) {
    raw = cm.trendPrice ?? cm.averageSellPrice ?? cm.avg30;
    currency = "EUR"; source = "cardmarket";
    extra = { low: cm.lowPrice ?? null, avg30: cm.avg30 ?? null, trend: cm.trendPrice ?? null };
  } else if (tp) {
    const variant = tp.holofoil || tp.reverseHolofoil || tp.normal || Object.values(tp)[0];
    if (variant?.market || variant?.mid) {
      raw = variant.market ?? variant.mid;
      currency = "USD"; source = "tcgplayer";
      extra = { low: variant.low ?? null, high: variant.high ?? null };
    }
  }
  if (raw == null) return null;
  return { raw: Math.round(raw * 100) / 100, currency, source, ptcgioId: card.id, ...extra };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const html = fs.readFileSync(HTML, "utf8");
  const CLASSEUR = evalLiteral(html, "CLASSEUR_CARDS");
  const OWNED = evalLiteral(html, "DEFAULT_OWNED");
  const META = evalLiteral(html, "GRADING_META");
  const WATCH = evalLiteral(html, "DEFAULT_WATCH");

  // Liste unifiée { id, query, lang }
  const jobs = [];
  for (const c of CLASSEUR) if (c.ptcgioQ) jobs.push({ id: c.id, query: c.ptcgioQ, lang: c.lang, name: c.name });
  for (const c of OWNED) {
    const q = META[c.id]?.ptcgioQ;
    if (q) jobs.push({ id: c.id, query: q, lang: c.lang, name: c.name });
  }
  for (const c of WATCH) {
    const q = watchQuery(c);
    if (q) jobs.push({ id: String(c.id), query: q, lang: c.lang, name: c.name });
  }

  console.log(`${jobs.length} cartes à interroger… (CLASSEUR ${CLASSEUR.length}, OWNED ${OWNED.length}, WATCH ${WATCH.length})`);
  if (process.argv.includes("--dry")) {
    console.log("Mode --dry : pas d'appel API. Échantillon des requêtes :");
    jobs.slice(0, 8).forEach(j => console.log(`  ${j.id} [${j.lang}] → ${j.query}`));
    const noQ = CLASSEUR.filter(c => !c.ptcgioQ).map(c => c.id);
    if (noQ.length) console.log(`  (classeur sans ptcgioQ: ${noQ.join(", ")})`);
    return;
  }
  const out = {};
  let ok = 0, miss = 0, err = 0;
  for (const j of jobs) {
    try {
      const p = await apiPrices(j.query);
      if (p) { out[j.id] = { ...p, sourceLang: "EN", ts: Date.now() }; ok++; }
      else { miss++; }
    } catch (e) {
      err++;
      console.warn(`  ✗ ${j.id} (${j.name}): ${e.message}`);
    }
    await sleep(120);
  }

  const payload = { generatedAt: new Date().toISOString(), count: ok, cards: out };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`✅ prices.json écrit — ${ok} prix, ${miss} sans prix, ${err} erreurs`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
