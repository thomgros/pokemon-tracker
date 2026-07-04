// EU/FR reference pricing via Cardmarket. Requires a Cardmarket seller account
// and API access (App Token/Secret + OAuth access token/secret) - not active yet.
// Once the account is approved, fill in CARDMARKET_* env vars and implement the
// OAuth 1.0a signed request here (see api.cardmarket.com docs: /ws/v2.0/output.json).

async function findReferencePrice(_credentials, _query) {
  return null; // not wired up yet - pending seller account approval
}

module.exports = { findReferencePrice };
