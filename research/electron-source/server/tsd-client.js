/**
 * tsd-client.js - Test Scruple Dollar payment client
 * Mock fiat payment gate for beta testing.
 * Stripe will slot into this flow in production — same shape, real money.
 *
 * SCRUPLE Studio — Patent Pending
 */

const ORACLE_URL = process.env.SCRUPLE_WITNESS_URL || 'http://129.80.23.93:5799';
const TIMEOUT_MS = 8000;

async function getBalance(installationId) {
  const response = await fetch(`${ORACLE_URL}/api/tsd/balance/${encodeURIComponent(installationId)}`, {
    method: 'GET',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`TSD balance check failed: ${response.status}`);
  }
  return await response.json();
}

async function fundAccount(installationId, amount) {
  const response = await fetch(`${ORACLE_URL}/api/tsd/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId, amount }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`TSD fund failed: ${response.status}`);
  }
  return await response.json();
}

async function pay(installationId, action, amount) {
  const response = await fetch(`${ORACLE_URL}/api/tsd/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId, action, amount }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`TSD pay failed: ${response.status}`);
  }
  return await response.json();
}

async function verifyToken(authToken, action) {
  const response = await fetch(`${ORACLE_URL}/api/tsd/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authToken, action }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`TSD verify failed: ${response.status}`);
  }
  return await response.json();
}

async function cloneProject(sourceProjectId, newPreScrId, newProjectName, installationId) {
  const response = await fetch(`${ORACLE_URL}/api/clone-project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_project_id: String(sourceProjectId),
      new_pre_scr_id: newPreScrId,
      new_project_name: newProjectName,
      installation_id: installationId
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`Oracle clone-project failed: ${response.status}`);
  }
  return await response.json();
}

module.exports = { getBalance, fundAccount, pay, verifyToken, cloneProject };
