// Replays a live trees_on_my_block run (trees-111-pennsylvania.json) by the
// kind of request, not its exact URL, so the fixture keeps working when a
// query's wording changes. Recorded against data.norfolk.gov; see the JSON's
// `recorded` and `address`.

/** The kind of request a Socrata URL is, or null. */
export function treesKey(url) {
  const u = decodeURIComponent(String(url));
  const view = u.match(/\/api\/views\/([a-z0-9]{4}-[a-z0-9]{4})\.json/);
  if (view) return `view:${view[1]}`;
  if (u.includes('/resource/ere7-kake')) return 'address';
  if (u.includes('/resource/qzfe-wj25')) {
    if (u.includes('min(created_datetime)')) return 'wo:span';
    if (u.includes('GROUP BY t, p')) return 'wo:street-by-task';
    if (u.includes('ORDER BY created_datetime DESC')) return 'wo:street-latest';
    if (u.includes('GROUP BY civic_league')) return 'wo:leagues';
    if (u.includes('civic_league =') && u.includes('GROUP BY t')) return 'wo:league-tasks';
    if (u.includes('GROUP BY t')) return 'wo:city-tasks';
  }
  if (u.includes('/resource/cmvv-agyb')) {
    if (u.includes('GROUP BY common_name')) return 'inv:species';
    if (u.includes('trunk_diameter_range')) return 'inv:sizes';
    if (u.includes('GROUP BY civic_league')) return 'inv:leagues';
    if (u.includes('count(*)')) return 'inv:count';
  }
  return null;
}
