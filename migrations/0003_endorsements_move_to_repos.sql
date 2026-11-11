-- Endorsements moved into the endorsers' own atproto repositories
-- (docs/bluesky-endorsements.md); Siren's database holds none of them.
-- This drops the tables 0001 and 0002 made. Applied 2026-11-11, after rollout step 5
-- checks that they're empty first (the flag was never on in production),
--   npx wrangler d1 execute SIREN_DB --env siren --remote --command \
--     "SELECT (SELECT count(*) FROM endorsements), (SELECT count(*) FROM bsky_rate_counts), (SELECT count(*) FROM siren_d1_budget)"
-- records the result in the doc, then applies it with
--   npx wrangler d1 migrations apply SIREN_DB --env siren --remote
-- D1 Time Travel keeps 30 days of history on Workers Paid, so the dropped
-- rows stay restorable that long. SIREN_DB stays bound for the planned
-- public board (D9, default, pending Jason).
DROP TRIGGER IF EXISTS endorsements_count_insert;
DROP TRIGGER IF EXISTS endorsements_count_delete;
DROP TRIGGER IF EXISTS endorsements_count_update;
DROP TABLE IF EXISTS endorsements;
DROP TABLE IF EXISTS endorsement_counts;
DROP TABLE IF EXISTS bsky_rate_counts;
DROP TABLE IF EXISTS bsky_flows_used;
DROP TABLE IF EXISTS siren_d1_budget;
