// city_news: the City's own announcements, with police and prosecutor news
// left out in code. Fixtures in test/fixtures/norfolk-news/ are the feeds as
// recorded on 2026-11-10; the Police and Commonwealth's Attorney ones are
// sanitized (links and dates as recorded, titles replaced, names invented).
// Static imports only: Node 24 runs test files with shared module state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPlugin, checkPluginFile } from './conformance.js';
import { createContext } from '../src/agent.js';
import { definePlugin, pluginContext, tracedHttp } from '../src/plugins.js';
import { requestBudget } from '../src/request-budget.js';
import { Trace } from '../src/trace.js';
import { getCity } from '../src/cities/index.js';
import { systemPrompt } from '../src/prompt.js';
import { applyConfig } from '../src/plugins.js';
import siren from '../deployments/siren.config.js';
import cityNewsPlugin, {
  NEWS_FEEDS,
  CROSS_POST_FEEDS,
  FORBIDDEN_CATEGORIES,
  FORBIDDEN_CIDS,
  FORBIDDEN_CID_PATTERN,
  CRIME_WORDS,
  MAX_FEEDS,
  categoryNumber,
  channelTitle,
  checkAllowlist,
  checkChannel,
  chooseFeeds,
  cityLink,
  cityNews,
  feedLinks,
  feedUrl,
  isoDate,
  linkKey,
  parseRss,
  plainText,
  queryWords,
} from '../plugins/city-news.js';

const norfolk = getCity('norfolk');
const plugin = definePlugin(cityNewsPlugin);
const NOW = Date.parse('2026-11-10T21:00:00Z'); // when the fixtures were recorded
const fixture = (cid) => readFileSync(new URL(`./fixtures/norfolk-news/${cid}.xml`, import.meta.url), 'utf8');
const RECORDED = ['News-Home-page-1', 'Home-Spotlight-59', 'Treasurer-Due-Dates-89', 'Norfolk-Public-Library-News-83', 'Emergency-Alerts-5', 'Parks-and-Recreation-21', 'Police-34', 'Commonwealths-Attorney-65'];
const cidOf = (url) => new URL(url).searchParams.get('CID');
const FEED = Object.fromEntries([...NEWS_FEEDS, ...CROSS_POST_FEEDS].map((f) => [f.cid, f]));
/** The title the City gives a category's feed, e.g. "Norfolk, VA - News Flash - Home Spotlight". */
const titleFor = (cid) => `Norfolk, VA - ${FEED[cid].module === 1 ? 'News Flash' : 'Alert Center'} - ${FEED[cid].channel.replace(/&/g, '&amp;').replace(/'/g, '&#39;')}`;
const emptyFeed = (cid) => `<?xml version="1.0"?><rss version="2.0"><channel><title>${titleFor(cid)}</title></channel></rss>`;

