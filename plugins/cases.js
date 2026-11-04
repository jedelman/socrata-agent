// Case files: research done once, checked against its sources, and served to
// every question. Each file in data/cases/ holds findings with a source URL
// and an exact quote; scripts/verify-cases.js re-fetches every source and
// fails if a quote is missing. A plugin attaches a case to its answer with
// `theRecord`, which also puts every source in the trace and the hand-off.

const REPO = 'https://github.com/jedelman/socrata-agent/blob/main';

export function theRecord(ctx, doc) {
  const sources = new Map();
  const shape = (f) => {
    sources.set(f.source.url, f.source.title);
    return {
      claim: f.claim,
      source: f.source.title,
      url: f.source.url,
      found_by: f.found_by,
      ...(f.checked ? { checked: f.checked } : {}),
      // A snapshot that holds the quote, so the reader can check it even if the live page changes.
      ...(f.source.archive?.url ? { archived: f.source.archive.url } : {}),
      ...(f.checked_via === 'archive'
        ? { note: `Verified against the archived copy from ${f.source.archive?.timestamp?.slice(0, 8).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3') || 'an earlier date'}: the live page has changed or is unreachable. Say so if you use it.` }
        : {}),
    };
  };
  const verified = doc.findings.filter((f) => !f.unverified && f.checked);
  const by = (stance) => verified.filter((f) => f.stance === stance).map(shape);
  const byId = Object.fromEntries(doc.findings.map((f) => [f.id, f]));
  ctx.cite({
    tool: `read the verified case file: ${doc.title}`,
    url: `${REPO}/data/cases/${doc.id}.json`,
    rows: doc.findings.length,
    note: `${verified.length} findings with their quotes checked against the source; ${doc.findings.length - verified.length} marked unverified`,
  });
  const record = {
    question: doc.title,
    steward: doc.steward,
    license: doc.license === 'CC-BY-4.0' ? 'CC BY 4.0: reuse with credit to whoever found each finding' : doc.license,
    summary: doc.summary,
    confirms: by('confirms'),
    weakens: by('weakens'),
    context: by('context'),
    who_decides: by('who_decides'),
    rules: by('rules'),
    not_yet_verified: doc.findings.filter((f) => f.unverified || !f.checked).map((f) => f.claim),
    what_would_help: doc.what_would_help.map((h) => ({ text: h.text, ...(byId[h.finding] ? { based_on: byId[h.finding].source.title } : {}) })),
    records_to_request: doc.records_to_request,
    how_to_use:
      'Each finding was checked against its source on the date shown, and names who found it. Name the source when you use a finding. Give what weakens the case alongside what confirms it. Say "not yet verified" for anything in not_yet_verified. The records to request are drafts for the person to send under the Virginia FOIA; Siren never sends them.',
  };
  for (const [url, title] of sources) ctx.resources.addRecord({ title, url, kind: 'source' });
  return record;
}

/**
 * A case file as a W3C Web Annotation collection (https://www.w3.org/TR/annotation-model/),
 * in JSON-LD, so annotation tools and other agents can read the findings
 * without knowing our format. Each verified finding becomes an annotation:
 * its claim is the body, its quote a TextQuoteSelector on the source, an
 * archived snapshot a TimeState (Memento), the bytes we read a DASL CID, and
 * who found it the creator. Unverified findings are left out.
 */
export function toAnnotations(doc, base) {
  const id = `${base}/api/cases/${doc.id}`;
  const motivation = { confirms: 'assessing', weakens: 'assessing', rules: 'describing', context: 'describing', who_decides: 'describing' };
  const items = doc.findings
    .filter((f) => !f.unverified && f.checked && f.quote)
    .map((f) => {
      const selector = f.selector || { type: 'TextQuoteSelector', exact: f.quote };
      const target = { source: f.source.url, selector };
      if (f.source.archive?.url) {
        target.state = { type: 'TimeState', cached: f.source.archive.url, sourceDate: `${f.source.archive.timestamp.slice(0, 4)}-${f.source.archive.timestamp.slice(4, 6)}-${f.source.archive.timestamp.slice(6, 8)}T${f.source.archive.timestamp.slice(8, 10)}:${f.source.archive.timestamp.slice(10, 12)}:${f.source.archive.timestamp.slice(12, 14)}Z` };
      }
      return {
        id: `${id}#${f.id}`,
        type: 'Annotation',
        motivation: motivation[f.stance] || 'describing',
        body: [
          { type: 'TextualBody', value: f.claim, format: 'text/plain', language: 'en', purpose: motivation[f.stance] || 'describing' },
          { type: 'TextualBody', value: f.stance, purpose: 'tagging' },
        ],
        target,
        creator: { type: 'Agent', name: f.found_by || 'unknown' },
        created: f.checked,
        rights: 'https://creativecommons.org/licenses/by/4.0/',
        ...(f.evidence?.cid ? { 'prov:wasDerivedFrom': { id: `${f.source.url}`, evidenceCid: f.evidence.cid, evidenceBytes: f.evidence.bytes, readOn: f.evidence.read } } : {}),
      };
    });
  return {
    '@context': [
      'http://www.w3.org/ns/anno.jsonld',
      { prov: 'http://www.w3.org/ns/prov#', evidenceCid: 'https://dasl.ing/cid.html#cid', evidenceBytes: 'prov:value', readOn: 'prov:generatedAtTime' },
    ],
    id,
    type: 'AnnotationCollection',
    label: doc.title,
    total: items.length,
    first: { type: 'AnnotationPage', id: `${id}?page=1`, items },
  };
}
