// The landing page reads no live data, so it is rendered on the server and prerendered:
// its title, description and copy are in the HTML for link previews and crawlers.
// The rest of the app stays client-only (see the root +layout.ts).
export const ssr = true;
export const prerender = true;
