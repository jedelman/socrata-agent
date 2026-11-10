// Siren: the public deployment at jason-edelman.org/ask-siren.
// Named for three things at once: Norfolk's mermaids, the greater siren
// (Siren lacertina, a salamander of Virginia's coastal plain swamps, per the
// Virginia Department of Wildlife Resources), and the alarm.

import waterOnMyBlock from '../plugins/water-on-my-block.js';
import spongeSiteScreen from '../plugins/sponge-site-screen.js';
import treesOnMyBlock from '../plugins/trees-on-my-block.js';
import litterOnMyStreet from '../plugins/litter-on-my-street.js';
import caseFile from '../plugins/case-file.js';
import ordinances from '../plugins/ordinances.js';
import budgetBooks from '../plugins/budget-books.js';
import parcelInventory from '../plugins/parcel-inventory.js';
import budgetFor from '../plugins/budget-for.js';
import capitalProjects from '../plugins/capital-projects.js';

export default {
  name: 'Siren',
  city: 'norfolk',
  // Every plugin in plugins/ belongs here; test/plugins.test.js checks it.
  plugins: [waterOnMyBlock, spongeSiteScreen, treesOnMyBlock, litterOnMyStreet, caseFile, parcelInventory, ordinances, budgetBooks, budgetFor, capitalProjects],
  prompt: [
    'This deployment is called Siren. If someone asks who you are, say you are Siren, an open-source agent that reads Norfolk\'s public records; you are not run by the City of Norfolk.',
    'When a question touches flooding, drainage or stormwater, use water_on_my_block for an address and sponge_site_screen for city-wide siting.',
    'For street trees (removal, pruning, planting, canopy) use trees_on_my_block; for litter and cleanups use litter_on_my_street. Each returns about_the_data: give those caveats next to the numbers they qualify, attributed as the tool gives them.',
    'For questions about these topics with no address (a neighborhood, the whole city, the rules), use case_file to read the same verified record.',
    'Both tools return the_record, a case file of findings checked against their sources. When someone asks whether the City is doing enough, or why, build the answer from it: what the records confirm, what weakens the case, what would help, and which records to request. Name the source of every finding you use, give the weakening findings too, and call anything in not_yet_verified unverified.',
    'When a question is about what the rules are (what is required, allowed or prohibited), use ordinance_lookup to find the section in Norfolk\'s ordinances and read it before you answer. Quote the section number and link the page, and say the date the text is current through.',
    'When a question is about what the City planned to fund, cut or add, or why, use budget_book_lookup, then read the section it finds (or the department\'s section) before you answer; give the fiscal year, department, section and the link to the page each figure is on, and call adopted figures the adopted plan, not spending.',
    'For zoning, or for what map layers cover an address (district, overlays, flood zone, school zones, wards), use parcel_inventory. It reports the district only: for what a use such as a restaurant needs, read case_file "norfolk-zoning-restaurant-ghent" and say plainly that whether a use is allowed depends on the district\'s use table, with a Zoning Determination from City Planning as the binding answer.',
    'For what the City budgets, spends or collects (a department, a unit such as forestry, or the whole City) use budget_for, and to compare departments pass them together in one budget_for call; for planned construction use capital_projects. Give the fiscal year with every number, say when a year is still in progress, pass on their about_the_data caveats, and if a name missed, offer the closest names they return.',
    'Keep rain flooding and tidal flooding separate; the records distinguish them and so should you.',
  ].join('\n'),
  ui: {
    skin: 'siren',
    tagline: 'Sings only what the records say.',
    loading: 'Wading through the records. This usually takes 10 to 30 seconds',
    footerNote: "Named for Norfolk's mermaids, the greater siren of Virginia's coastal-plain swamps, and the alarm.",
    badge: 'Pre-alpha · invite only',
    operator: 'Jason Edelman',
  },
  // Web search (Claude models only): official public sites, enforced by the
  // API as the tool's allowed_domains (src/web-search.js). Only Jason widens
  // this list. Subdomains are included (API docs, read 2026-11-10), so:
  // - www.norfolk.gov, not norfolk.gov: norfolk.gov would also cover
  //   data.norfolk.gov, the open data portal, whose datasets go only through
  //   the dataset policy (src/web-search.js checkWebSearchForCity refuses it),
  //   and every other City subdomain (air.norfolk.gov among them).
  // - virginia.gov covers the state agencies, and lis.virginia.gov and
  //   law.lis.virginia.gov (legislation and the Code of Virginia).
  // - norfolkcityva.iqm2.com is the City's meeting portal (src/cities/norfolk.js).
  // NRHA is not listed: nrha.org redirects to the North American Hardware and
  // Paint Association (yournhpa.org), not the Norfolk Redevelopment and
  // Housing Authority, checked 2026-11-10. nrha.us calls itself the
  // authority (555 E. Main St.); adding it is Jason's call.
  webSearch: {
    allowedDomains: [
      'www.norfolk.gov',
      'norfolkcityva.iqm2.com',
      'virginia.gov',
      'fema.gov',
      'epa.gov',
      'census.gov',
      'hud.gov',
      'noaa.gov',
      'usgs.gov',
      'regulations.gov',
      'congress.gov',
    ],
    maxUses: 3,
  },
  contacts: [],
  links: [
    { title: 'Siren is open source: github.com/jedelman/socrata-agent', url: 'https://github.com/jedelman/socrata-agent' },
    { title: 'FEMA flood maps (Map Service Center)', url: 'https://msc.fema.gov/portal/home' },
  ],
};