/** An RSS body for a feed (default: the home page) from items: { title, link | aid, date (ms or string), description, guid }. */
function rss(items, cid = 'News-Home-page-1', title = titleFor(cid)) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = items
    .map((i) => {
      const link = i.link ?? `https://www.norfolk.gov/CivicAlerts.aspx?aid=${i.aid}`;
      const date = typeof i.date === 'number' ? new Date(i.date).toUTCString() : i.date;
      return `<item><title>${i.rawTitle ?? esc(i.title)}</title><link>${esc(link)}</link><pubDate>${date}</pubDate><description>${i.rawDescription ?? esc(i.description ?? '')}</description>${i.guid ? `<guid isPermaLink="false">${esc(i.guid)}</guid>` : ''}</item>`;
    })
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${body}</channel></rss>`;
}

/**
 * A fake City server. `feeds` maps a CID to a body, or to a function of the
 * try number returning a body, a status number, or 'reset' (a connection
 * reset, as the City's server does). Unknown CIDs get an empty feed.
 */
function server(feeds = {}) {
  const requests = [];
  const tries = {};
  const fetchImpl = async (url) => {
    const u = String(url);
    requests.push(u);
    const cid = cidOf(u);
    tries[cid] = (tries[cid] || 0) + 1;
    let out = cid in feeds ? feeds[cid] : emptyFeed(cid);
    if (typeof out === 'function') out = out(tries[cid]);
    if (out === 'reset') throw new TypeError('fetch failed: ECONNRESET');
    if (typeof out === 'number') return new Response('error page', { status: out });
    return new Response(out, { status: 200 });
  };
  return { fetchImpl, requests, tries };
}

const recordedServer = (overrides = {}) => server({ ...Object.fromEntries(RECORDED.map((c) => [c, fixture(c)])), ...overrides });

async function run(args, srv = recordedServer(), { now = NOW, budget } = {}) {
  const ctx = createContext({ city: norfolk, fetchImpl: srv.fetchImpl, plugins: [plugin], ...(budget ? { budget } : {}) });
  const result = await cityNews(pluginContext(ctx), args, { now });
  return { result, ctx, srv, trace: ctx.trace.toJSON(), resources: ctx.resources.toJSON() };
}

// --- parsing ---------------------------------------------------------------

test('parses the recorded home page feed: entities, escaped markup, CRLF, ISO dates with their offset', () => {
  const items = parseRss(fixture('News-Home-page-1'));
  assert.equal(items.length, 15);
  assert.deepEqual(items[0], {
    title: 'Norfolk Begins Two Major Road Resurfacing Projects on Nov. 16',
    link: 'https://www.norfolk.gov/CivicAlerts.aspx?aid=10619',
    guid: 'https://www.norfolk.gov/CivicAlerts.aspx?aid=10619/639299119230000000',
    date: '2026-11-10T13:52:03-05:00',
    summary: 'Expect lane closures, traffic delays and temporary parking restrictions through April 2027',
  });
  assert.match(items[1].summary, /^Following win on ABC-TV's The Great Christmas Light Fight/);
  const agenda = items.find((i) => i.link.endsWith('aid=10612'));
  assert.equal(agenda.summary, 'The current City Council agenda is available here', 'the escaped <a> is decoded, then stripped');
  assert.equal(items.find((i) => i.link.endsWith('aid=10607')).summary, '', 'a blank description is empty');
  assert.ok(items.every((i) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-05:00$/.test(i.date)));
  const spotlight = parseRss(fixture('Home-Spotlight-59'));
  assert.equal(
    spotlight.find((i) => /RentingSmart/.test(i.title)).summary,
    "Ready to feel more confident about renting? Rent Ready Norfolk's RentingSmart Academy offers FREE courses to help you navigate budgeting, lease agreements, tenant rights and more.",
    'a multi-line description is collapsed to one line'
  );
  assert.equal(spotlight.find((i) => /Towing/.test(i.title)).title, 'November 2026 Towing & Recovery Online Auction');
});

test('parses CDATA, numeric entities, tags and long descriptions', () => {
  const long = 'word '.repeat(100);
  const [a, b] = parseRss(
    rss([
      { rawTitle: '<![CDATA[Fish & Chips <b>Night</b>]]>', aid: 1, date: 'Tue, 10 Nov 2026 13:52:03 -0500', rawDescription: '<![CDATA[<p>Doors open at <strong>6</strong>.</p><script>alert(1)</script>]]>' },
      { rawTitle: 'Norfolk&#8217;s &#x2019;Lights&rsquo; &amp;amp; more', aid: 2, date: 'Tue, 10 Nov 2026 13:52:03 GMT', rawDescription: long },
    ])
  );
  assert.equal(a.title, 'Fish & Chips Night');
  assert.equal(a.summary, 'Doors open at 6 .');
  assert.equal(b.title, 'Norfolk’s ’Lights’ & more');
  assert.equal(b.summary.length, 300);
  assert.ok(b.summary.endsWith('…'));
  assert.equal(plainText('a <!-- hidden --> b<br/>c'), 'a b c');
  assert.throws(() => parseRss('<html><body>Service unavailable</body></html>'), /not an RSS feed/);
});

test('dates become ISO 8601, keeping the offset the feed gives', () => {
  assert.equal(isoDate('Tue, 10 Nov 2026 13:52:03 -0500'), '2026-11-10T13:52:03-05:00');
  assert.equal(isoDate('Fri, 30 Oct 2026 21:12:00 -0400'), '2026-10-30T21:12:00-04:00');
  assert.equal(isoDate('Tue, 10 Nov 2026 18:52:03 GMT'), '2026-11-10T18:52:03+00:00');
  assert.equal(isoDate('Tue, 10 Nov 2026 13:52 EST'), '2026-11-10T13:52:00-05:00');
  assert.equal(isoDate('2026-11-10T13:52:03Z'), '2026-11-10T13:52:03.000Z');
  assert.equal(isoDate('soon'), null);
  assert.equal(isoDate(''), null);
});

// --- the allowlist ---------------------------------------------------------

test('the allowlist never holds a police, prosecutor or all-categories feed', () => {
  assert.ok(Object.isFrozen(NEWS_FEEDS) && NEWS_FEEDS.every(Object.isFrozen), 'the list and its entries are frozen');
  for (const f of NEWS_FEEDS) {
    assert.ok(!FORBIDDEN_CIDS.includes(f.cid), `${f.cid} is forbidden`);
    assert.doesNotMatch(f.cid, /police|commonwealth|attorney|all-/i, `${f.cid} matches the forbidden pattern`);
    assert.ok([1, 63].includes(f.module), `${f.cid}: News Flash or Alert Center only`);
    assert.ok(f.label, `${f.cid} has a label`);
  }
  assert.equal(String(FORBIDDEN_CID_PATTERN), String(/police|commonwealth|attorney|all-/i));
  for (const cid of ['Police-34', 'Commonwealths-Attorney-65', 'All-newsflash.xml', 'All-0']) assert.ok(FORBIDDEN_CIDS.includes(cid), cid);
  // Left off on purpose (reasons in plugins/city-news.js).
  for (const cid of ['FireRescue-25', '2024-Footer-77']) assert.ok(!NEWS_FEEDS.some((f) => f.cid === cid), cid);
  // The plugin's own check throws at load on any of these.
  for (const cid of ['Police-34', 'Commonwealths-Attorney-65', 'All-newsflash.xml', 'All-0', 'NPD-Police-News-99', 'Small-Business-12'])
    assert.throws(() => checkAllowlist([{ module: 1, cid, channel: 'x', label: 'x' }]), /may never be read/, cid);
  assert.throws(() => checkAllowlist([{ module: 58, cid: 'Planning-151', channel: 'Planning', label: 'x' }]), /module 58/);
  // The server reads only the number at the end ("Community-34" served Police on 2026-11-10), and serves
  // every category for a CID with no number, so the number is the rule.
  assert.deepEqual(FORBIDDEN_CATEGORIES[1], [34, 65]);
  for (const f of NEWS_FEEDS) {
    const n = categoryNumber(f.cid);
    assert.ok(n > 0, `${f.cid} ends in a category number`);
    assert.ok(!FORBIDDEN_CATEGORIES[f.module].includes(n), `${f.cid}: category ${n} is forbidden`);
    assert.ok(f.channel, `${f.cid} names the City's channel`);
  }
  for (const cid of ['Community-34', 'Events-65', '34', 'Home-Spotlight-34']) assert.throws(() => checkAllowlist([{ module: 1, cid, channel: 'x', label: 'x' }]), /category (34|65) is forbidden|category number/, cid);
  for (const cid of ['News-Home-page-1x', 'All', 'News', 'Updates-0', 'News-1&CID=Police-34', 'News-1&x=2', 'News-1.xml'])
    assert.throws(() => checkAllowlist([{ module: 1, cid, channel: 'x', label: 'x' }]), /may never be read|category number/, cid);
  assert.equal(categoryNumber('News-Home-page-1'), 1);
  assert.equal(categoryNumber('All-newsflash.xml'), null);
  assert.equal(new Set(NEWS_FEEDS.map((f) => `${f.module}:${categoryNumber(f.cid)}`)).size, NEWS_FEEDS.length, 'no category twice');
  assert.deepEqual(CROSS_POST_FEEDS.map((f) => f.cid), ['Police-34', 'Commonwealths-Attorney-65']);
});

