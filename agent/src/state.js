const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "state.json");
const MAX_SEEN_PER_ITEM = 50;

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { seen: {} };
  }
}

function save(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function markSeen(state, watchId, ebayItemId) {
  const list = state.seen[watchId] ?? [];
  if (!list.includes(ebayItemId)) {
    list.push(ebayItemId);
    while (list.length > MAX_SEEN_PER_ITEM) list.shift();
  }
  state.seen[watchId] = list;
}

function wasSeen(state, watchId, ebayItemId) {
  return (state.seen[watchId] ?? []).includes(ebayItemId);
}

module.exports = { load, save, markSeen, wasSeen, STATE_PATH };
