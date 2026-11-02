// Norfolk, VA. Every dataset id and field name below was checked against
// data.norfolk.gov on 2026-10-06. Contacts are either read live from the
// Address Information dataset or verified on the city's own pages.

// Owner and deed fields in every year's assessment roll.
const OWNER_FIELDS = ['owner', 'grantor', 'grantee', 'legal_description', 'document_number'];

export default {
  id: 'norfolk',
  name: 'Norfolk, VA',
  domain: 'data.norfolk.gov',
  portal: 'https://data.norfolk.gov',

  // Records about people that no level of Siren ever queries. The 2026-11-02
  // additions came from the capability map (docs/capabilities-norfolk.md),
  // each checked live that day.
  excluded: [
    { id: 'cab7-wvn5', reason: 'Police Active Warrants is excluded: it is searchable by personal name.' },
    { id: 'uxgi-fkzu', reason: 'Police Arrest Reports is excluded: it is searchable by personal name.' },
    { id: '7qie-z5gv', reason: 'Delinquent Property Taxes is excluded: it is searchable by owner name.' },
    { id: '4dwc-v3t8', reason: 'Towing is excluded: it is searchable by license plate and VIN.' },
    { id: 'ei2q-6g8n', reason: 'Parking Citations is excluded: it is searchable by license plate.' },
    { id: 'jf3j-u4s7', reason: 'Fire-Rescue Inspections is excluded: it is no longer updated and lists sensitive occupancies by unit.' },
    { id: 'fcqe-uvnb', reason: 'Police Use of Force and Citizen Complaints is excluded: its per-incident records carry demographics that can identify people.' },
    { id: '393b-ph9i', reason: "SWaM Certified Businesses is excluded: it ties owners' ethnicity and mailing addresses, often homes, to sole proprietors." },
    { id: 'p5hy-7rkp', reason: 'Norfolk Cares Center (2020) is excluded: its free-text issue descriptions can name and locate residents.' },
  ],
  excludedNamePatterns: [/warrant/i, /arrest/i, /sex offender/i, /inmate/i, /booking/i, /delinquent/i, /\btow(ed|ing)\b/i, /parking citation/i, /use of force/i],

  // Only reviewed plugins and Siren's own code may read these, with the
  // aggregation and suppression done inside the query. The open-ended tools
  // refuse them, and the hand-off never offers their full-table CSV.
  restricted: [
    { id: 'suf7-r643', reason: 'FEMA NFIP Claims is available only through water_on_my_block, which reports claims by census tract with small counts suppressed.' },
    { id: 'r7bn-2egr', reason: 'Police Incident Reports is not available to open-ended queries: block-, date- and hour-level rows can point to victims.' },
    { id: 'wqxq-hhe6', reason: 'Micromobility trips are not available to open-ended queries: trip-level origins and destinations can re-identify riders.' },
    { id: 'nbyu-xjez', reason: 'MyNorfolk 311 requests are not available to open-ended queries: some request types point at a single household.' },
    { id: '4fsk-z8s8', reason: 'Employee Salaries is not available to open-ended queries.' },
    { id: 'vv96-9m5c', reason: 'Employee Demographics is not available to open-ended queries: small groups can identify employees.' },
    { id: 'dpi6-sct5', reason: "Business Licenses is not available to open-ended queries: it lists sole proprietors' names and home mailing addresses." },
    { id: 'vfm4-5wv6', reason: "Animal shelter records are not available to open-ended queries: intake reasons can reveal an owner's arrest, eviction, illness or death." },
    { id: '8bq6-fd8n', reason: 'Foster Care data is not available to open-ended queries: small cells can identify a child.' },
    { id: 'vj2f-2an3', reason: 'Adoptions data is not available to open-ended queries: small cells can identify a child.' },
  ],

  // Columns that identify private people. Open-ended queries and plugins
  // can't select, filter, group, sort or full-text SEARCH by them, and
  // SELECT * leaves them out. Siren's own code (contacts, the sponge-screen
  // builder's public-owner check) still reads them. Field names checked live
  // on 2026-11-02.
  deniedColumns: {
    'qva7-tzrf': OWNER_FIELDS,
    'm5ya-5grb': OWNER_FIELDS,
    'g7sg-tivf': OWNER_FIELDS,
    '9gmp-9x4c': OWNER_FIELDS,
    'yvpm-8aid': OWNER_FIELDS,
    '7tu9-2ytx': OWNER_FIELDS,
    '8bfx-a5g8': OWNER_FIELDS,
    'pdf2-gh9c': OWNER_FIELDS,
    'th3n-jr9u': OWNER_FIELDS,
    '7mjv-xiqs': ['contact_name', 'contact_number'],
    'mi4h-8pn3': ['applicant_name', 'contractor'],
    'dpi6-sct5': ['primary_owner', 'mailing_address'],
    'ere7-kake': ['civic_league_president', 'civic_league_email'],
    'w6gf-9gws': ['document_number'],
    'bguc-8iwd': ['additional_comments'],
    'mrv3-rcpc': ['comments', 'user', 'user_modified'],
    'iz5u-2wb3': ['image'],
    '5qpt-tdve': ['entered_by_user'],
    'fq4f-ag5s': ['sponsor', 'photographer', 'notes'],
    // Occupancy use groups reveal group homes and assisted living at an address.
    'fahm-yuh4': ['use_group'],
    'bnrb-u445': ['permit_use_group', 'permit_use_group_info', 'permit_description'],
  },

  // Rows that point at one household's circumstances. No level sees them.
  suppressedRows: {
    // Complaints that someone is living in a shed, RV or commercial building, or
    // that a home is overcrowded (subtype values checked live 2026-11-02).
    'm9m3-wk2s': "subtype like 'Residing%' OR subtype = 'Rooming House/Overcrowding'",
    // Gas and fire red tags mark one household's emergency.
    '7fk7-nqxm': "subtype in ('Virginia Natural Gas Red Tag', 'Fire Department Red Tag')",
  },

  // Address in → parcel id, districts, representatives, civic league.
  address: {
    dataset: 'ere7-kake',
    name: 'Address Information',
    fields: {
      full: 'full_address',
      number: 'house_number',
      street: 'full_street_name',
      streetName: 'street_name',
      parcel: 'gpin',
      ward: 'ward_district',
      lat: 'parcel_centroid_latitude',
      lon: 'parcel_centroid_longitude',
      tract: 'census_tract_number',
    },
    // Facts about the place, returned as-is.
    facts: [
      'civic_league', 'ward_district', 'super_ward_district', 'planning_district_name', 'precinct_name',
      'polling_place', 'polling_address', 'trash_day', 'recycling_day', 'recycling_week', 'street_sweeping',
      'evacuation_zone', 'elementary_school_name', 'middle_school_name', 'high_school_name', 'nearest_park',
      'nearest_library', 'police_precincts', 'opportunity_zone', 'enterprise_zone',
    ],
    // Contacts read from the same row. Field names map to contact parts.
    contacts: [
      { role: 'City Council, ward', name: 'ward_representative', url: 'ward_website', district: 'ward_district' },
      { role: 'City Council, superward', name: 'super_ward_representative', url: 'super_ward_website', district: 'super_ward_district' },
      {
        role: 'Civic league president',
        name: 'civic_league_president',
        email: 'civic_league_email',
        group: 'civic_league',
        note: ['civic_league_meeting_frequency', 'civic_league_meeting_time', 'civic_league_meeting_location'],
      },
      { role: 'Virginia House', name: 'virginia_house_district_name', email: 'virginia_house_district_email', phone: 'virginia_house_district_phone', url: 'virginia_house_district_web', namePrefix: 'District ' },
      { role: 'Virginia Senate', name: 'senate_name', email: 'senate_email', phone: 'senate_phone', url: 'senate_website' },
      { role: 'U.S. House', name: 'u_s_house_representative', phone: 'u_s_house_representative_1', url: 'u_s_house_representative_url' },
    ],
  },

  // Datasets keyed by parcel id (GPIN): the address itself.
  parcelDatasets: [
    { id: 'fahm-yuh4', name: 'Permits', parcel: 'gpin', date: 'application_date',
      fields: ['permit_number', 'type', 'work_type', 'status', 'application_date', 'issue_date', 'finaled_date', 'project_cost'] },
    { id: 'dhk3-hr4y', name: 'Plan Reviews', parcel: 'gpin', date: 'review_number',
      fields: ['review_number', 'permit_or_land_use_application', 'type', 'status', 'due_date', 'completed_date'] },
    { id: 'm9m3-wk2s', name: 'Complaints', parcel: 'gpin', date: 'created_date',
      fields: ['complaint_id', 'type', 'subtype', 'status', 'created_date', 'closed_date', 'department_responsible'] },
    { id: 'agip-sqwc', name: 'Violations', parcel: 'gpin', date: 'created_date',
      fields: ['violation_id', 'ordinance', 'status', 'department', 'created_date', 'corrected_date'] },
    { id: 'mxtv-99gh', name: 'Neighborhood Quality Code Enforcement Cases', parcel: 'gpin', date: 'complaint_created_date',
      fields: ['complaint_type', 'complaint_subtype', 'complaint_status', 'violation_ordinance', 'violation_status', 'complaint_created_date'] },
    { id: 'ihzr-5x5n', name: 'Inspections', parcel: 'gpin', date: 'requested_date',
      fields: ['inspection_number', 'type', 'status', 'permit_number', 'complaint_number', 'requested_date', 'completed_date'] },
  ],

  // Datasets with no parcel id: matched by street (and ward, or by hundred block).
  streetDatasets: [
    {
      id: 'qzfe-wj25',
      name: 'Work Orders',
      grain: 'street within the same ward (this dataset has no house numbers)',
      where: (a) => `street = ${q(a.street_name)} AND ward = ${Number(a.ward)}`,
      openWhere: 'status_code < 800 OR status_code = 941',
      openNote: 'Open means status codes below 800 (New, On-Hold, On-Going, Scheduled, Wait for Reschedule) or 941 (WO On Hold).',
      date: 'created_datetime',
      fields: ['work_order_number', 'area', 'department', 'problem_description', 'primary_task_description', 'status_description', 'created_datetime', 'end_date'],
    },
    {
      id: 'mi4h-8pn3',
      name: 'Permits - Right of Way',
      grain: 'same hundred block of the street',
      where: (a) => {
        const lo = Math.floor(Number(a.number) / 100) * 100;
        return `upper(street) = ${q(a.street)} AND street_number >= ${lo} AND street_number < ${lo + 100}`;
      },
      date: 'start_date',
      // No applicant or contractor: about half are private individuals
      // (driveways, dumpsters, temporary parking). Checked 2026-11-02.
      fields: ['permit_number', 'type', 'permit_kind', 'street_number', 'street', 'start_date', 'end_date'],
    },
  ],

  meetings: {
    kind: 'iqm2',
    iqm2: 'https://norfolkcityva.iqm2.com',
    noticesDataset: 'dszu-h9cf',
    index: 'norfolk-legislation',
  },

  // Verified 2026-10-06: Norfolk Cares on norfolk.gov/NorfolkCares; the Clerk's
  // number and email from the Aug 25, 2026 Council minutes.
  contacts: [
    { role: 'City services (Norfolk Cares)', phone: '(757) 664-6510', url: 'https://www.mynorfolk.org', note: 'weekdays 8 a.m.–4 p.m.; MyNorfolk app or site after hours' },
    { role: 'City Clerk (to speak at Council)', phone: '(757) 664-4253', email: 'ccouncil@norfolk.gov', note: 'register by 3 p.m. the day of the meeting' },
  ],
  links: [
    { title: 'Norfolk open data portal', url: 'https://data.norfolk.gov' },
    { title: 'Norfolk meetings, agendas and legislation (iqm2)', url: 'https://norfolkcityva.iqm2.com/Citizens/Default.aspx' },
    { title: 'How to write SoQL queries', url: 'https://dev.socrata.com/docs/queries/' },
  ],
};

function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
