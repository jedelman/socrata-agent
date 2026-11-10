// city_news: the City of Norfolk's own announcements, read from its News Flash
// and Alert Center RSS feeds. Police and prosecutor news is left out, in code:
//
//   1. An allowlist. Only the feeds in NEWS_FEEDS are ever read for their
//      items. Police-34, Commonwealths-Attorney-65 and every "All-" feed are
//      not on it, and checkAllowlist() throws at load if a forbidden category
//      is ever added (test/city-news.test.js checks the same rule). The
//      server picks a category by the number at the end of CID alone
//      ("Community-34" serves Police, "Events-65" the Commonwealth's
//      Attorney), and a CID that doesn't end in a number serves every
//      category, police included (checked 2026-11-10). So the rule is on the
//      number, and every feed read must also carry the City's own title for
//      that category (checkChannel), or it isn't read.
//   2. Cross-posts. The Police and Commonwealth's Attorney feeds are read for
//      their item links only (feedLinks never looks at a title or a
//      description, and nothing from them is returned), and an allowed item
//      with the same link is dropped. If either can't be read, the allowed
//      items still come back, with a note that the check didn't run in full.
//   3. Wording. An item whose title or summary reads like crime or court news
//      (CRIME_WORDS) is dropped. It is deliberately broad: a City item lost
//      to it is the cost of never passing on an arrest or a prosecution.
//
// Siren doesn't find people (CLAUDE.md). The Police feed names people
// arrested and charged, and the Commonwealth's Attorney feed names defendants
// in its titles ("Commonwealth v. <name>"): the same kind of record as the
// Arrest Reports and Active Warrants datasets the Norfolk profile excludes.
// News Flash serves all categories from one path, told apart only by the
// category in the query string, which is why web search is kept off it
// (deployments/siren.config.js) and why this tool reads by category instead.
//
// Feeds: https://www.norfolk.gov/rss.aspx lists them, each at
// https://www.norfolk.gov/RSSFeed.aspx?ModID=<module>&CID=<category>
// (module 1 is News Flash, 63 the Alert Center). Each is RSS 2.0, and an item
// carries only title, link, pubDate, description and guid: no category tag, so
// the feed it came from is its category. Each feed holds only its latest items
// (the home page feed held 15 on 2026-11-10, back to Oct 14).
//
// The City's server resets connections now and then, and the same URL works on
// a second try (seen 2026-11-10), so each feed gets one retry, its own traced
// and counted step.

import { definePlugin } from '../src/plugins.js';

const SITE = 'https://www.norfolk.gov';
const HOST = 'www.norfolk.gov';
const MODULES = Object.freeze({ 1: 'News Flash', 63: 'Alert Center' });

