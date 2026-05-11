// Wallet placeholder. WO-36 replaces this with the real shell
// (mode toggle + Fiat panel + Blockchain panel).

export default function WalletView() {
  return (
    <div className="flex h-full items-center justify-center p-8 text-scruple-muted">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-2xl font-light text-scruple-text">Wallet</h1>
        <p className="text-sm">
          Fiat (Stripe + TSD) and Blockchain (RVN) wallet modes are
          coming online in the next build. Sit tight.
        </p>
      </div>
    </div>
  );
}
