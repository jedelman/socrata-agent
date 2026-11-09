-- Siren's daily D1 budget, and no more sign-in markers
-- (docs/bluesky-endorsements.md, "Siren's worst case on the account's D1").
-- Applied with
--   npx wrangler d1 migrations apply SIREN_DB --env siren --remote

-- The callback no longer writes a single-use marker: nothing before a
-- finished sign-in touches D1 (worker/bluesky.js finishBlueskyLogin says why
-- PKCE, DPoP and the 10-minute flow cookie are enough).
DROP TABLE IF EXISTS bsky_flows_used;

-- One row per UTC day and pot: 'visitor' (me, endorse, unendorse, forget),
-- 'upkeep' (the cron's purge, the orphan sweep, the steward's clears) and
-- 'list' (the public list's counts). endorsements.js chargeD1 adds to a row
-- in one conditional UPSERT before any of that pot's work reaches D1, and
-- refuses once a day's cap would be passed, so Siren's D1 writes per day
-- can't exceed the caps however many locations serve it. calls counts the
-- pot's D1 calls, writes the rows each will write at most (upper bounds, the
-- budget row included).
-- Holds no hash, request id or visitor: a date, a pot and two numbers.
CREATE TABLE siren_d1_budget (
  day TEXT NOT NULL,
  pot TEXT NOT NULL,
  calls INTEGER NOT NULL,
  writes INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  PRIMARY KEY (day, pot)
) WITHOUT ROWID;
