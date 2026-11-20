// Case files as public hub pages (Jason, 2026-11-20: "We should publish
// these case files as hub pages, so we can be transparent about our sources.
// Bibliography pools. Under /case-files/{slug}").
//
// `/case-files` lists every case file and pools their bibliographies: every
// source any case file cites, grouped by publisher, with the case files that
// cite it. `/case-files/<id>` is one case file: its question, summary and
// what isn't settled, then its bibliography, each source with the findings
// that cite it (claim, stance, the exact quote, when it was checked and the
// evidence of the bytes read). The data is what `/api/cases` and the repo
// already publish; nothing here reads a request, a cookie or KV.
//
// Server-rendered, no script, one stylesheet from this origin (its own
// hashed path, so the app's ASSET_HASH, and every other page, is unchanged).
// Every string from a case file is escaped; a link is made only from an
// http(s) URL.

import CSS from './case-files.css' with { type: 'text' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const REPO = 'https://github.com/jedelman/socrata-agent/blob/main';

function fnv(s, h) {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
export const CSS_NAME = `case-files.${fnv(CSS, 0x811c9dc5)}.css`;
export const CASE_FILES_CSS = CSS;

/** An http(s) URL as a URL object, or null: nothing else becomes a link. */
function httpUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}
const ext = (u, text) => {
  const url = httpUrl(u);
  return url ? `<a href="${esc(url.href)}" rel="noopener noreferrer">${text}</a>` : text;
};

// Publishers by host, for the pooled bibliography. Unknown hosts show as
// the host itself.
const PUBLISHERS = {
  'www.norfolk.gov': 'City of Norfolk',
  'norfolk.gov': 'City of Norfolk',
  'norfolkcityva.iqm2.com': 'City of Norfolk (Council and board records)',
  'library.municode.com': 'Norfolk City Code (Municode)',
  'law.lis.virginia.gov': 'Code of Virginia',
  'lis.virginia.gov': 'Virginia General Assembly',
  'www.whro.org': 'WHRO',
  'whro.org': 'WHRO',
};
export function publisherOf(u) {
  const url = httpUrl(u);
  if (!url) return 'Other';
  return PUBLISHERS[url.hostname] || url.hostname.replace(/^www\./, '');
}
const kindOf = (u) => {
  const url = httpUrl(u);
  if (!url) return '';
  return /\/DocumentCenter\/View\/|\.pdf$/i.test(url.pathname) ? 'PDF' : 'web page';
};

const STANCE = {
  confirms: 'Confirms',
  weakens: 'Weakens',
  context: 'Context',
  who_decides: 'Who decides',
  rules: 'Rules',
};
const verified = (f) => !f.unverified && f.checked && f.quote;

/** Sources of one case file, in first-cited order, each with its findings. */
export function bibliography(doc) {
  const byUrl = new Map();
  for (const f of doc.findings) {
    const key = f.source.url;
    if (!byUrl.has(key)) byUrl.set(key, { url: key, title: f.source.title, titles: new Set(), findings: [], archive: null });
    const s = byUrl.get(key);
    s.titles.add(f.source.title);
    s.findings.push(f);
    if (f.source.archive?.url && !s.archive) s.archive = f.source.archive;
  }
  return [...byUrl.values()].map((s) => {
    const checked = s.findings.map((f) => f.checked).filter(Boolean).sort();
    const reads = s.findings.map((f) => f.evidence).filter((e) => e?.cid);
    const latest = reads.sort((a, b) => String(b.read).localeCompare(String(a.read)))[0] || null;
    return { ...s, titles: [...s.titles], checked: checked.at(-1) || null, evidence: latest, publisher: publisherOf(s.url), kind: kindOf(s.url) };
  });
}

/** Every source across case files, grouped by publisher. */
export function pooledBibliography(cases) {
  const byUrl = new Map();
  for (const doc of cases) {
    for (const s of bibliography(doc)) {
      if (!byUrl.has(s.url)) byUrl.set(s.url, { url: s.url, title: s.title, publisher: s.publisher, kind: s.kind, cases: [], findings: 0, checked: null });
      const p = byUrl.get(s.url);
      p.cases.push({ id: doc.id, title: doc.title });
      p.findings += s.findings.length;
      if (s.checked && (!p.checked || s.checked > p.checked)) p.checked = s.checked;
    }
  }
  const groups = new Map();
  for (const s of byUrl.values()) {
    if (!groups.has(s.publisher)) groups.set(s.publisher, []);
    groups.get(s.publisher).push(s);
  }
  return [...groups.entries()]
    .map(([publisher, sources]) => ({ publisher, sources: sources.sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => b.sources.length - a.sources.length || a.publisher.localeCompare(b.publisher));
}

const sourceAnchor = (doc, url) => `s${bibliography(doc).findIndex((s) => s.url === url) + 1}`;

function page({ title, base, appName, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(appName)}</title>
<link rel="stylesheet" href="${esc(base)}/case-files/${CSS_NAME}">
</head>
<body>
<main class="cf">
${body}
</main>
</body>
</html>
`;
}

function findingHtml(f, doc) {
  const ok = verified(f);
  const ev = f.evidence?.cid
    ? ` · <abbr title="DASL content identifier of the bytes the verifier read">CID</abbr> <code>${esc(f.evidence.cid)}</code>`
    : '';
  const absent = f.absent ? `<p class="absent">And checked that “${esc(f.absent)}” is not on the page.</p>` : '';
  const archived = f.checked_via === 'archive' && f.source.archive?.url ? ` · ${ext(f.source.archive.url, 'verified against the archived copy')}: the live page changed` : '';
  return `<li class="finding" id="f-${esc(f.id)}">
  <p class="claim"><span class="stance stance-${esc(f.stance)}">${esc(STANCE[f.stance] || f.stance)}</span> ${esc(f.claim)}</p>
  ${ok ? `<blockquote>${esc(f.quote)}</blockquote>${absent}` : '<p class="unverified">Not yet verified: no quote has been checked against this source.</p>'}
  <p class="meta">${ok ? `Quote checked ${esc(f.checked)}${archived}${ev}` : 'Unverified'} · found by ${esc(f.found_by || 'unknown')} · <a href="#f-${esc(f.id)}">#${esc(f.id)}</a></p>
</li>`;
}

/** One case file's hub page. */
export function caseFilePage(doc, { base = '', appName = 'Siren', origin = '' } = {}) {
  const bib = bibliography(doc);
  const nVerified = doc.findings.filter(verified).length;
  const stances = Object.keys(STANCE)
    .map((k) => [k, doc.findings.filter((f) => f.stance === k).length])
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${esc(STANCE[k].toLowerCase())}`)
    .join(', ');
  const sources = bib.map((s, i) => `<li class="source" id="s${i + 1}">
  <h3>${ext(s.url, esc(s.title))}</h3>
  ${s.titles.length > 1 ? `<p class="also">Also cited as: ${s.titles.slice(1).map(esc).join('; ')}</p>` : ''}
  <p class="meta">${esc(s.publisher)}${s.kind ? ` · ${esc(s.kind)}` : ''} · ${s.findings.length} finding${s.findings.length === 1 ? '' : 's'}${s.checked ? ` · last checked ${esc(s.checked)}` : ''}${s.archive?.url ? ` · ${ext(s.archive.url, 'archived copy')}` : ''}</p>
  <ol class="findings">
  ${s.findings.map((f) => findingHtml(f, doc)).join('\n  ')}
  </ol>
</li>`).join('\n');
  const list = (items, render) => (items?.length ? `<ul>${items.map(render).join('')}</ul>` : '');
  const byId = Object.fromEntries(doc.findings.map((f) => [f.id, f]));
  const help = list(doc.what_would_help, (h) => `<li>${esc(h.text)}${byId[h.finding] ? ` <a href="#f-${esc(h.finding)}">(based on #${esc(h.finding)})</a>` : ''}</li>`);
  const body = `<p class="back"><a href="${esc(base)}/case-files">All case files</a> · <a href="${esc(base)}/">Ask ${esc(appName)}</a></p>
<p class="kicker">Case file</p>
<h1>${esc(doc.title)}</h1>
<p class="lede">${esc(doc.summary)}</p>
<p class="facts">${bib.length} source${bib.length === 1 ? '' : 's'} · ${doc.findings.length} findings (${stances}) · ${nVerified} with quotes checked against their source${doc.reviewed ? ` · reviewed ${esc(doc.reviewed)}` : ''}</p>
<p class="fine">Every finding quotes its source exactly and claims no more than the quote. A script re-reads every source and fails if a quote is missing; the date beside each quote is the last time it was found, and the CID identifies the exact bytes read. Findings that weaken the case are kept beside those that confirm it. Steward: ${esc(doc.steward)}. License: ${doc.license === 'CC-BY-4.0' ? `${ext('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')}, with credit to whoever found each finding` : esc(doc.license)}.</p>
${doc.pending?.length ? `<section><h2>Not yet settled</h2>${list(doc.pending, (p) => `<li>${esc(p)}</li>`)}</section>` : ''}
<section><h2>Bibliography</h2>
<ol class="sources">
${sources}
</ol>
</section>
${help ? `<section><h2>What would help</h2>${help}</section>` : ''}
${doc.records_to_request?.length ? `<section><h2>Records to request</h2><p class="fine">Drafts for anyone to send under the Virginia Freedom of Information Act; ${esc(appName)} never sends them.</p>${list(doc.records_to_request, (r) => `<li>${esc(r)}</li>`)}</section>` : ''}
<footer><p class="fine">The same findings as ${ext(`${origin}${base}/api/cases/${encodeURIComponent(doc.id)}`, 'W3C Web Annotations (JSON-LD)')} and as ${ext(`${REPO}/data/cases/${encodeURIComponent(doc.id)}.json`, 'the case file in the repository')}, with its history.</p></footer>`;
  return page({ title: doc.title, base, appName, body });
}

/** The index: every case file, then their sources pooled by publisher. */
export function caseFilesIndex(cases, { base = '', appName = 'Siren' } = {}) {
  const pool = pooledBibliography(cases);
  const total = pool.reduce((n, g) => n + g.sources.length, 0);
  const items = cases.map((doc) => {
    const bib = bibliography(doc);
    return `<li><a href="${esc(base)}/case-files/${esc(encodeURIComponent(doc.id))}">${esc(doc.title)}</a> <small>${bib.length} source${bib.length === 1 ? '' : 's'} · ${doc.findings.length} finding${doc.findings.length === 1 ? '' : 's'}${doc.reviewed ? ` · reviewed ${esc(doc.reviewed)}` : ''}</small></li>`;
  }).join('\n');
  const groups = pool.map((g) => `<section class="pool">
<h3>${esc(g.publisher)} <small>${g.sources.length} source${g.sources.length === 1 ? '' : 's'}</small></h3>
<ul>
${g.sources.map((s) => {
    const cited = s.cases.map((c) => {
      const doc = cases.find((d) => d.id === c.id);
      return `<a href="${esc(base)}/case-files/${esc(encodeURIComponent(c.id))}#${sourceAnchor(doc, s.url)}">${esc(c.title)}</a>`;
    }).join('; ');
    return `<li>${ext(s.url, esc(s.title))} <small>${s.kind ? `${esc(s.kind)} · ` : ''}${s.findings} finding${s.findings === 1 ? '' : 's'}${s.checked ? ` · last checked ${esc(s.checked)}` : ''}</small><br><span class="cited">Cited in ${cited}</span></li>`;
  }).join('\n')}
</ul>
</section>`).join('\n');
  const body = `<p class="back"><a href="${esc(base)}/">Ask ${esc(appName)}</a></p>
<h1>Case files</h1>
<p class="lede">Research done once, checked against its sources, and served to every question ${esc(appName)} answers on the topic. Each case file shows every source it rests on, the exact words quoted from each, and when each quote was last found there.</p>
<ul class="cases">
${items}
</ul>
<section><h2>Every source</h2>
<p class="fine">${total} sources across ${cases.length} case files, pooled by publisher. A source cited by more than one case file is listed once.</p>
${groups}
</section>`;
  return page({ title: 'Case files', base, appName, body });
}
