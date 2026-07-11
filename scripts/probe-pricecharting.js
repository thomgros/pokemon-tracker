#!/usr/bin/env node
/**
 * probe-pricecharting.js — TEST FINAL (jetable).
 * Résout 6 vraies cartes du classeur via « nom-de-set-EN + numéro », suit vers la
 * page produit, et extrait RAW / Grade 9 / PSA 10 + un échantillon d'historique.
 * But : confirmer qu'on peut brancher de vrais prix pour tout le classeur.
 */

const SAMPLE = [
  { id: "c66",  q: "Chaos Ascendant 22",   name: "Méga-Amphinobi ex 022/086 (FR)" },
  { id: "c60",  q: "Perfect Order 111",    name: "Illumis 111/088 (FR)" },
  { id: "c109", q: "Scarlet Violet 248",   name: "Roue-de-Fer ex 248/198 (FR)" },
  { id: "c41",  q: "Jungle 11",            name: "Snorlax 11/64 (EN)" },
  { id: "c121", q: "Sword Shield 138",     name: "Zacian V 138/202 (EN)" },
  { id: "c76",  q: "Obsidian Flames 210",  name: "Bekaglaçon ex 210/197 (FR)" },
];

async function fetchText(url) {
  const r = await fetch(url, {
    redirect: "follow", signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept-Language": "en,fr" },
  });
  return { status: r.status, url: r.url, body: await r.text() };
}

function priceOf(html, id) {
  const m = html.match(new RegExp(`id=["']${id}["'][\\s\\S]{0,260}?\\$([0-9][0-9,]*\\.?[0-9]*)`));
  return m ? m[1].replace(/,/g, "") : null;
}
function isProduct(html) { return /id=["']used_price["']/.test(html); }
function firstProductLink(html) {
  const m = html.match(/href="(?:https?:\/\/www\.pricecharting\.com)?(\/game\/[^"?#]+)"/);
  return m ? "https://www.pricecharting.com" + m[1] : null;
}
function historySample(html) {
  const m = html.match(/\[\s*\[\s*\d{10,13}\s*,\s*[0-9.]+\s*\][\s\S]{0,80}?\]/);
  return m ? m[0].slice(0, 120) : null;
}

async function resolve(q) {
  const s = await fetchText(`https://www.pricecharting.com/search-products?q=${encodeURIComponent(q)}&type=prices`);
  if (s.status !== 200) return { err: `search HTTP ${s.status}` };
  if (isProduct(s.body)) return { url: s.url, html: s.body, mode: "direct" };
  const link = firstProductLink(s.body);
  if (!link) return { err: "aucun lien produit", url: s.url };
  const p = await fetchText(link);
  if (p.status !== 200) return { err: `produit HTTP ${p.status}`, url: link };
  return { url: p.url, html: p.body, mode: "lien" };
}

async function main() {
  for (const c of SAMPLE) {
    console.log(`\n=== ${c.name}  →  "${c.q}"`);
    try {
      const r = await resolve(c.q);
      if (r.err) { console.log("  ✗", r.err, r.url || ""); continue; }
      const raw = priceOf(r.html, "used_price"), g9 = priceOf(r.html, "complete_price"), p10 = priceOf(r.html, "new_price");
      const title = (r.html.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
      console.log(`  [${r.mode}] ${r.url}`);
      console.log(`  ${title ? title.trim().slice(0, 70) : ""}`);
      console.log(`  RAW $${raw} · Grade9 $${g9} · PSA10 $${p10} · histo: ${historySample(r.html) ? "oui" : "non"}`);
    } catch (e) { console.log("  ERREUR:", e.message); }
    await new Promise(r => setTimeout(r, 300));
  }
}
main();
