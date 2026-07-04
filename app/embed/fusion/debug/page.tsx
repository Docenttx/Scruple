// Live view of Fusion add-in diagnostic events. Polls
// /api/diag/fusion?since=<ms> every 1s. Open on a second monitor
// while working in Fusion — every event shows up as it fires.
//
// No auth (diagnostic surface). Server-only handler; the page component
// is a client component below.

import DebugStream from './DebugStream';

export const dynamic = 'force-dynamic';

export default function Page() {
  return <DebugStream />;
}
