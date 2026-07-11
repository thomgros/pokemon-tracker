#!/usr/bin/env node
/**
 * fetch-prices.js — vrais prix via PriceCharting (côté serveur, runner GitHub).
 * Pour chaque carte : résolution « nom-de-set-EN + numéro » → page produit →
 * RAW (Ungraded) + PSA 9 (Grade 9) + PSA 10 + historique réel. USD converti en €.
 * Écrit prices.json { [id]: { raw, psa9, psa10, currency:"EUR", history:[{t,raw}], source, url } }.
 *
 * Les cartes FR/JP se résolvent automatiquement vers leur équivalent EN via set+numéro
 * (ex. Méga-Amphinobi ex 22 → Mega Greninja ex, Chaos Rising).
 *
 * Modes : `--validate` (log un échantillon sans écrire) · `--sample N`.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const HTML = path.join(ROOT, "poke-tracker.html");
const OUT = path.join(ROOT, "prices.json");
const USD_EUR = 0.92;

// ── Extraction de littéraux depuis le HTML ───────────────────────────────────
function extractLiteral(src, name) {
  const anchor = src.indexOf(`const ${name} =`);
  if (anchor === -1) return null;
  let i = src.indexOf("=", anchor) + 1;
  while (/\s/.test(src[i])) i++;
  const open = src[i], close = open === "[" ? "]" : "}";
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
  if (!lit) return name.endsWith("META") ? {} : [];
  try { return Function(`"use strict"; return (${lit});`)(); }
  catch { return name.endsWith("META") ? {} : []; }
}

// ── Table set interne → nom PriceCharting (EN) ───────────────────────────────
// Clé = code tcgdex (avant le "-"). Étendable ; carte non mappée = ignorée (repli app).
const PC_SET = {
  me01: "Mega Evolution", me02: "Phantasmal Flames", "me02.5": "Ascended Heroes",
  me03: "Perfect Order", me04: "Chaos Rising", mep: "Mega Evolution Black Star Promos",
  sv01: "Scarlet Violet", sv02: "Paldea Evolved", sv03: "Obsidian Flames",
  sv05: "Temporal Forces", sv10: "Destined Rivals", plt: "Platinum",
  swsh1: "Sword Shield", swsh4: "Vivid Voltage", sv3pt5: "151",
  base1: "Base Set", base2: "Jungle", base3: "Fossil", base5: "Team Rocket", neo1: "Neo Genesis",
  SV11B: "Japanese Black Bolt", SV4K: "Japanese Ancient Roar", SV2P: "Japanese Clay Burst",
  SV2a: "Japanese 151", S4a: "Japanese Shiny Star V",
};
// Repli par texte du champ `set` (cartes owned/watch sans tcgdex).
const PC_SET_TEXT = {
  "neo genesis": "Neo Genesis", "fossil": "Fossil", "jungle": "Jungle", "team up": "Team Up",
  "phantasmal flames": "Phantasmal Flames", "151": "151", "151 sv2a": "Japanese 151",
  "champion's path": "Champions Path", "prismatic evolutions": "Prismatic Evolutions",
  "paldea evolved": "Paldea Evolved", "base expansion pack": "Base Set", "team rocket": "Team Rocket",
  "xy flashfire": "XY Flashfire", "southern islands": "Southern Islands", "vivid voltage": "Vivid Voltage",
};

const digits = s => (String(s).match(/\d+/) || [""])[0].replace(/^0+/, "") || "0";

// Construit "setName number" pour une carte (ou null si set inconnu).
function cardQuery(card, meta) {
  let setCode = null, num = null;
  const td = card.tcgdex || (meta && meta[card.id] && meta[card.id].tcgdex);
  if (td && td.includes("-")) { const [s, n] = td.split("-"); setCode = s; num = digits(n); }
  if (!num) { const m = (card.number || card.fullName || card.name || "").match(/(\d+)\s*\/\s*\d+/); if (m) num = digits(m[1]); }
  if (!num) { const m = (card.name || "").match(/\b(\d{1,3})\b/); if (m) num = digits(m[1]); }
  if (!num) return null;
  let setName = setCode && PC_SET[setCode];
  if (!setName) setName = PC_SET_TEXT[(card.set || "").toLowerCase().replace(/^[a-z0-9]+ · /i, "").trim()];
  if (!setName && card.set) setName = PC_SET_TEXT[card.set.toLowerCase()];
  if (!setName) return null;
  return `${setName} ${num}`;
}

// ── Réseau ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchText(url, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept-Language": "en,fr" } });
      if (r.status === 200) return { url: r.url, body: await r.text() };
      last = new Error("HTTP " + r.status);
    } catch (e) { last = e; }
    await sleep(1200 * (i + 1));
  }
  throw last;
}
const isProduct = h => /id=["']used_price["']/.test(h);
const firstLink = h => { const m = h.match(/href="(?:https?:\/\/www\.pricecharting\.com)?(\/game\/[^"?#]+)"/); return m ? "https://www.pricecharting.com" + m[1] : null; };

async function resolve(query) {
  const s = await fetchText(`https://www.pricecharting.com/search-products?q=${encodeURIComponent(query)}&type=prices`);
  if (isProduct(s.body)) return s;
  const link = firstLink(s.body);
  if (!link) return null;
  return await fetchText(link);
}

const priceUSD = (h, id) => { const m = h.match(new RegExp(`id=["']${id}["'][\\s\\S]{0,260}?\\$([0-9][0-9,]*\\.?[0-9]*)`)); return m ? parseFloat(m[1].replace(/,/g, "")) : null; };
const eur = usd => (usd == null ? null : Math.round(usd * USD_EUR * 100) / 100);

// Historique : première grande série [[ts_ms, pennies], ...] → points mensuels en €.
function history(html) {
  const m = html.match(/\[\s*\[\s*\d{10,13}\s*,\s*\d+\s*\](?:\s*,\s*\[\s*\d{10,13}\s*,\s*\d+\s*\])+\s*\]/);
  if (!m) return [];
  let arr; try { arr = JSON.parse(m[0]); } catch { return []; }
  const byMonth = {};
  for (const [ts, pennies] of arr) {
    if (!pennies) continue;
    const d = new Date(ts);
    byMonth[`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`] = Math.round(pennies / 100 * USD_EUR * 100) / 100;
  }
  const keys = Object.keys(byMonth).sort().slice(-18);
  return keys.map(k => ({ t: `${k}-01`, raw: byMonth[k] }));
}

async function main() {
  const src = fs.readFileSync(HTML, "utf8");
  const CLASSEUR = evalLiteral(src, "CLASSEUR_CARDS");
  const OWNED = evalLiteral(src, "DEFAULT_OWNED");
  const META = evalLiteral(src, "GRADING_META");
  const WATCH = evalLiteral(src, "DEFAULT_WATCH");
  const all = [
    ...CLASSEUR.map(c => ({ ...c, _id: c.id })),
    ...OWNED.map(c => ({ ...c, _id: c.id })),
    ...WATCH.map(c => ({ ...c, _id: String(c.id) })),
  ];

  const validate = process.argv.includes("--validate");
  const sIdx = process.argv.indexOf("--sample");
  const sample = sIdx !== -1 ? parseInt(process.argv[sIdx + 1], 10) : 0;
  const jobs = all.map(c => ({ id: c._id, name: c.fullName || c.name, q: cardQuery(c, META) })).filter(j => j.q);
  const list = sample ? jobs.slice(0, sample) : jobs;
  console.log(`${jobs.length} cartes résolvables / ${all.length}${validate ? " · MODE VALIDATION" : ""}`);

  const out = {};
  let ok = 0, miss = 0, err = 0;
  for (const j of list) {
    try {
      const r = await resolve(j.q);
      if (!r) { miss++; if (validate) console.log(`  ✗ ${j.id} "${j.q}" — non résolu`); continue; }
      const raw = priceUSD(r.body, "used_price"), g9 = priceUSD(r.body, "complete_price"), p10 = priceUSD(r.body, "new_price");
      if (raw == null) { miss++; if (validate) console.log(`  ✗ ${j.id} "${j.q}" — pas de prix`); continue; }
      const hist = history(r.body);
      const entry = { raw: eur(raw), psa9: eur(g9), psa10: eur(p10), currency: "EUR", source: "pricecharting", url: r.url.split("?")[0], ts: Date.now(), history: hist };
      out[j.id] = entry; ok++;
      if (validate) console.log(`  ✓ ${j.id} "${j.q}" → ${entry.raw}€ (PSA9 ${entry.psa9}€ / PSA10 ${entry.psa10}€) · ${hist.length} pts histo · ${entry.url}`);
    } catch (e) { err++; if (validate) console.log(`  ! ${j.id} "${j.q}" — ${e.message}`); }
    await sleep(250);
  }
  console.log(`Résultat : ${ok} prix, ${miss} sans prix, ${err} erreurs`);
  if (validate) return;
  const payload = { generatedAt: new Date().toISOString(), count: ok, cards: out };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(`✅ prices.json écrit — ${ok} cartes`);
}
main().catch(e => { console.error("FATAL:", e); process.exit(1); });
