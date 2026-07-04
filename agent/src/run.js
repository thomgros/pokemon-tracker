#!/usr/bin/env node
const path = require("path");
const fs = require("fs");
const { findActiveListings, findCompletedAvg } = require("./ebay");
const { findReferencePrice: pcReference } = require("./pricecharting");
const state = require("./state");

const EBAY_APP_ID = process.env.EBAY_APP_ID || "thomasgr-pokemont-PRD-66c21b7a2-5816b693";
const PRICECHARTING_API_KEY = process.env.PRICECHARTING_API_KEY || "";
const GRADING_COST = 25; // rough PSA grading + shipping cost in USD, for arbitrage margin

const WATCHLIST_PATH = path.join(__dirname, "..", "watchlist.json");

async function checkItem(item, st) {
  const opportunities = [];
  const active = await findActiveListings(EBAY_APP_ID, item.ebayQuery, { entriesPerPage: 5 });
  const underBudget = active.filter(l => l.price <= item.maxPrice && !state.wasSeen(st, item.id, l.itemId));

  for (const listing of underBudget) {
    opportunities.push({
      watchId: item.id,
      name: item.name,
      kind: "under_budget",
      maxPrice: item.maxPrice,
      listing,
    });
    state.markSeen(st, item.id, listing.itemId);
  }

  if (PRICECHARTING_API_KEY && active.length) {
    const ref = await pcReference(PRICECHARTING_API_KEY, `${item.name} ${item.set} ${item.number}`);
    if (ref?.psa10) {
      const cheapest = active.reduce((a, b) => (a.price < b.price ? a : b));
      const breakeven = ref.psa10 * 0.85 - GRADING_COST; // 15% margin for fees/risk
      if (cheapest.price <= breakeven && !state.wasSeen(st, `${item.id}-grading`, cheapest.itemId)) {
        opportunities.push({
          watchId: item.id,
          name: item.name,
          kind: "grading_arbitrage",
          psa10Ref: ref.psa10,
          gradingCost: GRADING_COST,
          listing: cheapest,
        });
        state.markSeen(st, `${item.id}-grading`, cheapest.itemId);
      }
    }
  }

  return opportunities;
}

async function main() {
  const watchlist = JSON.parse(fs.readFileSync(WATCHLIST_PATH, "utf8"));
  const st = state.load();
  const allOpportunities = [];

  for (const item of watchlist) {
    try {
      const opps = await checkItem(item, st);
      allOpportunities.push(...opps);
    } catch (e) {
      console.error(`[${item.name}] error: ${e.message}`);
    }
  }

  state.save(st);

  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), count: allOpportunities.length, opportunities: allOpportunities }, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