// Every feed below was read live on 2026-11-10 (item counts that day in the
// comments). Categories left off, and why:
//   - Police-34: arrests and charges, naming the people arrested.
//   - Commonwealths-Attorney-65: prosecutions, defendants named in the titles.
//   - All-newsflash.xml (News Flash) and All-0 (Alert Center): every category,
//     police included.
//   - 2024-Footer-77: empty, and by its name a slot in the site's footer
//     design, not news.
//   - Alert Center FireRescue-25: empty on 2026-11-10, and archived alerts
//     can't be opened (AlertCenter.aspx?AID=... answers 404), so no item could
//     be read. A Fire-Rescue alert can describe one household's emergency (the
//     Norfolk profile suppresses fire red tags for that reason), and the
//     wording guard would miss "fire displaces family on <street>". Add it once
//     its items have been read and name no one.
// `channel` is the City's name for the category, as the feed's own title
// gives it ("Norfolk, VA - News Flash - <channel>"); `label` is what the
// result shows. Topics pick a feed when the query's words suggest it;
// `always` feeds are read on every call, and `fallback` feeds fill the rest of
// a call with no topical match.
export const NEWS_FEEDS = Object.freeze(
  [
    { module: 1, cid: 'News-Home-page-1', channel: 'News, Home page', label: 'News, Home page', always: true }, // 15: road work, Winterfest, grants, closures, council agendas
    { module: 1, cid: 'Home-Spotlight-59', channel: 'Home Spotlight', label: 'Home Spotlight', always: true }, // 9: holidays, MyNorfolk, newsletters, auctions
    { module: 63, cid: 'Emergency-Alerts-5', channel: 'Emergency Alerts', label: 'Emergency Alerts', always: true }, // 0: the emergency channel
    { module: 1, cid: 'Treasurer-Due-Dates-89', channel: 'Treasurer Due Dates', label: 'Treasurer Due Dates', fallback: true, topics: /\b(tax|treasurer|due|deadline|bill|pay|personal property|real estate)/ }, // 1
    { module: 1, cid: 'Norfolk-Public-Library-News-83', channel: 'Norfolk Public Library - News', label: 'Norfolk Public Library - News', fallback: true, topics: /\b(librar|book|branch|read|story ?time|npl\b)/ }, // 1
    { module: 63, cid: 'Parks-and-Recreation-21', channel: 'Parks and Recreation', label: 'Parks and Recreation (alerts)', fallback: true, topics: /\b(park|recreation|rec\b|pool|playground|athletic|sport|field|trail|beach)/ }, // 0
    { module: 1, cid: 'Norfolk-Public-Library-Spotlight-82', channel: 'Norfolk Public Library - Spotlight', label: 'Norfolk Public Library - Spotlight', topics: /\b(librar|book|branch|read|story ?time|npl\b)/ }, // 0
    { module: 1, cid: 'Parks-Recreation-Spotlight-66', channel: 'Parks & Recreation - Spotlight', label: 'Parks & Recreation - Spotlight', topics: /\b(park|recreation|rec\b|pool|playground|athletic|sport|field|trail|beach)/ }, // 0
    { module: 1, cid: 'City-Auditor-69', channel: 'City Auditor', label: 'City Auditor', topics: /\baudit/ }, // 1
    { module: 1, cid: 'KNB-79', channel: 'KNB', label: 'Keep Norfolk Beautiful', topics: /\b(litter|clean ?up|beautif|knb\b|recycl|trash|keep norfolk)/ }, // 0
    { module: 1, cid: 'St-Pauls-News-88', channel: "St. Paul's News", label: "St. Paul's News", topics: /\b(st\.? ?pauls?|saint pauls?|tidewater gardens|calvert square|young terrace|transformation|redevelop)/ }, // 0
    { module: 1, cid: 'Sail-250-Events-90', channel: 'Sail 250 Events', label: 'Sail 250 Events', topics: /\b(sail|tall ship|250|harborfest|maritime|navy|fleet)/ }, // 0
  ].map((f) => Object.freeze(f))
);

// Never read for items, whatever the list says. The server goes by the
// number (News Flash 34 is Police, 65 the Commonwealth's Attorney; 0, or no
// number at all, is every category), so the numbers are the rule. The names
// and the pattern are kept too, broad on purpose ("Small-Business-..." would
// trip "all-" and need a deliberate change here).
export const FORBIDDEN_CATEGORIES = Object.freeze({ 1: Object.freeze([34, 65]), 63: Object.freeze([]) });
export const FORBIDDEN_CIDS = Object.freeze(['Police-34', 'Commonwealths-Attorney-65', 'All-newsflash.xml', 'All-0']);
export const FORBIDDEN_CID_PATTERN = /police|commonwealth|attorney|all-/i;

// The feeds read only for their links, for the cross-post check.
export const CROSS_POST_FEEDS = Object.freeze([
  Object.freeze({ module: 1, cid: 'Police-34', channel: 'Police', label: 'Police' }),
  Object.freeze({ module: 1, cid: 'Commonwealths-Attorney-65', channel: "Commonwealth's Attorney", label: "Commonwealth's Attorney" }),
]);

/** The category number the server reads from a CID ("News-Home-page-1" is 1), or null if it doesn't end in one. */
export function categoryNumber(cid) {
  const m = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*-(\d{1,6})$/.exec(String(cid));
  return m ? Number(m[1]) : null;
}

