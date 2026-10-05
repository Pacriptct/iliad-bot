// Diagnostic: read the game's outbox queue once and print exactly what Roblox
// returns (status + body). Items are NOT removed (they reappear after 1 second).
//   npm run build && npm run peek
import { config, secrets } from "./config.js";

const url =
  `https://apis.roblox.com/cloud/v2/universes/${config.roblox.universeId}` +
  `/memory-store/queues/${encodeURIComponent(config.roblox.outboxQueue)}/items:read?count=10&allOrNothing=false&invisibilityWindow=1s`;
console.log("GET", url);
const res = await fetch(url, { headers: { "x-api-key": secrets.robloxApiKey } });
const body = await res.text();
console.log("status:", res.status);
console.log(body.length > 3000 ? `${body.slice(0, 3000)}… (${body.length} chars)` : body || "(empty body)");
