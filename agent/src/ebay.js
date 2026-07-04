const FINDING_URL = "https://svcs.ebay.com/services/search/FindingService/v1";

function buildUrl(operation, appId, params) {
  const url = new URL(FINDING_URL);
  url.searchParams.set("OPERATION-NAME", operation);
  url.searchParams.set("SERVICE-VERSION", "1.0.0");
  url.searchParams.set("SECURITY-APPNAME", appId);
  url.searchParams.set("RESPONSE-DATA-FORMAT", "JSON");
  url.searchParams.set("REST-PAYLOAD", "");
  url.searchParams.set("keywords", params.keywords);
  let filterIdx = 0;
  for (const [name, value] of params.itemFilters || []) {
    url.searchParams.set(`itemFilter(${filterIdx}).name`, name);
    url.searchParams.set(`itemFilter(${filterIdx}).value`, value);
    filterIdx++;
  }
  if (params.sortOrder) url.searchParams.set("sortOrder", params.sortOrder);
  url.searchParams.set("paginationInput.entriesPerPage", params.entriesPerPage ?? 10);
  return url.toString();
}

// Currently live listings, cheapest first — the actionable "buy now" opportunities.
async function findActiveListings(appId, keywords, { entriesPerPage = 10 } = {}) {
  const url = buildUrl("findItemsAdvanced", appId, {
    keywords,
    itemFilters: [
      ["Condition", "3000"],
      ["ListingType", "FixedPrice"],
    ],
    sortOrder: "PricePlusShippingLowest",
    entriesPerPage,
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`eBay findItemsAdvanced HTTP ${res.status}`);
  const data = await res.json();
  const items = data?.findItemsAdvancedResponse?.[0]?.searchResult?.[0]?.item ?? [];
  return items.map(i => ({
    itemId: i.itemId?.[0],
    title: i.title?.[0],
    price: parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__),
    currency: i.sellingStatus?.[0]?.currentPrice?.[0]?.["@currencyId"],
    url: i.viewItemURL?.[0],
  })).filter(i => i.price > 0);
}

// Recently sold comps — used for valuation (avg/min/max), same query as the web app.
async function findCompletedAvg(appId, keywords, { entriesPerPage = 5 } = {}) {
  const url = buildUrl("findCompletedItems", appId, {
    keywords,
    itemFilters: [
      ["SoldItemsOnly", "true"],
      ["Condition", "3000"],
    ],
    sortOrder: "EndTimeSoonest",
    entriesPerPage,
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`eBay findCompletedItems HTTP ${res.status}`);
  const data = await res.json();
  const items = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item ?? [];
  const prices = items
    .map(i => parseFloat(i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__))
    .filter(p => p > 0);
  if (!prices.length) return null;
  return {
    avg: prices.reduce((a, b) => a + b, 0) / prices.length,
    min: Math.min(...prices),
    max: Math.max(...prices),
    count: prices.length,
  };
}

module.exports = { findActiveListings, findCompletedAvg };
