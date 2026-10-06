// City profiles. A profile with only `domain` and `portal` gets the generic
// tools (search, describe, query, download links). Adding `address`,
// `parcelDatasets`, `streetDatasets` and `meetings` unlocks the block report
// and "who decided that". See docs/adding-a-city.md.

import norfolk from './norfolk.js';

const GENERIC_EXCLUDE = [/warrant/i, /arrest/i, /sex offender/i, /inmate/i, /booking/i];

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
    links: [
      { title: 'Chicago open data portal', url: 'https://data.cityofchicago.org' },
      { title: 'How to write SoQL queries', url: 'https://dev.socrata.com/docs/queries/' },
    ],
  },
};

// Any other Socrata domain works in generic mode: `--city data.example.gov`.
export function getCity(key) {
  if (!key) return cities.norfolk;
  if (cities[key]) return cities[key];
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(key)) {
    return {
      id: key,
      name: key,
      domain: key,
      portal: `https://${key}`,
      excludedNamePatterns: GENERIC_EXCLUDE,
      links: [{ title: 'How to write SoQL queries', url: 'https://dev.socrata.com/docs/queries/' }],
    };
  }
  throw new Error(`Unknown city "${key}". Use one of ${Object.keys(cities).join(', ')}, or a Socrata domain.`);
}
