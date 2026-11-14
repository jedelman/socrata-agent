// Siren: the public deployment at https://ask-siren.jason-edelman.org/.
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
import cityNews from '../plugins/city-news.js';
import streetSegment from '../plugins/street-segment.js';
import housingCount from '../plugins/housing-count.js';
import areaLookup from '../plugins/area-lookup.js';

export default {
  name: 'Siren',
  city: 'norfolk',
  // Every plugin in plugins/ belongs here; test/plugins.test.js checks it.
  plugins: [waterOnMyBlock, spongeSiteScreen, treesOnMyBlock, litterOnMyStreet, caseFile, parcelInventory, ordinances, budgetBooks, budgetFor, capitalProjects, cityNews, streetSegment, housingCount, areaLookup],
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
    'For what the City has announced (closures, events, programs, road work, grants, tax and other deadlines, library and parks notices, emergency alerts, and City Council agendas posted as news) use city_news, and give each item\'s date and link, as the City\'s announcement rather than a record of what happened. It carries no police or court news, by design: if asked for those, say so, rather than that you found none. Don\'t repeat a private person\'s name from an item.',
    'For a stretch of street between two cross streets (its blocks, speed limit, traffic direction, how many parcels touch it) use street_segment. For how many homes an area or a street segment holds, or its share of a larger place\'s homes, use housing_count, with the larger place as `of`, and give the share it computes rather than working one out. Find an area\'s exact name with area_lookup first. When a name matches more than one area (Ghent matches three civic leagues), ask which one the person means, offering all of them together, before counting, unless the question already says. Say which homes were counted exactly and which apartment units were estimated, as housing_count reports it.',
    'Keep rain flooding and tidal flooding separate; the records distinguish them and so should you.',
  ].join('\n'),
  ui: {
    skin: 'siren',
    tagline: 'Sings only what the records say.',
    loading: 'Wading through the records. This usually takes 10 to 30 seconds',
    footerNote: "Named for Norfolk's mermaids, the greater siren of Virginia's coastal-plain swamps, and the alarm.",
    badge: 'Pre-alpha · invite only',
    operator: 'Jason Edelman',
    // Anthropic Console, Settings > Data retention, read by Jason 2026-11-10:
    // "Inputs, Outputs, and other data are retained for 30 days by default
    // and may be accessed by Anthropic for safety and security purposes."
    dataNote: 'Each question, and what Siren finds for it, goes to Anthropic, whose model writes the answer. Anthropic keeps them for 30 days and may review them for safety and security.',
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
    // Sites that publish law, maps, data and program pages, never news
    // posts, case documents, public comments or hearing exhibits: those
    // name private people, and Siren doesn't find people (CLAUDE.md). The
    // API takes an allowlist or a blocklist, never both, so a site with one
    // such section is listed by subdomain or path, or not at all. Probed
    // 2026-11-10 with Anthropic's web search (names, arrests, missing
    // persons, owners, convictions); the probes found nothing about private
    // people on the sites kept, and what they found on the sites dropped is
    // below. A probe is a sample, not proof: check a site before adding it.
    //
    // Left off, with what a probe found there on 2026-11-10:
    // - www.norfolk.gov, all but two paths: Norfolk Police news posts name
    //   arrested adults with charges, identify arrested juveniles by age, and
    //   name missing people with the street where they were last seen; the
    //   same kind of record as the Arrest Reports and Active Warrants
    //   datasets the Norfolk profile excludes. They are the City's News Flash
    //   (/CivicAlerts.aspx, /m/newsflash/), the same path as all City news,
    //   told apart only by a query string, which a path can't filter. So
    //   City news reaches Siren through the newsletters (/CivicSend) and the
    //   city_news tool (plugins/city-news.js: the News Flash and Alert Center
    //   feeds by category, police and prosecutor news left out in code), and
    //   forms through the Form Center (/FormCenter) and the Document Center
    //   (/DocumentCenter), all listed below.
    //   (The city's open data, budget books, zoning ordinance and meetings
    //   reach Siren through its own tools.)
    // - norfolkcityva.iqm2.com: hearing packets carry the names and
    //   addresses of property owners within 300 feet (the owner columns the
    //   profile withholds). Siren reads meetings through its iqm2 adapter.
    // - virginia.gov: covers vsp.virginia.gov (Wanted and Missing Persons).
    //   lis.virginia.gov whole: rga.lis.virginia.gov holds the Governor's
    //   clemency lists, by person and conviction; only law.lis and bill
    //   pages are listed. townhall.virginia.gov and regulations.gov: public
    //   comments with the commenter's name and city or ZIP.
    //   dhcd.virginia.gov: certification lists of named individuals.
    //   deq.virginia.gov: enforcement orders, mostly against companies, not
    //   checked for individuals; off until they are.
    //   vdot.virginia.gov whole: project PDFs (right-of-way plans) not
    //   checked for owner names; only the project pages are listed.
    // - epa.gov: a fugitives list, wanted posters and per-defendant case
    //   summaries. hud.gov: the Limited Denial of Participation list, by
    //   person and city. noaa.gov whole: a permit-holder file with names,
    //   phones and mailing addresses, and enforcement decisions naming
    //   respondents. fema.gov whole: press releases naming people sentenced
    //   for disaster fraud. congress.gov whole: hearing exhibits about named
    //   people; only bill pages are listed.
    // Only Jason widens this list.
    allowedDomains: [
      'law.lis.virginia.gov', // Code of Virginia, Administrative Code, city charters
      'lis.virginia.gov/bill-details', // Virginia bills, their text and votes
      'congress.gov/bill', // federal bills
      'census.gov',
      'usgs.gov',
      'msc.fema.gov', // flood maps
      'tidesandcurrents.noaa.gov', // tides and sea level
      'coast.noaa.gov', // sea level rise viewer, Digital Coast
      'dcr.virginia.gov', // floodplains, dam safety, conservation
      'dof.virginia.gov', // forestry, urban tree canopy
      'vdot.virginia.gov/projects', // road project pages
      // The City's online forms and its email newsletters (Jason asked for
      // forms and public communications, 2026-11-10). Probed that day for
      // arrests, wanted and missing people, and owner lists: nothing.
      'www.norfolk.gov/FormCenter',
      'www.norfolk.gov/CivicSend',
      // Most PDF forms (building, plumbing, event permits). It also holds
      // Planning staff reports, which name each land-use applicant beside the
      // address: a business in the one read, but a homeowner for a short-term
      // rental permit. Norfolk's ordinance titles never carry those names.
      // Jason accepted that on 2026-11-10 ("1. Yes"), for the forms; the
      // prompt asks Siren not to repeat a private person's name from a page.
      // Probed that day for arrests, wanted and missing people, and owner
      // lists: nothing (letters to owners within 300 ft are mentioned, not
      // listed).
      'www.norfolk.gov/DocumentCenter',
      // The City's own project pages, one page at a time (Jason, 2026-11-11:
      // "Yep. Have the routine vet them."). Each is a page id with its slug,
      // so the prefix matches that page and nothing else; the case-file
      // routine proposes more after the same vetting (docs/case-file-routine.md).
      // Read 2026-11-11: the MacArthur Center redevelopment overview, timeline,
      // design vision and document list; they name only the Mayor, in office.
      'www.norfolk.gov/6267/MacArthur-Center',
      'www.norfolk.gov/6702/Project-Overview',
      // News, by section only (Jason, 2026-11-11: "If a name is quoted in a
      // news article it's public info and OK to quote. News orgs have vetting
      // and fact checking liabilities that we can gate on."). A whole news
      // site isn't listed: WHRO and Virginia Business both carry crime and
      // court stories naming people, which would let a search look someone
      // up (the people-finding line in CLAUDE.md). Probed 2026-11-11 with
      // Anthropic's web search: whro.org whole returned arrest and shooting
      // stories; whro.org/local-government returned none for "arrested
      // charged police shooting" and Council coverage for "Norfolk City
      // Council vote". The case-file routine proposes other sections after
      // the same probe.
      'whro.org/local-government',
    ],
    // Which allowedDomains entries are news sections: the prompt gives them
    // their own rules (attribute to the outlet with the date; names the
    // article quotes may be quoted).
    newsDomains: ['whro.org/local-government'],
    maxUses: 3,
  },
  contacts: [],
  links: [
    { title: 'Siren is open source: github.com/jedelman/socrata-agent', url: 'https://github.com/jedelman/socrata-agent' },
    { title: 'FEMA flood maps (Map Service Center)', url: 'https://msc.fema.gov/portal/home' },
  ],
};
