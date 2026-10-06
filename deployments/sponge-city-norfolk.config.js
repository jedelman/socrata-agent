// A worked example deployment: a Norfolk "sponge city" campaign.
// Copy this file, edit it, and run:
//   node bin/socrata-agent.js ask "..." --config deployments/your.config.js
// or register it in deployments/index.js and set DEPLOYMENT for the web app.
//
// What a config can do: pick the city, add plugin tools, add contacts and
// links, add exclusions, and give the agent focus notes. What it can't do:
// remove exclusions, skip the trace, or switch off the voice check.

import waterOnMyBlock from '../plugins/water-on-my-block.js';
import spongeSiteScreen from '../plugins/sponge-site-screen.js';

export default {
  name: 'Norfolk sponge city (example)',
  city: 'norfolk',
  plugins: [waterOnMyBlock, spongeSiteScreen],
  prompt: [
    'People here care about where rain goes: flooding, drainage, stormwater upkeep, and trees.',
    'For any address question, run water_on_my_block as well as block_report.',
    'Keep rain flooding and tidal flooding separate; the records distinguish them and so should you.',
    'For "where should rain gardens, bioswales or trees go", use sponge_site_screen. Say it is a screen of where to look first, give the reasons for each site, and pass on its caveats.',
  ].join('\n'),
  // Add your group's own people here. Each needs a source you can point to.
  contacts: [],
  links: [
    { title: 'FEMA flood maps (Map Service Center)', url: 'https://msc.fema.gov/portal/home' },
  ],
};
