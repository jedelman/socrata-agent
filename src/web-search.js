// Web search for Claude models: Anthropic's server tool, run by Anthropic on
// the model's request, behind a deployment's list of allowed sites.
//
// Off unless a deployment config sets `webSearch: { allowedDomains, maxUses }`
// (validated here, through src/plugins.js webSearchConfig). The list goes to
// the API as the tool's `allowed_domains`, and the API enforces it; only
// Jason widens Siren's. Nothing here fetches anything: the search runs on
// Anthropic's side, and this module reads what the API's response says ran.
// The trace steps and hand-off records it writes come from the response's
// own blocks (server_tool_use, web_search_tool_result, text citations),
// never from the model's text.
//
// API facts, read 2026-11-10 from the live docs:
//   https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
//   https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools
//   https://platform.claude.com/docs/en/about-claude/pricing
// - The tool is { type: 'web_search_20260209', name: 'web_search',
//   allowed_domains, max_uses }. On this version `allowed_callers` defaults
//   to code execution: the model may run searches from code that filters the
//   results ("dynamic filtering"); each such server_tool_use /
//   web_search_tool_result pair then carries a `caller` naming the code
//   execution call. Code execution used this way costs nothing extra.
// - allowed_domains entries are bare domains with an optional path, no
//   scheme. Subdomains are included (example.com covers docs.example.com); a
//   subdomain entry covers only that subdomain. A path matches anything
//   after it. Wildcards only in the path, never in the domain. Invalid
//   entries are a 400. A request's list must sit inside any list the
//   organization sets in the Console. ASCII only (homograph warning).
//   No length cap is stated for the Messages API (a long list can fail a
//   search with `request_too_large`); Managed Agents allows 1 to 64 entries
//   (claude-api skill, managed-agents tools), which this file adopts. IPs,
//   bare TLDs and single-label names are refused there; refused here too.
// - max_uses caps searches in a turn; past it, a direct call's result is an
//   error `max_uses_exceeded`. Failed searches count against it.
// - Results: web_search_tool_result.content is a list of web_search_result
//   { url, title, page_age, encrypted_content } on success, an empty list
//   when nothing matched, or one object { type:
//   'web_search_tool_result_error', error_code } on failure, with HTTP 200.
//   Codes: too_many_requests, invalid_tool_input, max_uses_exceeded,
//   query_too_long, request_too_large, unavailable.
// - Citations on text blocks: { type: 'web_search_result_location', url,
//   title, encrypted_index, cited_text }.
// - Usage: usage.server_tool_use.web_search_requests. $10 per 1,000
//   searches on top of tokens; a search that fails with an error isn't billed.

export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209';
/** USD per search: $10 per 1,000 (pricing page, read 2026-11-10). */
export const WEB_SEARCH_USD = 0.01;
export const MAX_ALLOWED_DOMAINS = 64;
/** The most searches per turn a deployment may allow (a cost bound, not an API limit). */
export const MAX_USES_CAP = 10;
export const WEB_SEARCH_DOCS = 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool';
export const WEB_SEARCH_STEP = 'web search (run by Anthropic)';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/** Why an allowed_domains entry is refused, or null if it is a valid entry. */
export function domainProblem(entry) {
  if (typeof entry !== 'string' || !entry) return 'must be a non-empty string';
  if (!/^[\x21-\x7e]+$/.test(entry)) return 'must be plain ASCII with no spaces (non-ASCII names can impersonate others)';
  if (entry.includes('://')) return 'must not include a scheme (write example.gov, not https://example.gov)';
  const slash = entry.indexOf('/');
  const host = slash < 0 ? entry : entry.slice(0, slash);
  const path = slash < 0 ? '' : entry.slice(slash);
  if (host !== host.toLowerCase()) return 'must be lowercase';
  if (host.includes('*')) return 'may not use a wildcard in the domain (only in a path)';
  if (host.includes(':')) return 'must not include a port or be an IPv6 address';
  if (host.length > 253) return 'is too long';
  const labels = host.split('.');
  if (labels.length < 2) return 'must be a full domain, not a single label, bare TLD or localhost';
  if (!labels.every((l) => LABEL.test(l))) return 'is not a valid domain name';
  if (!/^[a-z]{2,63}$/.test(labels.at(-1))) return 'must end in a real top-level domain (IP addresses are refused)';
  if (path && !PATH.test(path)) return 'has a path with characters a domain filter does not take';
  return null;
}

const split = (entry) => {
  const slash = entry.indexOf('/');
  return slash < 0 ? { host: entry, path: '' } : { host: entry.slice(0, slash), path: entry.slice(slash) };
};

