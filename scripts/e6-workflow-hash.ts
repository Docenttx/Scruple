#!/usr/bin/env node
// WO-E6 — `workflow_hash`, computed with THE SDK'S OWN function.
//
//     bash scripts/tsx.sh scripts/e6-workflow-hash.ts <body.json>
//
// The gate hashes the WHOLE body of `POST /prompt`
// (`services/scruple-capture/src/surfaces/http-gate.ts`: `JSON.parse(body)` →
// `correlator.openPrompt(prompt_id, graph)` → `hashGraphOrTraining`), so this
// takes the whole body too and prints its digest.
//
// ⚑ IT IMPORTS RATHER THAN IMPLEMENTS, and that is not a style preference.
// `hashWorkflow` is RFC 8785 canonicalization, and WO-21 measured what a second
// implementation costs: `1e-5` serialises as `0.00001` in JavaScript and
// `1e-05` in Python, so two conforming verifiers compute two different hashes
// for one document and the difference looks exactly like tampering. A driver
// with its own canonicalizer would be asserting that the leaf agrees with the
// driver, which is not the claim.
import fs from 'node:fs';

import { hashWorkflow } from '../vendor/scruple-web/lib/leaf/hashes';

const path = process.argv[2];
if (!path) {
  console.error('usage: e6-workflow-hash.ts <body.json>');
  process.exit(2);
}
const doc = JSON.parse(fs.readFileSync(path, 'utf8'));
process.stdout.write(`${hashWorkflow(doc)}\n`);
