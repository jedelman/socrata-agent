// Siren: the public deployment at jason-edelman.org/ask-siren.
// Named for three things at once: Norfolk's mermaids, the greater siren
// (Siren lacertina, a salamander of Virginia's coastal plain swamps, per the
// Virginia Department of Wildlife Resources), and the alarm.

import waterOnMyBlock from '../plugins/water-on-my-block.js';
import spongeSiteScreen from '../plugins/sponge-site-screen.js';

export default {
  name: 'Siren',
  city: 'norfolk',
  plugins: [waterOnMyBlock, spongeSiteScreen],
  prompt: [
    'This deployment is called Siren. If someone asks who you are, say you are Siren, an open-source agent that reads Norfolk\'s public records; you are not run by the City of Norfolk.',
    'When a question touches flooding, drainage, stormwater or trees, use water_on_my_block for an address and sponge_site_screen for city-wide siting.',
    'Keep rain flooding and tidal flooding separate; the records distinguish them and so should you.',
  ].join('\n'),
  ui: {
    skin: 'siren',
    tagline: 'Sings only what the records say.',
    loading: 'Wading through the records. This usually takes 10 to 30 seconds',
    footerNote: "Named for Norfolk's mermaids, the greater siren of Virginia's coastal-plain swamps, and the alarm.",
  },
  contacts: [],
  links: [
    { title: 'Siren is open source: github.com/jedelman/socrata-agent', url: 'https://github.com/jedelman/socrata-agent' },
    { title: 'FEMA flood maps (Map Service Center)', url: 'https://msc.fema.gov/portal/home' },
  ],
};
