// Siren: the public deployment at jason-edelman.org/ask-siren.
// Named for three things at once: Norfolk's mermaids, the greater siren
// (Siren lacertina, a salamander of Virginia's coastal plain swamps, per the
// Virginia Department of Wildlife Resources), and the alarm.

import waterOnMyBlock from '../plugins/water-on-my-block.js';
import spongeSiteScreen from '../plugins/sponge-site-screen.js';
import treesOnMyBlock from '../plugins/trees-on-my-block.js';
import litterOnMyStreet from '../plugins/litter-on-my-street.js';
import caseFile from '../plugins/case-file.js';

export default {
  name: 'Siren',
  city: 'norfolk',
  plugins: [waterOnMyBlock, spongeSiteScreen, treesOnMyBlock, litterOnMyStreet, caseFile],
  prompt: [
    'This deployment is called Siren. If someone asks who you are, say you are Siren, an open-source agent that reads Norfolk\'s public records; you are not run by the City of Norfolk.',
    'When a question touches flooding, drainage or stormwater, use water_on_my_block for an address and sponge_site_screen for city-wide siting.',
    'For street trees (removal, pruning, planting, canopy) use trees_on_my_block; for litter and cleanups use litter_on_my_street. Each returns about_the_data: give those caveats next to the numbers they qualify, attributed as the tool gives them.',
    'For questions about these topics with no address (a neighborhood, the whole city, the rules), use case_file to read the same verified record.',
    'Both tools return the_record, a case file of findings checked against their sources. When someone asks whether the City is doing enough, or why, build the answer from it: what the records confirm, what weakens the case, what would help, and which records to request. Name the source of every finding you use, give the weakening findings too, and call anything in not_yet_verified unverified.',
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
  contacts: [],
  links: [
    { title: 'Siren is open source: github.com/jedelman/socrata-agent', url: 'https://github.com/jedelman/socrata-agent' },
    { title: 'FEMA flood maps (Map Service Center)', url: 'https://msc.fema.gov/portal/home' },
  ],
};
