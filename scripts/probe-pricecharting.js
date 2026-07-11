#!/usr/bin/env node
/**
 * probe-pricecharting.js — TEST DE FAISABILITÉ (jetable).
 * Étape 2 : peut-on RÉSOUDRE automatiquement chaque carte → sa page PriceCharting
 * via la recherche du site ? On teste quelques requêtes (dont Méga FR) et on affiche
 * les premières pages produit trouvées.
 */

async function fetchText(url) {
  const r = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "Accept-Language": "fr,en" },
  });
  return { status: r.status, ct: r.headers.get("content-type") || "", body: await r.text() };
}

// Extrait les liens de pages produit /game/... d'une page de résultats
function productLinks(html) {
  const links = [...html.matchAll(/href="(\/game\/[a-z0-9-]+\/[a-z0-9-]+)"/g)].map(m => m[1]);
  return [...new Set(links)].slice(0, 4);
}

const QUERIES = [
  "aerodactyl fossil 1st edition",
  "mega greninja ex chaos ascendant",   // = Méga-Amphinobi ex 022/086 FR
  "mega gardevoir ex perfect order",     // = Méga-Mélodelfe ex (POR)
  "zacian v sword shield 138",
  "raikou vivid voltage 50",
];

async function main() {
  for (const q of QUERIES) {
    const url = `https://www.pricecharting.com/search-products?q=${encodeURIComponent(q)}&type=prices`;
    console.log("\n=== recherche: " + q);
    try {
      const r = await fetchText(url);
      console.log(`  HTTP ${r.status} · ${r.body.length} octets`);
      if (r.status === 200) {
        const links = productLinks(r.body);
        console.log("  produits:", JSON.stringify(links));
        // Si redirigé direct vers une page produit (1 seul résultat), l'URL finale le montrerait
        const title = (r.body.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
        console.log("  title:", title ? title.trim().slice(0, 90) : null);
      }
    } catch (e) { console.log("  ERREUR:", e.message); }
  }
}
main();
