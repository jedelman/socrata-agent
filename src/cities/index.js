// City profiles. A profile with only `domain` and `portal` gets the generic
// tools (search, describe, query, download links). Adding `address`,
// `parcelDatasets`, `streetDatasets` and `meetings` unlocks the block report
// and "who decided that". See docs/adding-a-city.md.

import norfolk from './norfolk.js';

// Dataset names that mean records about people, in any city.
const GENERIC_EXCLUDE = [/warrant/i, /arrest/i, /sex offender/i, /inmate/i, /booking/i, /delinquent/i, /\btow(ed|ing)\b/i, /parking citation/i, /use of force/i, /relocated vehicle/i, /impound/i, /employee.*(names|salar)/i];

// Freeze a profile all the way down, so nothing that holds it (a plugin, a
// deployment config) can loosen its policy for later requests.
export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const cities = {
  norfolk,
  seattle: {
    id: 'seattle',
    name: 'Seattle, WA',
    // Seattle's portal is data.seattle.gov but its Socrata API lives here.
    domain: 'cos-data.seattle.gov',
    portal: 'https://data.seattle.gov',
    excludedNamePatterns: GENERIC_EXCLUDE,
    links: [
      { title: 'Seattle open data portal', url: 'https://data.seattle.gov' },
      { title: 'How to write SoQL queries', url: 'https://dev.socrata.com/docs/queries/' },
    ],
  },
  chicago: {
    id: 'chicago',
    name: 'Chicago, IL',
    domain: 'data.cityofchicago.org',
    portal: 'https://data.cityofchicago.org',
    excludedNamePatterns: GENERIC_EXCLUDE,
    excluded: [
      // Checked live 2026-11-02: columns include plate, state, make and color.
      { id: '5k2z-suxx', reason: 'Relocated Vehicles is excluded: it is searchable by license plate.' },
    ],
    links: [
      { title: 'Chicago open data portal', url: 'https://data.cityofchicago.org' },
      { title: 'How to write SoQL queries', url: 'https://dev.socrata.com/docs/queries/' },
    ],
  },
};

for (const c of Object.values(cities)) deepFreeze(c);

// "https://Data.Norfolk.gov/" and "data.norfolk.gov." are the same host.
function hostOf(key) {
  return String(key).trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '');
}

// A known city by its id or by any of its hosts, so a domain spelling can't
// load a generic profile without that city's policy. Any other Socrata domain
// works in generic mode: `--city data.example.gov`.
export function getCity(key) {
  if (!key) return cities.norfolk;
  const k = String(key).trim().toLowerCase();
  if (Object.hasOwn(cities, k)) return cities[k];
  const host = hostOf(key);
  const known = Object.values(cities).find((c) => c.domain === host || hostOf(c.portal) === host);
  if (known) return known;
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) {
    return deepFreeze({
      id: host,
      name: host,
      domain: host,
      portal: `https://${host}`,
      excludedNamePatterns: GENERIC_EXCLUDE,
      links: [{ title: 'How to write SoQL queries', url: 'https://dev.socrata.com/docs/queries/' }],
    });
  }
  throw new Error(`Unknown city "${key}". Use one of ${Object.keys(cities).join(', ')}, or a Socrata domain.`);
}
