// /wallet — legacy route. After clone-2 the wallet experience moved
// into Settings (payment mode + Stripe customer + RVN wallet sections).
// Redirect anyone who hits the old URL.

import { redirect } from 'next/navigation';

export default function WalletPage() {
  redirect('/settings#payment');
}
