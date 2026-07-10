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

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Extraction du prix RAW depuis un objet carte pokemontcg.io.
function extractPrice(card) {
  if (!card) return null;
  const cm = card.cardmarket && card.cardmarket.prices;
  const tp = card.tcgplayer && card.tcgplayer.prices;
  if (cm && (cm.trendPrice || cm.averageSellPrice || cm.avg30)) {
    const raw = cm.trendPrice ?? cm.averageSellPrice ?? cm.avg30;
    return { raw: Math.round(raw * 100) / 100, currency: "EUR", source: "cardmarket", ptcgioId: card.id,
             low: cm.lowPrice ?? null, avg30: cm.avg30 ?? null, trend: cm.trendPrice ?? null };
  }
  if (tp) {
    const v = tp.holofoil || tp.reverseHolofoil || tp.normal || Object.values(tp)[0];
    if (v && (v.market || v.mid)) {
      const raw = v.market ?? v.mid;
      return { raw: Math.round(raw * 100) / 100, currency: "USD", source: "tcgplayer", ptcgioId: card.id,
               low: v.low ?? null, high: v.high ?? null };
    }
  }
  return null;
}

// fetch JSON avec timeout + retries (504/429/timeout fréquents sur pokemontcg.io).
async function fetchJson(url, tries = 3) {
  const headers = API_KEY ? { "X-Api-Key": API_KEY } : {};
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (r.status === 429 || r.status === 502 || r.status === 503 || r.status === 504) {
        lastErr = new Error(`HTTP ${r.status}`); await sleep(2000 * (i + 1)); continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { lastErr = e; await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

// Toutes les cartes d'un set (pageSize 250) → 1 requête au lieu de N.
async function fetchSet(setId) {
  const url = `${API}?q=${encodeURIComponent("set.id:" + setId)}&pageSize=250&select=id,name,number,cardmarket,tcgplayer`;
  const d = await fetchJson(url);
  return (d && d.data) || [];
}

async function fetchOne(query) {
  const url = `${API}?q=${encodeURIComponent(query)}&pageSize=1&select=id,name,number,cardmarket,tcgplayer`;
  const d = await fetchJson(url);
  return d && d.data && d.data[0] ? d.data[0] : null;
}

const parseQ = q => ({
  setId:  (q.match(/set\.id:([^\s]+)/) || [])[1] || null,
  number: (q.match(/number:([^\s]+)/) || [])[1] || null,
  name:   (q.match(/name:"([^"]+)"/) || [])[1] || null,
});
const normNum = n => String(n == null ? "" : n).replace(/^0+/, "").toLowerCase();

async function main() {
  const html = fs.readFileSync(HTML, "utf8");
  const CLASSEUR = evalLiteral(html, "CLASSEUR_CARDS");
  const OWNED = evalLiteral(html, "DEFAULT_OWNED");
  const META = evalLiteral(html, "GRADING_META");
  const WATCH = evalLiteral(html, "DEFAULT_WATCH");

  const jobs = [];
  for (const c of CLASSEUR) if (c.ptcgioQ) jobs.push({ id: c.id, q: c.ptcgioQ, lang: c.lang, name: c.name, p: parseQ(c.ptcgioQ) });
  for (const c of OWNED) { const q = META[c.id] && META[c.id].ptcgioQ; if (q) jobs.push({ id: c.id, q, lang: c.lang, name: c.name, p: parseQ(q) }); }
  for (const c of WATCH) { const q = watchQuery(c); if (q) jobs.push({ id: String(c.id), q, lang: c.lang, name: c.name, p: parseQ(q) }); }

  console.log(`${jobs.length} cartes (CLASSEUR ${CLASSEUR.length}, OWNED ${OWNED.length}, WATCH ${WATCH.length})`);
  if (process.argv.includes("--dry")) {
    const bySet = {}; jobs.forEach(j => { const k = (j.p.setId && j.p.number) ? j.p.setId : "(nom)"; bySet[k] = (bySet[k] || 0) + 1; });
    console.log("Regroupement par set :", JSON.stringify(bySet));
    return;
  }

  // 1) Regrouper par set.id (avec number) → 1 requête / set
  const bySet = {};
  const leftovers = [];
  for (const j of jobs) {
    if (j.p.setId && j.p.number) (bySet[j.p.setId] = bySet[j.p.setId] || []).push(j);
    else leftovers.push(j);
  }

  const out = {};
  let ok = 0, miss = 0, err = 0;
  const setIds = Object.keys(bySet);
  console.log(`${setIds.length} sets à interroger + ${leftovers.length} requêtes par nom`);

  for (const setId of setIds) {
    try {
      const cards = await fetchSet(setId);
      const byNum = {};
      for (const c of cards) byNum[normNum(c.number)] = c;
      for (const j of bySet[setId]) {
        const card = byNum[normNum(j.p.number)];
        const price = extractPrice(card);
        if (price) { out[j.id] = { ...price, sourceLang: "EN", ts: Date.now() }; ok++; }
        else miss++;
      }
      if (!cards.length) console.warn(`  · set ${setId}: 0 carte (set inconnu de pokemontcg.io ?)`);
    } catch (e) {
      err += bySet[setId].length;
      console.warn(`  ✗ set ${setId}: ${e.message}`);
    }
    await sleep(150);
  }

  // 2) Requêtes par nom (watch, ou cartes sans numéro)
  for (const j of leftovers) {
    try {
      const price = extractPrice(await fetchOne(j.q));
      if (price) { out[j.id] = { ...price, sourceLang: "EN", ts: Date.now() }; ok++; }
      else miss++;
    } catch (e) { err++; console.warn(`  ✗ ${j.id} (${j.name}): ${e.message}`); }
    await sleep(150);
  }

  const payload = { generatedAt: new Date().toISOString(), count: ok, cards: out };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`✅ prices.json — ${ok} prix, ${miss} sans prix, ${err} erreurs`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
