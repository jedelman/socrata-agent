// "What's on my block?" and the first half of "who decided that?".
// Driven entirely by the city profile, so another city can plug in its own
// address dataset and parcel-keyed datasets without code changes.

import { normalizeAddress } from './adapters/iqm2.js';
import { soqlString } from './socrata.js';

const DIRS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST']);
const SUFFIXES = new Set([
  'STREET', 'AVENUE', 'BOULEVARD', 'ROAD', 'DRIVE', 'LANE', 'COURT', 'CIRCLE', 'PLACE', 'WAY', 'TERRACE',
  'PARKWAY', 'HIGHWAY', 'CRESCENT', 'SQUARE', 'TRAIL', 'ARCH', 'LANDING', 'POINT', 'QUAY', 'RUN', 'WALK',
]);

// "160 W. Virginia Beach Blvd" -> { num: '160', street: 'VIRGINIA BEACH' }
export function addressKey(addr) {
  // Drop ", Norfolk, VA 23510" and the like; keep only the street part.
  let words = normalizeAddress(String(addr).split(',')[0]).split(' ');
  while (words.length > 2 && /^(\d{5}(-\d{4})?|VA|NORFOLK)$/.test(words.at(-1))) words = words.slice(0, -1);
  const i = words.findIndex((w) => /^\d+[A-Z]?$/.test(w));
  if (i < 0) return { num: null, street: words.filter((w) => !DIRS.has(w) && !SUFFIXES.has(w)).join(' ') };
  const rest = words.slice(i + 1).filter((w) => !DIRS.has(w) && !SUFFIXES.has(w));
  return { num: words[i], street: rest.join(' ') };
}

function pick(row, fields) {
  const out = {};
  for (const f of fields) if (row[f] != null && row[f] !== '') out[f] = row[f];
  return out;
}

export async function lookupAddress(ctx, input) {
  const { city, socrata, resources } = ctx;
  const cfg = city.address;
  const key = addressKey(input);
  if (!key.num) return { error: 'I need a house number and street, like "111 Pennsylvania Ave".' };
  const longest = key.street.split(' ').sort((a, b) => b.length - a.length)[0] || '';
  const rows = await socrata.query(
    cfg.dataset,
    `SELECT * WHERE ${cfg.fields.number} = ${soqlString(key.num)} AND upper(${cfg.fields.street}) like ${soqlString(`%${longest}%`)} LIMIT 25`,
    { tool: 'look up address', name: cfg.name }
  );
  const exact = rows.filter((r) => addressKey(r[cfg.fields.full]).street === key.street);
  const chosen = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
  if (!chosen) {
    return {
      searched: input,
      match: null,
      candidates: (exact.length ? exact : rows).slice(0, 10).map((r) => r[cfg.fields.full]),
      note: rows.length ? 'More than one address matched; ask which one.' : 'I found no address with that number on that street.',
    };
  }
  const contacts = [];
  for (const c of cfg.contacts) {
    const name = chosen[c.name] ? `${c.namePrefix || ''}${chosen[c.name]}` : null;
    const contact = {
      role: c.group && chosen[c.group] ? `${c.role}, ${chosen[c.group]}` : c.district && chosen[c.district] ? `${c.role} ${chosen[c.district]}` : c.role,
      name,
      email: c.email ? chosen[c.email] || null : null,
      phone: c.phone ? chosen[c.phone] || null : null,
      url: c.url ? chosen[c.url] || null : null,
      note: c.note ? c.note.map((f) => chosen[f]).filter(Boolean).join(', ') || null : null,
      source: `${cfg.name} (${cfg.dataset})`,
    };
    if (contact.name || contact.email || contact.phone) {
      contacts.push(contact);
      resources.addContact(contact);
    }
  }
  return {
    searched: input,
    match: {
      address: chosen[cfg.fields.full],
      parcel_id: chosen[cfg.fields.parcel],
      street: chosen[cfg.fields.street],
      street_name: chosen[cfg.fields.streetName],
      number: chosen[cfg.fields.number],
      ward: chosen[cfg.fields.ward],
      hundred_block: `${Math.floor(Number(chosen[cfg.fields.number]) / 100) * 100} block of ${chosen[cfg.fields.street]}`,
      ...(cfg.fields.lat ? { lat: Number(chosen[cfg.fields.lat]), lon: Number(chosen[cfg.fields.lon]) } : {}),
      ...(cfg.fields.tract ? { census_tract: chosen[cfg.fields.tract] } : {}),
      facts: pick(chosen, cfg.facts),
    },
    contacts,
  };
}

