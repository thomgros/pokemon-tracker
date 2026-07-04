# Pokémon price-watch agent

Checks the cards in `watchlist.json` against live eBay listings every 4 hours
(via a scheduled Claude Code trigger) and notifies when:

- an active listing is priced at or below the card's `maxPrice`, or
- (once `PRICECHARTING_API_KEY` is set) a raw listing + grading cost is cheap
  enough vs. the PSA 10 reference price to be a grading-arbitrage play.

It never buys or messages sellers — it only surfaces opportunities.

## Setup

```
cp .env.example .env   # fill in keys as you get them
node src/run.js         # one-off check, prints JSON to stdout
```

- **eBay**: already working, reuses the public App ID from `index.html`
  (legacy Finding API, no OAuth secret needed).
- **PriceCharting**: optional. Without a key, only the under-budget check
  runs (no grading arbitrage). See `.env.example`.
- **Cardmarket**: not implemented yet (`src/cardmarket.js` is a stub) -
  pending a seller account with API access.

## State

`state.json` tracks eBay listing IDs already notified about, so the same
listing doesn't trigger a repeat alert. It's committed after every scheduled
run so it survives across container restarts.

## Watchlist

`watchlist.json` is a **separate copy** of the `DEFAULT_WATCH` array in
`index.html` — editing one does not update the other. If you add/remove cards
in the web app's "Surveiller" tab, mirror the change here if you want the
agent to track it too.
