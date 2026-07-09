// Barrel that imports every session-backend adapter for its
// side-effect registerSessionBackend() call.
//
// Import this file (once, e.g. at app boot or in the route module that
// calls getSessionBackend) to guarantee the registry is populated.
import './modal-session';
import './runpod-session';
