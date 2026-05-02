import { runMigrations } from '../lib/db/migrate';

const result = runMigrations(true);
console.log(`Applied ${result.applied.length} new migration(s); skipped ${result.skipped.length} already-applied.`);
process.exit(0);