export function checkAllowlist(feeds) {
  for (const f of feeds) {
    if (!MODULES[f.module]) throw new Error(`city_news: module ${f.module} is not News Flash (1) or the Alert Center (63).`);
    if (FORBIDDEN_CIDS.includes(f.cid) || FORBIDDEN_CID_PATTERN.test(f.cid)) throw new Error(`city_news: ${f.cid} may never be read for its items.`);
    const n = categoryNumber(f.cid);
    if (!n) throw new Error(`city_news: ${f.cid} doesn't end in a category number, and the server serves every category for that.`);
    if (FORBIDDEN_CATEGORIES[f.module].includes(n)) throw new Error(`city_news: ${f.cid} may never be read for its items: ${MODULES[f.module]} category ${n} is forbidden.`);
    if (!f.channel || !f.label) throw new Error(`city_news: ${f.cid} needs the City's channel name and a label.`);
  }
  return feeds;
}
checkAllowlist(NEWS_FEEDS);

export const feedUrl = (f) => `${SITE}/RSSFeed.aspx?ModID=${f.module}&CID=${f.cid}`;
// The City's page for one category: News Flash shows only that category there.
const pageUrl = (f) => `${SITE}/${f.module === 1 ? 'CivicAlerts' : 'AlertCenter'}.aspx?CID=${categoryNumber(f.cid)}`;

// Crime and court wording. Checked against the title and the summary.
export const CRIME_WORDS =
  /\b(arrest\w*|charged|charges? (?:filed|against)|suspect\w*|homicides?|murder\w*|manslaughter|shootings?|stabb\w*|commonwealth\s+vs?\b\.?|wanted|missing|sentenc\w*|indict\w*|convict\w*|guilty|robber(?:y|ies)|burglar\w*|dies|died|killed|fatal\w*)\b/i;

export const MAX_FEEDS = 6;
const MAX_LIMIT = 20;
const SUMMARY_CHARS = 300;

