// Convenience barrel — importing this registers ALL built-in verifier
// plugins via their side-effect module loads.
//
// Consumers that need everything (server API + CLI) should import this
// once at startup:
//   import '@scruple/attestation-verifiers/plugins/all_verifiers';

import './sev_snp.js';
import './nvidia_h100.js';
import './aws_nitro.js';
import './azure_maa.js';
import './intel_tdx.js';
import './tpm_2.js';
