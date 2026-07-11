#!/usr/bin/env node
/**
 * probe-pricecharting.js — TEST DE FAISABILITÉ (jetable).
 * Récupère quelques pages PriceCharting côté serveur (runner GitHub) et affiche ce
 * qu'on peut en extraire : statut HTTP, prix (Ungraded / Grade 9 / PSA 10) et présence
 * d'un historique. Sert à décider si on peut brancher de vrais prix automatiquement.
 */

const URLS = [
  "https://www.pricecharting.com/game/pokemon-fossil/aerodactyl-1st-edition-1",
  "https://www.pricecharting.com/game/pokemon-jungle/snorlax-11",
];

async function fetchText(url) {
  const r = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept-Language": "fr,en" },
  });
  return { status: r.status, ct: r.headers.get("content-type") || "", body: await r.text() };
}

function extract(html) {
  const out = {};
  // Prix par cellule : PriceCharting expose #used_price / #complete_price / #new_price
  for (const id of ["used_price", "complete_price", "new_price"]) {
    const m = html.match(new RegExp(`id=["']${id}["'][\\s\\S]{0,220}?\\$([0-9][0-9.,]*)`));
    out[id] = m ? m[1] : null;
  }
  // Libellés de colonnes (pour savoir ce que used/complete/new veulent dire ici)
  const labels = [...html.matchAll(/<th[^>]*>\s*([A-Za-z0-9 ]{3,20})\s*<\/th>/g)].map(m => m[1].trim()).slice(0, 8);
  out.labels = labels;
  // Historique : PriceCharting embarque souvent les séries dans un <script> (VGPC / chart)
  out.hasChartVar = /VGPC|chart_data|price_data|"prices"|graph/i.test(html);
  const jsonBlob = html.match(/(\[\s*\[\s*\d{10,13}\s*,\s*[0-9.]+\s*\][\s\S]{0,60}?\])/);
  out.historySample = jsonBlob ? jsonBlob[1].slice(0, 160) : null;
  const title = html.match(/<title>([\s\S]*?)<\/title>/);
  out.title = title ? title[1].trim().slice(0, 80) : null;
  return out;
}

async function main() {
  for (const url of URLS) {
    console.log("\n=== " + url);
    try {
      const r = await fetchText(url);
      console.log(`HTTP ${r.status} · ${r.ct} · ${r.body.length} octets`);
      if (r.status !== 200) { console.log("  (non-200 — bloqué ?)"); continue; }
      const e = extract(r.body);
      console.log("  title:", e.title);
      console.log("  colonnes:", JSON.stringify(e.labels));
      console.log("  used_price:", e.used_price, "| complete_price:", e.complete_price, "| new_price:", e.new_price);
      console.log("  historique présent:", e.hasChartVar, "| échantillon:", e.historySample);
    } catch (err) {
      console.log("  ERREUR:", err.message);
    }
  }
}
main();