// --- parsing: a small RSS 2.0 reader, no dependency -------------------------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// An element's text: CDATA sections taken as they are, the rest entity-decoded.
function xmlText(raw) {
  let out = '';
  let last = 0;
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  for (const m of raw.matchAll(re)) {
    out += decodeEntities(raw.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  return out + decodeEntities(raw.slice(last));
}

// HTML to plain text: scripts, styles, comments and tags out, entities
// decoded (descriptions arrive with their markup escaped), spaces collapsed.
export function plainText(html) {
  const strip = (s) =>
    s
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ');
  return strip(decodeEntities(strip(String(html)))).replace(/\s+/g, ' ').trim();
}

function element(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*[^/>])?>([\\s\\S]*?)</${tag}\\s*>`, 'i'));
  return m ? xmlText(m[1]) : '';
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ZONES = { GMT: '+00:00', UT: '+00:00', UTC: '+00:00', Z: '+00:00', EST: '-05:00', EDT: '-04:00', CST: '-06:00', CDT: '-05:00', MST: '-07:00', MDT: '-06:00', PST: '-08:00', PDT: '-07:00' };
const pad = (n) => String(n).padStart(2, '0');

/** An RSS pubDate as ISO 8601, keeping the feed's own offset ("2026-11-10T13:52:03-05:00"); null if unreadable. */
export function isoDate(s) {
  const m = String(s || '').match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,4})?/);
  if (m) {
    const month = MONTHS[m[2].toLowerCase()];
    const zone = m[7] ? m[7].toUpperCase() : 'GMT';
    const offset = /^[+-]\d{4}$/.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : ZONES[zone];
    const day = Number(m[1]);
    if (month && offset && day >= 1 && day <= 31) {
      const iso = `${m[3]}-${pad(month)}-${pad(day)}T${pad(m[4])}:${m[5]}:${m[6] || '00'}${offset}`;
      if (Number.isFinite(Date.parse(iso))) return iso;
    }
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Parse an RSS 2.0 body into items: { title, link, guid, date, summary }. Throws if it isn't RSS. */
export function parseRss(xml) {
  const body = String(xml || '');
  if (!/<rss\b/i.test(body) || !/<channel\b/i.test(body)) throw new Error('not an RSS feed');
  const items = [];
  for (const m of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    const block = m[1];
    const summary = plainText(element(block, 'description'));
    items.push({
      title: plainText(element(block, 'title')),
      link: element(block, 'link').trim(),
      guid: element(block, 'guid').trim(),
      date: isoDate(element(block, 'pubDate').trim()),
      summary: summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : summary,
    });
  }
  return items;
}

/** The feed's own title, from the channel (before its first item). */
export function channelTitle(xml) {
  const head = String(xml || '').split(/<item\b/i)[0];
  const m = head.match(/<channel\b[^>]*>[\s\S]*?<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i);
  return m ? plainText(xmlText(m[1])) : '';
}

/**
 * Throws unless the feed is the category asked for: its title must be
 * "Norfolk, VA - <module> - <channel>". A renumbered category, or a CID the
 * server didn't know (it then serves every category), is never read.
 */
export function checkChannel(xml, feed) {
  if (!/<rss\b/i.test(String(xml || '')) || !/<channel\b/i.test(String(xml || ''))) throw new Error('not an RSS feed');
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const want = norm(`Norfolk, VA - ${MODULES[feed.module]} - ${feed.channel}`);
  const got = norm(channelTitle(xml));
  if (got !== want) throw new Error(`the feed's title is "${got.slice(0, 120)}", not "${want}", so it was not read`);
  return xml;
}

/** Only the link and guid of each item, for the cross-post check: titles and descriptions are never read. */
export function feedLinks(xml) {
  const body = String(xml || '');
  if (!/<rss\b/i.test(body) || !/<channel\b/i.test(body)) throw new Error('not an RSS feed');
  const keys = new Set();
  for (const m of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
    for (const tag of ['link', 'guid']) {
      const k = linkKey(element(m[1], tag).trim());
      if (k) keys.add(k);
    }
  }
  return keys;
}

// --- links -------------------------------------------------------------------

/**
 * One key per announcement, whatever form its link takes: News Flash items
 * are CivicAlerts.aspx?aid=<n> (the guid adds "/<ticks>"), or
 * /m/newsflash/home/detail/<n> on the mobile path. Other links key on host,
 * path and query.
 */
export function linkKey(href) {
  let u;
  try {
    u = new URL(String(href || '').trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  const path = u.pathname.toLowerCase().replace(/\/+$/, '');
  const params = [...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]);
  const aid = params.find(([k]) => k === 'aid')?.[1]?.match(/^\d+/)?.[0] || path.match(/\/newsflash\/[^/]+\/detail\/(\d+)/)?.[1];
  if (aid && (path.endsWith('/civicalerts.aspx') || path.includes('/newsflash'))) return `${host}#newsflash:${aid}`;
  const query = params
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v.toLowerCase()}`)
    .join('&');
  return `${host}${path}${query ? `?${query}` : ''}`;
}

/** The link as https on www.norfolk.gov, or null for anything off the City's site. */
export function cityLink(href) {
  let u;
  try {
    u = new URL(String(href || '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
  if (u.hostname.toLowerCase().replace(/\.$/, '') !== HOST) return null;
  return `${SITE}${u.pathname}${u.search}`;
}

// --- choosing feeds and matching the query ------------------------------------

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with', 'from', 'about', 'is', 'are', 'was', 'what', 'when', 'where', 'who', 'how', 'any', 'new', 'news', 'city', 'norfolk', 'latest', 'recent', 'announcement', 'announcements']);

export function queryWords(query) {
  const words = String(query || '').slice(0, 200).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’.&-]*/gu) || [];
  return [...new Set(words.map((w) => w.replace(/[.'’-]+$/, '')).filter((w) => w.length >= 2 && !STOP.has(w)))].slice(0, 8);
}

/** The feeds a call reads: the `always` ones, then those the query points at, then fallbacks, up to MAX_FEEDS. */
export function chooseFeeds(words, feeds = NEWS_FEEDS, max = MAX_FEEDS) {
  const text = words.join(' ');
  const chosen = feeds.filter((f) => f.always);
  const topical = text ? feeds.filter((f) => !f.always && f.topics?.test(text)) : [];
  for (const f of topical) if (chosen.length < max) chosen.push(f);
  if (!topical.length) for (const f of feeds) if (f.fallback && chosen.length < max) chosen.push(f);
  return { chosen, by: topical.length ? 'the query' : 'default' };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** How many of the words start a word in the item's title or summary. */
function matches(item, words) {
  const text = `${item.title} ${item.summary}`.toLowerCase();
  return words.filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(w)}`, 'u').test(text)).length;
}

