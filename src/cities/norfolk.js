// Norfolk, VA. Every dataset id and field name below was checked against
// data.norfolk.gov on 2026-10-06. Contacts are either read live from the
// Address Information dataset or verified on the city's own pages.

export default {
  id: 'norfolk',
  name: 'Norfolk, VA',
  domain: 'data.norfolk.gov',
  portal: 'https://data.norfolk.gov',

  // Name-searchable records about people. The agent never queries these.
  excluded: [
    { id: 'cab7-wvn5', reason: 'Police Active Warrants is excluded: it is searchable by personal name.' },
    { id: 'uxgi-fkzu', reason: 'Police Arrest Reports is excluded: it is searchable by personal name.' },
  ],
  excludedNamePatterns: [/warrant/i, /arrest/i, /sex offender/i, /inmate/i, /booking/i],

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
      fields: ['permit_number', 'type', 'permit_kind', 'street_number', 'street', 'contractor', 'start_date', 'end_date'],
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
