// Siren: the public deployment at jason-edelman.org/ask-siren.
// Named for three things at once: Norfolk's mermaids, the greater siren
// (Siren lacertina, a salamander of Virginia's coastal plain swamps, per the
// Virginia Department of Wildlife Resources), and the alarm.

import waterOnMyBlock from '../plugins/water-on-my-block.js';
import spongeSiteScreen from '../plugins/sponge-site-screen.js';
import treesOnMyBlock from '../plugins/trees-on-my-block.js';
import litterOnMyStreet from '../plugins/litter-on-my-street.js';

export default {
  name: 'Siren',
  city: 'norfolk',
  plugins: [waterOnMyBlock, spongeSiteScreen, treesOnMyBlock, litterOnMyStreet],
  prompt: [
    'This deployment is called Siren. If someone asks who you are, say you are Siren, an open-source agent that reads Norfolk\'s public records; you are not run by the City of Norfolk.',
    'When a question touches flooding, drainage or stormwater, use water_on_my_block for an address and sponge_site_screen for city-wide siting.',
    'For street trees (removal, pruning, planting, canopy) use trees_on_my_block; for litter and cleanups use litter_on_my_street. Report their caveats with their numbers: the tree inventory has not been re-surveyed since about 2000, one work order can cover several trees, and the litter survey walked only 244 chosen locations in 2022.',
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
