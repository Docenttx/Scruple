// /embed/fusion — the React UI loaded inside the Fusion add-in palette.
//
// The Fusion add-in mounts this as a Qt WebEngine palette pointing at
// https://app.scruple.ai/embed/fusion?project_id=<id>&token=<api_key>.
//
// On first paint, the page reads `token` from the URL or window.scrupleToken
// (set by the palette host via sendInfoToHTML('auth_token', token)). All
// subsequent fetches send `Authorization: Bearer <token>`.
//
// JS → Python bridge: the palette's incomingFromHTML event handler receives
// a stringified JSON payload via window.adsk.fusionSendData(action, json).
// We polyfill that when not running inside Fusion (dev shell) so we can
// iterate on the UI from a normal browser.

import FusionPalette from './FusionPalette';

export const dynamic = 'force-dynamic';

export default function FusionEmbedPage() {
  return <FusionPalette />;
}
