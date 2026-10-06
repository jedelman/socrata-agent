# Adding a city

Any Socrata city already works in generic mode (`--city data.example.gov`):
search the catalog, describe a dataset, query it, download it. The block report
and "who decided it" need a city profile in `src/cities/`. Norfolk's profile,
`src/cities/norfolk.js`, is the worked example.

A profile is data, not code. Verify every dataset id and field name against the
live portal before you commit it, and record the date you checked.

## 1. Basics

```js
export default {
  id: 'yourcity',
  name: 'Your City, ST',
  domain: 'data.yourcity.gov',   // where /resource/{id}.json answers; not always the portal's host
  portal: 'https://data.yourcity.gov',
  excluded: [{ id: 'abcd-1234', reason: 'Why this dataset is off limits.' }],
  excludedNamePatterns: [/warrant/i, /arrest/i, /sex offender/i, /inmate/i, /booking/i],
  contacts: [/* citywide contacts, each verified on the city's own site */],
  links: [/* portal, meeting portal, SoQL docs */],
};
```

Seattle is a reminder that the API domain can differ from the portal: its
portal is `data.seattle.gov`, but the API is at `cos-data.seattle.gov`.

Register the profile in `src/cities/index.js`.

## 2. Address → parcel (`address`)

You need one dataset that turns a street address into a parcel id. Ideally it
also carries districts and representatives. Map its fields:

```js
address: {
  dataset: 'xxxx-xxxx',
  name: 'Address Points',
  fields: { full, number, street, streetName, parcel, ward },
  facts: ['council_district', 'trash_day', ...],        // returned as-is
  contacts: [{ role: 'City Council', name: 'council_member', url: 'council_url', district: 'council_district' }],
},
```

If no single dataset carries the representatives, leave `contacts` empty and
add them to the citywide `contacts` list instead.

## 3. Parcel-keyed datasets (`parcelDatasets`)

Each dataset that carries the same parcel id:

```js
{ id, name, parcel: 'pin', date: 'issued_date', fields: [...] }
```

`date` sets the order (newest first). Keep `fields` to the columns a resident
cares about.

## 4. Street-keyed datasets (`streetDatasets`)

For data with no parcel id, write a `where` function that receives the matched
address (`street`, `street_name`, `number`, `ward`, ...) and returns a SoQL
condition. Say in `grain` what the match means ("same hundred block"). If the
dataset has a status, add `openWhere` and `openNote` so open items are fetched
on their own.

## 5. Meetings (`meetings`)

Norfolk uses Granicus iqm2, handled by `src/adapters/iqm2.js` and indexed by
`scripts/build-norfolk-legislation.js`. Many cities use Legistar instead, which
has a public API (`https://webapi.legistar.com/v1/{client}/matters`). Seattle's
answers at `webapi.legistar.com/v1/seattle`; Norfolk's does not. A Legistar
adapter is the most useful next contribution.

## 6. Test it

```bash
node bin/socrata-agent.js tool lookup_address '{"address":"..."}' --city yourcity
node bin/socrata-agent.js tool block_report '{"address":"..."}' --city yourcity
```

Read every query in the trace and click a few of the `url`s. A wrong field name
fails quietly: the query returns zero rows and the agent truthfully reports that
it found nothing. The first real bug in Norfolk's profile showed up exactly this
way, as `street = 'undefined'` in the trace.
