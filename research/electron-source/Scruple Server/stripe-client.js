/**
 * stripe-client.js - Oracle Stripe Payment Client
 *
 * Communicates with Oracle /api/stripe-* endpoints.
 * Replaces tsd-client.js for fiat payment mode.
 *
 * SCRUPLE Studio — Patent Pending
 */

'use strict';

const ORACLE_URL = process.env.SCRUPLE_WITNESS_URL || 'http://129.80.23.93:5799';
const TIMEOUT_MS = 15000;

/**
 * Fetch Stripe publishable key from Oracle.
 * Called once at app startup.
 */
async function getConfig() {
  const response = await fetch(`${ORACLE_URL}/api/stripe-config`, {
    method: 'GET',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error('Failed to get Stripe config: ' + response.status);
  return await response.json();
}

/**
 * Create a Stripe PaymentIntent for a given action.
 * Returns { success, clientSecret, paymentIntentId, amount, currency, action }
 */
async function createPaymentIntent(action, projectId, installationId) {
  const response = await fetch(`${ORACLE_URL}/api/create-payment-intent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, projectId: String(projectId), installationId }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error('Failed to create payment intent: ' + response.status);
  return await response.json();
}

/**
 * Verify a completed Stripe payment and execute the lock action on Oracle.
 * Returns lock result: { success, scrId, proofTxId, ... }
 */
async function confirmAndExecute(paymentIntentId, action, projectId, installationId, options) {
  const response = await fetch(`${ORACLE_URL}/api/confirm-and-execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      paymentIntentId,
      action,
      projectId: String(projectId),
      installationId,
      lockTier: options.lockTier || null,
      merkleRoot: options.merkleRoot || null,
      preScrId: options.preScrId || null
    }),
    signal: AbortSignal.timeout(120000) // 2 min — chain lock is slow
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'confirm-and-execute failed: ' + response.status);
  }
  return await response.json();
}

/**
 * Verify a payment intent was successful (used by IPC lock handlers).
 * Returns { valid, error }
 */
async function verifyPayment(paymentIntentId, action) {
  try {
    const result = await confirmAndExecute(paymentIntentId, action, '0', 'verify-only', {});
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Clone project witness records on Oracle (preserved from tsd-client).
 */
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
  if (!response.ok) throw new Error('Oracle clone-project failed: ' + response.status);
  return await response.json();
}

module.exports = { getConfig, createPaymentIntent, confirmAndExecute, verifyPayment, cloneProject };