// --- reading -------------------------------------------------------------------

const isRefused = (err) => err?.refused === true;
const isClientError = (err) => /^HTTP 4\d\d\b/.test(String(err?.message || ''));

// One feed, with one retry on any failure but a 4xx or a refusal by the
// answer's request budget. Each try is its own traced, counted step.
async function readFeed(ctx, feed, tool, parse) {
  const url = feedUrl(feed);
  const once = () => ctx.http.text(url, { tool, retry: false });
  let body;
  let tries = 1;
  try {
    body = await once();
  } catch (err) {
    if (isRefused(err) || isClientError(err)) return { error: String(err?.message || err), tries };
    tries = 2;
    try {
      body = await once();
    } catch (err2) {
      return { error: String(err2?.message || err2), tries };
    }
  }
  try {
    return { value: parse(body), tries };
  } catch (err) {
    return { error: String(err?.message || err), tries };
  }
}

// An error without the body a server sent with it ("HTTP 503: <page>" becomes
// "HTTP 503"): nothing from the Police or prosecutor feeds reaches the result.
const brief = (msg) => (/^HTTP \d{3}\b/.test(msg) ? msg.slice(0, 8) : String(msg).slice(0, 200));

const clamp = (v, lo, hi, dflt) => {
  if (v == null || v === '') return dflt;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
};

