// Canonical serialization for ComfyUI workflow_api_json.
//
// THIS FILE NO LONGER CONTAINS AN IMPLEMENTATION. It is a re-export of
// `lib/leaf/canonicalJson.ts`, which is the single RFC 8785 (JSON
// Canonicalization Scheme) serializer for this language.
//
// The implementation that used to live here said "recursively sort keys,
// preserve array order, no whitespace" and delegated every scalar to
// `JSON.stringify` — a complete rule for structure and no rule at all for
// numbers. WO-21 measured what that costs: `1e-5` is `0.00001` in JavaScript
// and `1e-05` in Python, so two conforming verifiers compute two different
// `workflow_hash` values for one document, and the mismatch looks exactly
// like tampering. `docs/canon/CANONICALIZATION.md` is the full account.
//
// The move is a re-export rather than a deletion because two implementations
// of a preimage are two preimages, and leaving a second copy here — even a
// correct one — is how they start to drift. The bytes are unchanged for every
// document that is valid JSON, which is why no leaf scheme was bumped.

export {
  canonicalize,
  canonicalizeBytes,
  hashWorkflow,
  canonicalizeLegacy,
  hashWorkflowLegacy,
  CanonicalizationError,
  CANONICALIZATION_PROFILE,
} from '@/lib/leaf/canonicalJson';
