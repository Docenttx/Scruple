// Stripe Customer helpers (Pivot clone-4).
//
// Lazy-creates a Stripe Customer on first interaction. The customer
// id is persisted on `users.stripe_customer_id` so subsequent
// PaymentIntents + SetupIntents can attach to the same customer.

import Stripe from 'stripe';
import { conn } from '@/lib/db/sqlite';

const SECRET = process.env.STRIPE_SECRET_KEY;
let _stripe: Stripe | null = null;

export function stripe(): Stripe {
  if (!_stripe) {
    if (!SECRET) {
      throw new Error('STRIPE_SECRET_KEY not configured in scruple-web environment');
    }
    _stripe = new Stripe(SECRET);
  }
  return _stripe;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  stripe_customer_id: string | null;
}

/** Read the customer id for a user without creating one. */
export function getStripeCustomerId(userId: string): string | null {
  const row = conn()
    .prepare(`SELECT stripe_customer_id FROM users WHERE id = ?`)
    .get(userId) as { stripe_customer_id: string | null } | undefined;
  return row?.stripe_customer_id ?? null;
}

/**
 * Lazily create a Stripe customer for this user. Idempotent — returns
 * the existing id if already set. Stripe's `idempotency_key` ensures
 * we don't double-create on retries.
 */
export async function ensureStripeCustomer(userId: string): Promise<string> {
  const existing = getStripeCustomerId(userId);
  if (existing) return existing;

  const user = conn()
    .prepare(`SELECT id, email, name FROM users WHERE id = ?`)
    .get(userId) as UserRow | undefined;
  if (!user) throw new Error(`User ${userId} not found`);

  const customer = await stripe().customers.create(
    {
      email: user.email,
      name: user.name ?? undefined,
      metadata: { scrupleUserId: user.id },
    },
    { idempotencyKey: `scruple-customer-${user.id}` },
  );

  conn()
    .prepare(`UPDATE users SET stripe_customer_id = ? WHERE id = ?`)
    .run(customer.id, user.id);

  return customer.id;
}

export interface CustomerSnapshot {
  customerId: string;
  email: string | null;
  defaultPaymentMethodId: string | null;
  paymentMethods: Array<{
    id: string;
    brand: string;
    last4: string;
    expMonth: number;
    expYear: number;
    isDefault: boolean;
  }>;
}

/** Fetch the Stripe customer + their saved payment methods. */
export async function snapshotCustomer(userId: string): Promise<CustomerSnapshot | null> {
  const id = getStripeCustomerId(userId);
  if (!id) return null;
  const s = stripe();
  const [cust, methods] = await Promise.all([
    s.customers.retrieve(id),
    s.paymentMethods.list({ customer: id, type: 'card', limit: 20 }),
  ]);
  if (cust.deleted) return null;
  const defaultPm =
    typeof cust.invoice_settings?.default_payment_method === 'string'
      ? cust.invoice_settings.default_payment_method
      : cust.invoice_settings?.default_payment_method?.id ?? null;

  return {
    customerId: id,
    email: cust.email,
    defaultPaymentMethodId: defaultPm,
    paymentMethods: methods.data.map(pm => ({
      id: pm.id,
      brand: pm.card?.brand ?? '?',
      last4: pm.card?.last4 ?? '????',
      expMonth: pm.card?.exp_month ?? 0,
      expYear: pm.card?.exp_year ?? 0,
      isDefault: pm.id === defaultPm,
    })),
  };
}
