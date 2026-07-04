// Reference valuation (raw + graded PSA/BGS/CGC) for grading-arbitrage detection.
// Needs PRICECHARTING_API_KEY (paid plan) - returns null until configured.
//
// NOTE: field names below (loose-price, psa-10-price, ...) are PriceCharting's
// documented convention for graded trading cards, but not verified against a
// live response yet. Run `node agent/src/pricecharting.js "<card name>"` once
// the key is set to print the raw JSON and confirm/adjust field names.
const BASE_URL = "https://www.pricecharting.com/api/product";

async function findReferencePrice(apiKey, query) {
  if (!apiKey) return null;
  const url = new URL(BASE_URL);
  url.searchParams.set("t", apiKey);
  url.searchParams.set("q", query);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`PriceCharting HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "success") return null;
  // Cent values from the API.
  return {
    raw: data["loose-price"] ? data["loose-price"] / 100 : null,
    psa9: data["psa-9-price"] ? data["psa-9-price"] / 100 : null,
    psa10: data["psa-10-price"] ? data["psa-10-price"] / 100 : null,
    bgs10: data["bgs-10-price"] ? data["bgs-10-price"] / 100 : null,
    _raw: data,
  };
}

if (require.main === module) {
  const apiKey = process.env.PRICECHARTING_API_KEY;
  const query = process.argv[2];
  if (!apiKey || !query) {
    console.error('Usage: PRICECHARTING_API_KEY=xxx node agent/src/pricecharting.js "card name"');
    process.exit(1);
  }
  findReferencePrice(apiKey, query).then(r => console.log(JSON.stringify(r, null, 2)));
}

module.exports = { findReferencePrice };