export function matchLegislation(index, address) {
  if (!index?.items) return { exact: [], same_block: [] };
  const key = addressKey(address);
  const hundred = Math.floor(Number(key.num) / 100);
  const exact = [];
  const block = [];
  for (const it of index.items) {
    let hit = null;
    for (const a of it.addresses) {
      const k = addressKey(a);
      if (k.street !== key.street) continue;
      if (k.num === key.num) {
        hit = 'exact';
        break;
      }
      if (Math.floor(Number(k.num) / 100) === hundred) hit = 'block';
    }
    if (hit === 'exact') exact.push(it);
    else if (hit === 'block') block.push(it);
  }
  const shape = (it) => ({ id: it.id, title: it.text, meetings: it.meetings.slice(0, 4) });
  return { exact: exact.slice(0, 15).map(shape), same_block: block.slice(0, 15).map(shape) };
}

export async function blockReport(ctx, input) {
  const { city, socrata, resources, indexes, iqm2 } = ctx;
  const found = await lookupAddress(ctx, input);
  if (!found.match) return found;
  const a = found.match;
  const LIMIT = 10;

  const parcel = (city.parcelDatasets || []).map(async (d) => {
    const where = `${d.parcel} = ${soqlString(a.parcel_id)}`;
    const rows = await socrata.query(d.id, `SELECT ${d.fields.join(', ')} WHERE ${where} ORDER BY ${d.date} DESC LIMIT ${LIMIT}`, {
      tool: 'block report',
      name: d.name,
    });
    let total = rows.length;
    if (rows.length === LIMIT) {
      const c = await socrata.query(d.id, `SELECT count(*) AS n WHERE ${where} LIMIT 1`, { tool: 'block report (count)', name: d.name });
      total = Number(c[0]?.n ?? rows.length);
    }
    return { dataset: d.id, name: d.name, matched_on: 'this parcel', total, showing: rows.length, rows };
  });

  const street = (city.streetDatasets || []).map(async (d) => {
    const where = d.where({ ...a });
    const rows = await socrata.query(d.id, `SELECT ${d.fields.join(', ')} WHERE ${where} ORDER BY ${d.date} DESC LIMIT ${LIMIT}`, {
      tool: 'block report',
      name: d.name,
    });
    const out = { dataset: d.id, name: d.name, matched_on: d.grain, recent: rows };
    if (d.openWhere) {
      // Open items are fetched on their own: an old open item can sit far
      // below the most recent rows and would otherwise never be seen.
      const open = await socrata.query(d.id, `SELECT ${d.fields.join(', ')} WHERE (${where}) AND (${d.openWhere}) ORDER BY ${d.date} LIMIT ${LIMIT}`, {
        tool: 'block report (open)',
        name: d.name,
      });
      out.open = open;
      out.open_means = d.openNote;
      if (open.length === LIMIT) {
        const c = await socrata.query(d.id, `SELECT count(*) AS n WHERE (${where}) AND (${d.openWhere}) LIMIT 1`, {
          tool: 'block report (open count)',
          name: d.name,
        });
        out.open_total = Number(c[0]?.n ?? open.length);
      } else out.open_total = open.length;
    }
    return out;
  });

  const settled = await Promise.allSettled([...parcel, ...street]);
  const datasets = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { dataset: [...(city.parcelDatasets || []), ...(city.streetDatasets || [])][i].id, error: String(s.reason?.message || s.reason) }
  );

  let legislation = null;
  if (city.meetings && indexes?.[city.meetings.index]) {
    const idx = indexes[city.meetings.index];
    legislation = { ...matchLegislation(idx, a.address), index_built: idx.built, index_source: idx.source };
    for (const it of [...legislation.exact, ...legislation.same_block]) {
      resources.addRecord({ kind: 'legislation', title: it.title.slice(0, 160), url: iqm2.legiUrl(it.id) });
    }
    legislation.note =
      'Matched by the street address written in each agenda title. Items that name no address (citywide ordinances, budgets) are not matched. Use get_legislation for status, department and votes.';
  }

  return { address: a, contacts: found.contacts, datasets, legislation };
}

export function searchLegislation(index, text, limit = 15) {
  if (!index?.items) return [];
  const words = normalizeAddress(text).split(' ').filter((w) => w.length > 2);
  if (!words.length) return [];
  return index.items
    .map((it) => {
      const hay = it.text.toUpperCase();
      return { it, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score === words.length)
    .slice(0, limit)
    .map(({ it }) => ({ id: it.id, title: it.text, meetings: it.meetings.slice(0, 4) }));
}