/** Whether allowed_domains entry `a` already covers entry `b` (subdomains and longer paths included). */
export function covers(a, b) {
  const x = split(a);
  const y = split(b);
  const hostCovered = y.host === x.host || y.host.endsWith(`.${x.host}`);
  if (!hostCovered) return false;
  if (!x.path || x.path === '/' || x.path === '/*') return true;
  // A path entry on a different host than its own never covers it.
  if (y.host !== x.host) return false;
  return y.path.startsWith(x.path.replace(/\*.*$/, ''));
}

/**
 * A deployment's `webSearch` block, checked: null when absent (web search
 * off), else a frozen { allowedDomains, maxUses }. Throws on anything else,
 * so a bad list fails loudly at startup and in tests, never at the API.
 */
export function webSearchSettings(block) {
  if (block == null) return null;
  if (typeof block !== 'object' || Array.isArray(block)) throw new Error('webSearch must be an object: { allowedDomains: [...], maxUses }.');
  const unknown = Object.keys(block).filter((k) => k !== 'allowedDomains' && k !== 'maxUses');
  if (unknown.length) throw new Error(`webSearch takes only allowedDomains and maxUses (got ${unknown.join(', ')}). It is an allowlist; there is no blocklist form.`);
  const list = block.allowedDomains;
  if (!Array.isArray(list) || !list.length) throw new Error('webSearch.allowedDomains must list at least one domain: web search runs only behind an allowlist.');
  if (list.length > MAX_ALLOWED_DOMAINS) throw new Error(`webSearch.allowedDomains lists ${list.length} domains; keep it to ${MAX_ALLOWED_DOMAINS} or fewer.`);
  for (const d of list) {
    const why = domainProblem(d);
    if (why) throw new Error(`webSearch.allowedDomains entry ${JSON.stringify(d)} ${why}.`);
  }
  list.forEach((a, i) =>
    list.forEach((b, j) => {
      if (i === j) return;
      if (a === b) throw new Error(`webSearch.allowedDomains lists ${a} twice.`);
      if (covers(a, b)) throw new Error(`webSearch.allowedDomains entry ${b} is already covered by ${a} (subdomains and longer paths are included).`);
    })
  );
  const maxUses = block.maxUses;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES_CAP) throw new Error(`webSearch.maxUses must be a whole number from 1 to ${MAX_USES_CAP}.`);
  return Object.freeze({ allowedDomains: Object.freeze([...list]), maxUses });
}

/**
 * Web search must not reach the city's open data portal: its datasets are
 * read only through src/socrata.js, under the city's policy (excluded
 * datasets, withheld columns, suppressed rows), as ctx.http refuses Socrata
 * hosts for plugins. An allowlist entry that covers the portal (norfolk.gov
 * covers data.norfolk.gov) is refused; list the subdomains wanted instead.
 */
export function checkWebSearchForCity(settings, city) {
  if (!settings) return settings;
  const portalHost = (u) => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  const hosts = [city?.domain, city?.portal && portalHost(city.portal), 'socrata.com'].filter(Boolean).map((h) => h.toLowerCase());
  // By host, whatever the path: data.norfolk.gov/anything is still the portal.
  const touches = (entryHost, h) => entryHost === h || h.endsWith(`.${entryHost}`) || entryHost.endsWith(`.${h}`);
  for (const d of settings.allowedDomains) {
    const host = hosts.find((h) => touches(split(d).host, h));
    if (host) throw new Error(`webSearch.allowedDomains entry ${d} covers ${host}, the open data portal, whose data goes only through the dataset policy. List the other subdomains you want instead.`);
  }
  return settings;
}

/** The Messages API tool for checked settings. */
export function webSearchTool(settings) {
  return { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', allowed_domains: [...settings.allowedDomains], max_uses: settings.maxUses };
}

/** Whether a result URL sits inside the allowed list (the API enforces this; code checks again). */
export function urlAllowed(url, allowedDomains) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const entry = `${u.hostname.toLowerCase().replace(/\.$/, '')}${u.pathname || '/'}`;
  return allowedDomains.some((d) => covers(d, entry));
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const httpUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u.slice(0, 2000) : null);

/**
 * The web searches a response shows, from its blocks: each server_tool_use
 * named web_search paired with its web_search_tool_result by id. A call
 * whose result isn't in this response (it waits on a client tool) is kept in
 * `pending` and paired when its result arrives in a later response.
 * Returns [{ id, query, caller, results: [{ url, title, page_age }] } or
 * { id, query, caller, error }].
 */
