#!/usr/bin/env node
// Entry point. Vendor deploys this; vendor does not author it (§2).

import { loadConfig } from './config';
import { CaptureComponent } from './component';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const component = await CaptureComponent.start(cfg);

  // Drain on a timer as well as on capture, so a component that goes quiet
  // still delivers what it holds. §4.2's silence detection is about the
  // SERVER seeing nothing; a component sitting on an undelivered queue while
  // the network came back would look silent for no reason.
  const drainTimer = setInterval(() => {
    void component.submitter.drain().catch(() => undefined);
  }, 30_000);
  drainTimer.unref();

  const shutdown = async (sig: string) => {
    console.log(`[scruple-capture] ${sig}; draining before exit`);
    clearInterval(drainTimer);
    await component.submitter.drain().catch(() => undefined);
    await component.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[scruple-capture] FATAL: ${String(e)}`);
    process.exit(1);
  });
}