test('a call reads only allowlisted feeds for items, and the cross-post feeds for links', async () => {
  const allowed = new Set(NEWS_FEEDS.map(feedUrl));
  const guards = new Set(CROSS_POST_FEEDS.map(feedUrl));
  for (const query of [undefined, 'road', 'library', 'park tax audit litter', 'police arrests', 'all news', 'sail 250 st pauls']) {
    const { srv } = await run({ query });
    const itemFeeds = srv.requests.filter((u) => !guards.has(u));
    assert.ok(itemFeeds.every((u) => allowed.has(u)), `${query}: ${itemFeeds}`);
    assert.ok(itemFeeds.length <= MAX_FEEDS, `${query}: at most ${MAX_FEEDS} feeds`);
    assert.deepEqual(srv.requests.filter((u) => guards.has(u)).sort(), [...guards].sort(), `${query}: both cross-post feeds read`);
    assert.ok(srv.requests.every((u) => !/All-/i.test(u)));
  }
});

test('a feed is read only if its own title names the category asked for', async () => {
  for (const cid of RECORDED) assert.equal(checkChannel(fixture(cid), FEED[cid]), fixture(cid), `${cid}'s recorded title`);
  assert.equal(channelTitle(fixture('Commonwealths-Attorney-65')), "Norfolk, VA - News Flash - Commonwealth's Attorney");
  // As the server answered on 2026-11-10: a renumbered category, and a CID it didn't know (every category).
  const police = rss([{ title: 'Community update', aid: 60000, date: NOW - day }], 'Police-34');
  const everything = rss([{ title: 'Community update', aid: 60001, date: NOW - day }], 'News-Home-page-1', 'Norfolk, VA - News Flash');
  const { result } = await run({ days: 365, limit: 20 }, recordedServer({ 'Home-Spotlight-59': police, 'Treasurer-Due-Dates-89': everything }));
  const failed = Object.fromEntries(result.feeds_failed.map((f) => [f.category, f.error]));
  assert.match(failed['Home Spotlight'], /title is "Norfolk, VA - News Flash - Police", not "Norfolk, VA - News Flash - Home Spotlight", so it was not read/);
  assert.match(failed['Treasurer Due Dates'], /title is "Norfolk, VA - News Flash", not/);
  assert.ok(!result.items.some((i) => i.title === 'Community update'));
  assert.ok(result.items.some((i) => i.category === 'News, Home page'), 'the other feeds still come back');
  // A cross-post feed that isn't what it says marks the check incomplete.
  const wrong = await run({}, recordedServer({ 'Commonwealths-Attorney-65': rss([], 'News-Home-page-1') }));
  assert.match(wrong.result.cross_post_check, /^incomplete: I could not read the Commonwealth's Attorney feed's links/);
});