/** The tool's work; `now` is for tests. */
export async function cityNews(ctx, args, { now = Date.now() } = {}) {
  args = args || {};
  const days = clamp(args.days, 1, 365, 30);
  const limit = clamp(args.limit, 1, MAX_LIMIT, 10);
  const words = queryWords(args.query);
  const { chosen, by } = chooseFeeds(words);

  // All at once, the cross-post feeds started first: on a nearly spent
  // request budget the check gets the requests, not one more category.
  const [guards, read] = await Promise.all([
    Promise.all(
      CROSS_POST_FEEDS.map((f) =>
        readFeed(ctx, f, `City news: ${f.label} feed, links only (cross-post check)`, (xml) => feedLinks(checkChannel(xml, f))).then((r) => ({ feed: f, ...r }))
      )
    ),
    Promise.all(
      chosen.map((f) => readFeed(ctx, f, `City news feed: ${f.label} (${MODULES[f.module]})`, (xml) => parseRss(checkChannel(xml, f))).then((r) => ({ feed: f, ...r })))
    ),
  ]);

  const blocked = new Set();
  for (const g of guards) for (const k of g.value || []) blocked.add(k);
  const guardFailed = guards.filter((g) => g.error);

  const excluded = { cross_posted: 0, crime_or_court_wording: 0, off_site_link: 0, undated: 0 };
  const seen = new Set();
  const kept = [];
  const feedsRead = [];
  const feedsFailed = [];
  for (const r of read) {
    if (r.error) {
      feedsFailed.push({ category: r.feed.label, error: brief(r.error), tries: r.tries });
      continue;
    }
    const dates = r.value.map((i) => i.date).filter(Boolean).sort();
    feedsRead.push({ category: r.feed.label, items_in_feed: r.value.length, oldest: dates[0] || null, ...(r.tries > 1 ? { tries: r.tries } : {}) });
    ctx.resources.addLink({ title: `City of Norfolk ${MODULES[r.feed.module]}: ${r.feed.label}`, url: pageUrl(r.feed) });
    for (const item of r.value) {
      const link = cityLink(item.link);
      if (!link) {
        excluded.off_site_link++;
        continue;
      }
      const keys = [linkKey(link), linkKey(item.guid)].filter(Boolean);
      if (keys.some((k) => blocked.has(k))) {
        excluded.cross_posted++;
        continue;
      }
      if (CRIME_WORDS.test(item.title) || CRIME_WORDS.test(item.summary)) {
        excluded.crime_or_court_wording++;
        continue;
      }
      if (!item.date) {
        excluded.undated++;
        continue;
      }
      if (keys.some((k) => seen.has(k))) continue; // the same announcement in two feeds: keep the first
      keys.forEach((k) => seen.add(k));
      kept.push({ category: r.feed.label, title: item.title, date: item.date, link, summary: item.summary || null, ts: Date.parse(item.date) });
    }
  }

  const since = now - days * 864e5;
  const recent = kept.filter((i) => i.ts >= since);
  let match = null;
  let hits = recent;
  if (words.length) {
    const scored = recent.map((i) => ({ i, n: matches(i, words) }));
    hits = scored.filter((s) => s.n === words.length).map((s) => s.i);
    match = 'every word';
    if (!hits.length && words.length > 1) {
      hits = scored.filter((s) => s.n > 0).map((s) => s.i);
      match = 'any word (no item had every word)';
    }
  }
  hits.sort((a, b) => b.ts - a.ts);
  const items = hits.slice(0, limit).map(({ ts, ...i }) => i);

  // The announcements returned go in the hand-off with the category pages.
  ctx.resources.addLink({ title: 'City of Norfolk RSS feeds (News Flash, Alert Center)', url: `${SITE}/rss.aspx` });
  for (const i of items) {
    try {
      ctx.resources.addRecord({ kind: 'news', title: `City of Norfolk news: ${i.title}`.slice(0, 160), url: i.link });
    } catch {
      // A City page on a path the hand-off refuses (a Socrata-looking path): the item stays, its link in the result.
    }
  }

  const readLabels = new Set(chosen.map((f) => f.label));
  return {
    ...(words.length ? { query_words: words, matched_on: match } : {}),
    days,
    items,
    items_matching: hits.length,
    feeds_read: feedsRead,
    ...(feedsFailed.length ? { feeds_failed: feedsFailed } : {}),
    feeds_chosen_by: by,
    other_feeds: NEWS_FEEDS.filter((f) => !readLabels.has(f.label)).map((f) => f.label),
    excluded,
    cross_post_check: guardFailed.length
      ? `incomplete: I could not read the ${guardFailed.map((g) => g.feed.label).join(' and ')} feed's links (${guardFailed.map((g) => brief(g.error)).join('; ')}), so an item cross-posted from it would be caught only by the wording check.`
      : "ran: any item sharing a link with the Police or Commonwealth's Attorney feeds was dropped (excluded.cross_posted counts them).",
    source_note:
      "These are the City of Norfolk's own announcements, from its News Flash and Alert Center RSS feeds (www.norfolk.gov/rss.aspx). Police and Commonwealth's Attorney news is excluded by design: those feeds are read only for their links, items cross-posted from them are dropped, and so are items whose title or summary reads like crime or court news. Each feed holds only its latest items, so an older announcement may be missing; feeds_read gives how far back each one reaches. An announcement is what the City said, not a record of what happened. Don't repeat a private person's name from an item.",
  };
}

export default definePlugin({
  name: 'city_news',
  cities: ['norfolk'],
  description:
    "The City of Norfolk's own announcements, from its News Flash and Alert Center RSS feeds: closures, events, programs, road work, grants, tax due dates, library and parks notices, emergency alerts, and City Council agendas posted as news. Police and Commonwealth's Attorney (prosecutor) news is excluded by design. Each feed holds only its latest items, so this covers recent weeks, not an archive. Returns items newest first with category, title, date, link and summary.",
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional words to look for in titles and summaries, e.g. "road resurfacing" or "library closed". Words also pick which category feeds are read (library, parks, taxes, audit, litter, St. Paul\'s, Sail 250).' },
      days: { type: 'integer', description: 'How many days back, 1 to 365; default 30.' },
      limit: { type: 'integer', description: 'How many items, default 10, max 20.' },
    },
    additionalProperties: false,
  },
  run: (ctx, args) => cityNews(ctx, args),
});