export function searchesIn(content = [], pending = new Map()) {
  const out = [];
  for (const b of content || []) {
    if (b?.type === 'server_tool_use' && b.name === 'web_search') {
      pending.set(b.id, { query: clip(b.input?.query, 500), caller: b.caller?.type && b.caller.type !== 'direct' ? b.caller.type : null });
    }
  }
  for (const b of content || []) {
    if (b?.type !== 'web_search_tool_result' || typeof b.tool_use_id !== 'string') continue;
    // A result whose call this provider never saw still ran: traced without its query.
    const call = pending.get(b.tool_use_id) || { query: '(query not in the response)', caller: b.caller?.type && b.caller.type !== 'direct' ? b.caller.type : null };
    pending.delete(b.tool_use_id);
    const base = { id: b.tool_use_id, query: call.query, caller: call.caller };
    if (Array.isArray(b.content)) {
      const results = b.content
        .filter((r) => r?.type === 'web_search_result' && httpUrl(r.url))
        .map((r) => ({ url: httpUrl(r.url), title: clip(r.title, 300) || httpUrl(r.url), ...(r.page_age ? { page_age: clip(r.page_age, 60) } : {}) }));
      out.push({ ...base, results });
    } else {
      const code = b.content?.type === 'web_search_tool_result_error' ? String(b.content.error_code || 'unknown').replace(/[^a-z_]/gi, '').slice(0, 60) : 'unrecognized_result';
      out.push({ ...base, error: code });
    }
  }
  return out;
}

/** Searches the API billed in a response, as its blocks show them: each search that returned (failed ones aren't billed). */
export function searchesBilledIn(content = []) {
  return (content || []).filter((b) => b?.type === 'web_search_tool_result' && Array.isArray(b.content)).length;
}

/** Web citations on a response's text blocks, as the API attached them. */
export function citationsIn(content = []) {
  const out = [];
  for (const b of content || []) {
    if (b?.type !== 'text' || !Array.isArray(b.citations)) continue;
    for (const c of b.citations) {
      const url = c?.type === 'web_search_result_location' ? httpUrl(c.url) : null;
      if (url) out.push({ url, title: clip(c.title, 300) || url });
    }
  }
  return out;
}

const ERRORS = {
  too_many_requests: "Anthropic's search rate limit was reached",
  invalid_tool_input: 'the search query was not valid',
  max_uses_exceeded: "this step's search limit was reached",
  query_too_long: 'the search query was too long',
  request_too_large: 'the search request was too large',
  unavailable: 'the search service was unavailable',
};

const PROVIDER_NOTE = 'Run by Anthropic for the model, limited to this deployment\'s allowed sites; this app sent no request of its own for it.';

/**
 * Trace steps for a response's searches, one per search, written from the
 * response's blocks. `withheld` (the model declined the step, so its output
 * is discarded) keeps the step but not the query or the results. Results
 * outside the allowed list (the API should never return one) are listed in
 * the step as not handed off. Returns the results that may be handed off.
 */
export async function traceSearches(trace, searches, { allowedDomains, withheld = false }) {
  const usable = [];
  for (const s of searches) {
    const results = s.results || [];
    const inside = results.filter((r) => urlAllowed(r.url, allowedDomains));
    const outside = results.length - inside.length;
    if (!withheld) usable.push(...inside);
    const how = s.caller ? ' Called from code the model ran on Anthropic\'s servers to filter results.' : '';
    const listed = inside.slice(0, 10).map((r) => `${clip(r.title, 100)} <${r.url}>`).join('; ');
    const summary = withheld
      ? `(the model declined this step, so its search and results are withheld) ${PROVIDER_NOTE}`
      : s.error
        ? `"${s.query}" ${PROVIDER_NOTE}${how}`
        : `"${s.query}" → ${results.length} result${results.length === 1 ? '' : 's'}${listed ? `: ${listed}${inside.length > 10 ? `; and ${inside.length - 10} more` : ''}` : ''}.${outside ? ` ${outside} outside the allowed sites, not handed off.` : ''} ${PROVIDER_NOTE}${how}`;
    const info = {
      tool: WEB_SEARCH_STEP,
      soql: summary.slice(0, 2000),
      url: (!withheld && inside[0]?.url) || WEB_SEARCH_DOCS,
      provider: 'anthropic',
      ...(withheld ? { withheld: true } : { query: s.query, results: inside.slice(0, 20) }),
    };
    await trace
      .record(info, async () => {
        if (s.error) throw new Error(ERRORS[s.error] || `search error: ${s.error}`);
        return { result: null, rows: results.length };
      })
      .catch(() => {});
  }
  return usable;
}

/**
 * Hand-off records for the web pages behind an answer: the results the
 * answer cites, or every result when it cites none. A web page is not a
 * record, so each is kind 'web'.
 */
export function handOffWebPages(resources, results, cited) {
  const byUrl = new Map(results.map((r) => [r.url, r]));
  const citedUrls = [...new Set(cited.map((c) => c.url))].filter((u) => byUrl.has(u));
  const pages = citedUrls.length ? citedUrls.map((u) => byUrl.get(u)) : [...byUrl.values()];
  for (const p of pages) resources.addRecord({ kind: 'web', title: p.title, url: p.url, ...(p.page_age ? { page_age: p.page_age } : {}) });
}