test('nothing from the Police or Commonwealth\'s Attorney feeds reaches the result or the hand-off', async () => {
  const { result, resources } = await run({ query: 'commonwealth', days: 365, limit: 20 });
  const out = JSON.stringify({ result, resources });
  for (const s of ['Jane Q. Example', 'John R. Sample', 'Placeholder', 'Fixture', 'Police-34', 'Commonwealths-Attorney-65', 'aid=10617', 'aid=10597']) assert.ok(!out.includes(s), s);
  // feedLinks reads links and guids only.
  const keys = feedLinks(fixture('Commonwealths-Attorney-65'));
  assert.ok([...keys].every((k) => /^norfolk\.gov#newsflash:\d+$/.test(k)), [...keys].join(','));
  assert.ok(keys.has('norfolk.gov#newsflash:10597'));
});

test('feeds are chosen by the query, always with the home page, spotlight and emergency alerts', () => {
  const labels = (q) => chooseFeeds(queryWords(q)).chosen.map((f) => f.cid);
  const base = ['News-Home-page-1', 'Home-Spotlight-59', 'Emergency-Alerts-5'];
  assert.deepEqual(labels(''), [...base, 'Treasurer-Due-Dates-89', 'Norfolk-Public-Library-News-83', 'Parks-and-Recreation-21']);
  assert.deepEqual(labels('road work'), labels(''), 'no topic: the default set');
  assert.deepEqual(labels('library hours'), [...base, 'Norfolk-Public-Library-News-83', 'Norfolk-Public-Library-Spotlight-82']);
  assert.deepEqual(labels('City Auditor report'), [...base, 'City-Auditor-69']);
  assert.equal(labels('park library tax audit litter sail').length, MAX_FEEDS);
  assert.equal(chooseFeeds(queryWords('library')).by, 'the query');
  assert.deepEqual(queryWords('The Norfolk library, closed?'), ['library', 'closed']);
});

// --- the guards --------------------------------------------------------------

const day = 864e5;

test('cross-posts: an allowed item linking to a Police or prosecutor item is dropped, by link or guid', async () => {
  const home = rss([
    { title: 'Community update', aid: 10617, date: NOW - day }, // the Police feed's first item, innocuous title
    { title: 'Neighborhood meeting', link: 'https://www.norfolk.gov/m/newsflash/home/detail/10611', date: NOW - day }, // mobile path, same item
    { title: 'Court notice', link: 'https://www.norfolk.gov/CivicAlerts.aspx?aid=99', guid: 'https://www.norfolk.gov/CivicAlerts.aspx?aid=10597/1', date: NOW - day }, // guid matches the prosecutor feed
    { title: 'Road resurfacing begins', aid: 20001, date: NOW - day },
  ]);
  const { result } = await run({}, recordedServer({ 'News-Home-page-1': home }));
  assert.equal(result.excluded.cross_posted, 3);
  assert.deepEqual(result.items.filter((i) => i.category === 'News, Home page').map((i) => i.title), ['Road resurfacing begins']);
  assert.match(result.cross_post_check, /^ran/);
  // The recorded feeds didn't overlap on 2026-11-10.
  const recorded = await run({ days: 365, limit: 20 });
  assert.equal(recorded.result.excluded.cross_posted, 0);
  assert.equal(linkKey('https://WWW.norfolk.gov/civicalerts.aspx?AID=10617'), linkKey('https://www.norfolk.gov/CivicAlerts.aspx?aid=10617/639299000000000000'));
  assert.notEqual(linkKey('https://www.norfolk.gov/4812/Real-Estate-Tax'), linkKey('https://www.norfolk.gov/4813/Other'));
});

test('cross-posts: if a cross-post feed can\'t be read, items still come back, with the check marked incomplete', async () => {
  const home = rss([
    { title: 'Community update', aid: 10597, date: NOW - day }, // in the prosecutor feed, which still loads
    { title: 'Library story time', aid: 20002, date: NOW - day },
  ]);
  const { result, trace } = await run({}, recordedServer({ 'News-Home-page-1': home, 'Police-34': () => 'reset' }));
  assert.match(result.cross_post_check, /^incomplete: I could not read the Police feed's links/);
  assert.equal(result.excluded.cross_posted, 1, 'the feed that loaded still guards');
  assert.ok(result.items.some((i) => i.title === 'Library story time'));
  assert.equal(trace.filter((s) => s.url.includes('Police-34')).length, 2, 'one retry, traced');
  const body = await run({}, recordedServer({ 'Police-34': () => 503 }));
  assert.match(body.result.cross_post_check, /\(HTTP 503\)/);
  assert.ok(!JSON.stringify(body.result).includes('error page'), "the server's error body stays out of the result");
});

test('wording: items whose title or summary reads like crime or court news are dropped', async () => {
  const titles = [
    'Woman charged in connection with ongoing shooting investigation',
    'Commonwealth v. Jane Q. Example',
    'Norfolk Police need your help to identify commercial burglary suspect',
    'Man dies following three-vehicle crash',
    'Norfolk Police make an arrest in connection with homicide investigation',
    'Missing person: help find a local teen',
    'Wanted: information on a robbery',
    'Defendant sentenced to 10 years',
    'Grand jury indicts two',
  ];
  const home = rss([
    ...titles.map((title, n) => ({ title, aid: 30000 + n, date: NOW - day })),
    { title: 'Community meeting', description: 'An update after last week\'s shooting on the block.', aid: 30100, date: NOW - day },
    { title: 'Road resurfacing begins', aid: 30200, date: NOW - day },
  ]);
  const { result } = await run({}, recordedServer({ 'News-Home-page-1': home }));
  assert.equal(result.excluded.crime_or_court_wording, titles.length + 1);
  assert.deepEqual(result.items.filter((i) => i.category === 'News, Home page').map((i) => i.title), ['Road resurfacing begins']);
  // No recorded City announcement trips it.
  for (const f of ['News-Home-page-1', 'Home-Spotlight-59', 'Treasurer-Due-Dates-89', 'Norfolk-Public-Library-News-83'])
    for (const i of parseRss(fixture(f))) assert.ok(!CRIME_WORDS.test(i.title) && !CRIME_WORDS.test(i.summary), i.title);
  // Every sanitized Police and prosecutor title does.
  for (const f of ['Police-34', 'Commonwealths-Attorney-65']) for (const i of parseRss(fixture(f))) assert.match(i.title, CRIME_WORDS);
});

test('links off www.norfolk.gov are dropped', async () => {
  const home = rss([
    { title: 'Off site', link: 'https://example.org/news', date: NOW - day },
    { title: 'Lookalike host', link: 'https://www.norfolk.gov.example.com/x', date: NOW - day },
    { title: 'Open data portal', link: 'https://data.norfolk.gov/d/abcd-1234', date: NOW - day },
    { title: 'Userinfo', link: 'https://someone@www.norfolk.gov/x', date: NOW - day },
    { title: 'No link', link: '', date: NOW - day },
    { title: 'Script', link: 'javascript:alert(1)', date: NOW - day },
    { title: 'Plain http on the City site', link: 'http://www.norfolk.gov/4812/Real-Estate-Tax', date: NOW - day },
  ]);
  const { result } = await run({}, recordedServer({ 'News-Home-page-1': home }));
  assert.equal(result.excluded.off_site_link, 6);
  const kept = result.items.filter((i) => i.category === 'News, Home page');
  assert.deepEqual(kept.map((i) => i.link), ['https://www.norfolk.gov/4812/Real-Estate-Tax']);
  assert.ok(result.items.every((i) => i.link.startsWith('https://www.norfolk.gov/')));
  assert.equal(cityLink('https://WWW.NORFOLK.GOV./CivicAlerts.aspx?aid=1#top'), 'https://www.norfolk.gov/CivicAlerts.aspx?aid=1');
  assert.equal(cityLink('https://norfolk.gov/x'), null);
  assert.equal(cityLink('https://www.norfolk.gov:8443/x'), null);
});

// --- query, days and limit ---------------------------------------------------

test('query, days and limit filter the recorded feeds, newest first', async () => {
  const all = (await run({ days: 365, limit: 20 })).result;
  assert.equal(all.items.length, 20);
  assert.equal(all.items_matching, 26);
  const times = all.items.map((i) => Date.parse(i.date));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  assert.deepEqual(Object.keys(all.items[0]), ['category', 'title', 'date', 'link', 'summary']);

  const month = (await run({})).result;
  assert.equal(month.days, 30);
  assert.equal(month.items.length, 10);
  assert.ok(month.items.every((i) => Date.parse(i.date) >= NOW - 30 * day));

  const week = (await run({ days: 7, limit: 20 })).result;
  assert.ok(week.items.length > 0 && week.items.every((i) => Date.parse(i.date) >= NOW - 7 * day));
  assert.ok(week.items_matching < month.items_matching);

  const road = (await run({ query: 'road' })).result;
  assert.deepEqual(road.items.map((i) => i.title), ['Norfolk Begins Two Major Road Resurfacing Projects on Nov. 16']);
  assert.equal(road.matched_on, 'every word');
  assert.deepEqual(road.query_words, ['road']);

  const library = (await run({ query: 'LIBRARY closed' })).result;
  assert.deepEqual(library.items.map((i) => i.title), ['All Norfolk Public Library Locations closed on 11/11']);

  const loose = (await run({ query: 'veterans zoo' })).result;
  assert.match(loose.matched_on, /^any word/);
  assert.ok(loose.items.some((i) => /Zoo/.test(i.title)) && loose.items.some((i) => /Veterans/.test(i.title)));

  const none = (await run({ query: 'xylophone' })).result;
  assert.equal(none.items.length, 0);

  assert.equal((await run({ limit: 3 })).result.items.length, 3);
  assert.equal((await run({ days: 365, limit: 500 })).result.items.length, 20, 'limit is capped at 20');
  assert.equal((await run({ days: 0 })).result.days, 1);
  assert.equal((await run({ days: 9999 })).result.days, 365);
  assert.equal((await run({ days: null, limit: null })).result.days, 30);
  assert.equal((await run(null)).result.days, 30);
});

test('the same announcement in two feeds is returned once', async () => {
  const item = { title: 'Holiday hours', aid: 40000, date: NOW - day };
  const { result } = await run({}, recordedServer({ 'News-Home-page-1': rss([item]), 'Home-Spotlight-59': rss([item], 'Home-Spotlight-59') }));
  assert.equal(result.items.filter((i) => i.title === 'Holiday hours').length, 1);
  assert.equal(result.items.find((i) => i.title === 'Holiday hours').category, 'News, Home page');
});

// --- failures, the trace and the budget --------------------------------------

test('a failed feed is reported and the others still come back; one retry each, counted', async () => {
  const srv = recordedServer({
    'Home-Spotlight-59': () => 503, // down: tried twice
    'Treasurer-Due-Dates-89': (n) => (n === 1 ? 'reset' : fixture('Treasurer-Due-Dates-89')), // flaky: the second try works
    'Norfolk-Public-Library-News-83': () => 404, // gone: not retried
    'Parks-and-Recreation-21': () => '<html>Maintenance</html>', // not a feed: not retried
  });
  const { result, trace } = await run({ days: 365, limit: 20 }, srv);
  const failed = Object.fromEntries(result.feeds_failed.map((f) => [f.category, f]));
  assert.match(failed['Home Spotlight'].error, /HTTP 503/);
  assert.equal(failed['Home Spotlight'].tries, 2);
  assert.match(failed['Norfolk Public Library - News'].error, /HTTP 404/);
  assert.equal(failed['Norfolk Public Library - News'].tries, 1);
  assert.match(failed['Parks and Recreation (alerts)'].error, /not an RSS feed/);
  assert.equal(srv.tries['Home-Spotlight-59'], 2, 'no hidden third try: the built-in 5xx retry is off');
  assert.equal(srv.tries['Treasurer-Due-Dates-89'], 2);
  assert.equal(srv.tries['Norfolk-Public-Library-News-83'], 1);
  assert.equal(srv.tries['Parks-and-Recreation-21'], 1);
  assert.equal(result.feeds_read.find((f) => f.category === 'Treasurer Due Dates').tries, 2);
  assert.ok(result.items.some((i) => i.category === 'News, Home page'));
  assert.ok(result.items.some((i) => i.category === 'Treasurer Due Dates'));
  assert.equal(trace.filter((s) => !s.ok).length, 4, 'two failed Spotlight tries, one reset, one 404');
  for (const s of trace) assert.ok(s.ok || s.error, `step ${s.n} records its outcome`);
});

test('every request is traced and counted on the answer\'s budget', async () => {
  const srv = recordedServer({ 'Home-Spotlight-59': (n) => (n === 1 ? 'reset' : fixture('Home-Spotlight-59')) });
  const budget = requestBudget({ fetchImpl: srv.fetchImpl });
  const { trace } = await run({ query: 'library' }, srv, { budget });
  assert.equal(budget.summary().tools, srv.requests.length);
  assert.equal(trace.length, srv.requests.length, 'one traced step per request, retries included');
  assert.deepEqual(trace.map((s) => s.url).sort(), [...srv.requests].sort());
  assert.ok(trace.some((s) => /links only \(cross-post check\)/.test(s.tool)));
  assert.ok(srv.requests.length <= 2 * (MAX_FEEDS + CROSS_POST_FEEDS.length));
});

test('a request the budget refuses is not retried', async () => {
  const srv = recordedServer();
  const budget = requestBudget({ limit: 3, fetchImpl: srv.fetchImpl });
  const { result, trace } = await run({}, srv, { budget });
  assert.equal(srv.requests.length, 3);
  const refused = trace.filter((s) => s.refused);
  assert.ok(refused.length > 0);
  assert.equal(new Set(refused.map((s) => s.url)).size, refused.length, 'each refused feed tried once');
  assert.ok(result.feeds_failed.every((f) => f.tries === 1));
  assert.match(result.cross_post_check, /^ran/, 'the cross-post feeds are asked for first');
  assert.deepEqual(srv.requests.slice(0, 2).map(cidOf), ['Police-34', 'Commonwealths-Attorney-65']);
});

test('tracedHttp can leave the retry to its caller', async () => {
  let calls = 0;
  const http = tracedHttp(new Trace(), async () => (++calls, new Response('busy', { status: 503 })));
  await assert.rejects(http.text('https://www.norfolk.gov/x', { retry: false }), /HTTP 503/);
  assert.equal(calls, 1);
});

// --- hand-off, conformance and Siren -----------------------------------------

test('hand-off: the returned announcements and the category pages, never the police feeds', async () => {
  const { result, resources } = await run({ days: 365, limit: 5 });
  const news = resources.records.filter((r) => r.kind === 'news');
  assert.deepEqual(news.map((r) => r.url), result.items.map((i) => i.link));
  assert.ok(news.every((r) => r.title.startsWith('City of Norfolk news: ') && r.title.length <= 160));
  assert.ok(resources.links.some((l) => l.url === 'https://www.norfolk.gov/rss.aspx'));
  assert.ok(resources.links.some((l) => l.url === 'https://www.norfolk.gov/CivicAlerts.aspx?CID=1'));
  assert.ok(resources.links.some((l) => l.url === 'https://www.norfolk.gov/AlertCenter.aspx?CID=5'));
  assert.ok(!JSON.stringify(resources).match(/CID=(34|65)\b|Police|Commonwealth/));
});

test('city_news passes plugin conformance and the source check', async () => {
  checkPluginFile(new URL('../plugins/city-news.js', import.meta.url));
  const now = Date.now();
  const respond = (url) => {
    const cid = cidOf(url);
    if (cid === 'News-Home-page-1') return rss([{ title: 'Road resurfacing begins', aid: 50000, date: now - day, description: 'Lane closures through April.' }]);
    if (cid === 'Police-34') return rss([{ title: 'Man charged', aid: 50001, date: now - day }], 'Police-34');
    return emptyFeed(cid);
  };
  const { result, trace, resources } = await checkPlugin(plugin, { city: norfolk, args: { query: 'road' }, respond });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].summary, 'Lane closures through April.');
  assert.equal(trace.length, 8);
  assert.ok(resources.records.some((r) => r.kind === 'news'));
});

test('city_news is in Siren, with a prompt line that keeps police and court news out', () => {
  assert.ok(siren.plugins.some((p) => p.name === 'city_news'));
  const line = siren.prompt.split('\n').find((l) => l.includes('city_news'));
  assert.ok(line, 'a prompt line names city_news');
  assert.match(line, /closures, events, programs, road work, grants/);
  assert.match(line, /no police or court news/);
  assert.match(line, /Don't repeat a private person's name/);
  const prompt = systemPrompt(applyConfig(norfolk, siren), '2026-11-10');
  assert.match(prompt, /city_news/);
});
