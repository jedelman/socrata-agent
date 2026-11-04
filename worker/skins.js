// Visual skins for the web app, chosen by a deployment's `ui.skin`. The page
// stays the same; a skin swaps the mark, the favicon, the display font and the
// palette (see [data-skin] in ui.html). The default skin is plain.

// The greater siren (Siren lacertina): an eel-bodied salamander of Virginia's
// coastal-plain swamps, with feathery external gills and front legs only.
const SIREN_MARK = `<svg class="mark" viewBox="0 0 120 48" aria-hidden="true" focusable="false">
  <path class="body" d="M7 26c0-6 5-10 12-10 8 0 13 4 20 6 9 2.6 15 1 23-3 9-4.5 18-7 27-5 9 2 17 7 25 12.5-8-2-15-2.7-22-1.4-9 1.8-15 6.5-25 8.6-9 1.9-17 .6-24-1.6C27 35 21 33.4 15 33.4 10 33.4 7 30.8 7 26z"/>
  <g class="gill">
    <path d="M23 17c-1.6-3.6-1.2-6.8 1-9.6"/><path d="M26.2 17.2c.2-3.8 1.8-6.6 4.4-8.2"/><path d="M28.8 18.8c2.4-3 5.2-4.4 8.2-4.4"/>
  </g>
  <g class="barb">
    <path d="M22.3 13.4l-2.6-.9M22.6 10.6l-2.3-1.4M24.2 12.6l2-1.6"/><path d="M27 12.8l-2-1.8M28.6 10.4l-1.4-2M28.2 13.6l2.4-.8"/><path d="M31.6 16l-.6-2.4M34.4 14.8l-.2-2.4M33 17.2l2 1.2"/>
  </g>
  <path class="leg" d="M27.5 33l-2.2 6.6M27.5 33c.7 2.2 1.3 4.3 1.6 6.4M27.5 33c1.7 1.6 3.1 3.4 4 5.4"/>
  <circle class="eye" cx="14" cy="23" r="1.7"/>
</svg>`;

const SIREN_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='#0c2a2b'/><path d='M4 17c0-3 3-4.5 6-4.3 5 .4 8 3.6 13 4 3 .2 5-.8 6-1.2-2 2.6-5 4.2-9 4.2-4 0-7-2-10-2.1C7 17.5 4 19 4 17z' fill='#6fd1bf'/><path d='M11 13c-.5-2 0-3.5 1-4.5M12.5 13c.5-2 1.5-3 2.5-3.5' stroke='#e2bb4d' stroke-width='1.2' fill='none' stroke-linecap='round'/></svg>`
  );

const PLAIN_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='#1f5f4a'/><path d='M8 22V12l8-5 8 5v10h-5v-6h-6v6z' fill='white'/></svg>`
  );

export const skins = {
  plain: { mark: '', fonts: '', favicon: PLAIN_FAVICON },
  siren: {
    mark: SIREN_MARK,
    fonts:
      '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&display=swap" rel="stylesheet">',
    favicon: SIREN_FAVICON,
  },
};
