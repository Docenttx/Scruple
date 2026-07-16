# Scruple for Blender — install quickstart

## Requirements

- Blender 4.2 LTS or newer (Extensions install), or 3.6 through 4.1
  (classic addon install).
- A Scruple account. Sign up at [scruple.ai](https://scruple.ai).

## 1. Install the addon

**Blender 4.2+ (Extensions):**

1. Download `scruple-blender-<version>.zip`.
2. Drag-drop the zip into any Blender window.
3. Blender opens the Extensions Install dialog. Confirm.

**Blender 3.6 - 4.1 (classic addon):**

1. Edit -> Preferences -> Add-ons -> Install from Disk.
2. Choose the zip.
3. Enable "Pipeline: Scruple" from the addon list.

Either way, the addon shows up in Edit -> Preferences -> Add-ons under
"Scruple" and adds a "Scruple" tab to the 3D Viewport N-panel.

## 2. Sign in

1. Open the addon preferences (Edit -> Preferences -> Add-ons -> expand
   Scruple).
2. Click **Sign in**. Your default browser opens on scruple.ai.
3. Complete sign-in. A localhost callback returns you to Blender.
4. The Account row updates to "Signed in".

If the browser handshake fails (typical on locked-down Linux desktops),
generate a key at
[scruple.ai/settings/keys/desktop](https://scruple.ai/settings/keys/desktop)
and paste it into the **API key** field.

## 3. Set up payment (once)

Blender never sees your card. Payment lives on scruple.ai.

1. In the addon preferences, click **Set up payment on scruple.ai**.
2. Add a card via the Stripe form on scruple.ai.
3. Return to Blender. The Scruple N-panel now shows the card on file
   and enables the paid buttons.

## 4. First render

1. Open (or create) a `.blend`.
2. Render (F12) or save (Ctrl+S). The addon witnesses the output
   automatically in the background.
3. Open the **Scruple** tab in the 3D Viewport N-panel. The current
   project shows up, with the just-witnessed leaf visible in the
   Recent receipts list.

## 5. Paid actions

- **Witness Now** — free. Manually re-witness the current output.
- **Checkpoint $5** — soft-lock. Preserves progress; leaves the
  project open for more iterations.
- **C2PA sign $10** — permanent local finalize with a C2PA-signed
  export sidecar.
- **Chain-lock $100** — public anchor on the RVN chain plus IPFS +
  Arweave pinning.

Each paid button opens an in-Blender confirmation dialog before
charging your card on file.

## Troubleshooting

- **Nothing shows in the N-panel** — enable the addon (Edit ->
  Preferences -> Add-ons -> Scruple).
- **"Not signed in"** — repeat step 2. If the browser handshake fails,
  use the manual key paste fallback.
- **"No payment method on file"** — repeat step 3.
- **Verbose logging** — flip the "Verbose logging" checkbox in the
  addon preferences to get a full trace in the console (Window ->
  Toggle System Console on Windows; run Blender from a terminal on
  macOS/Linux).

## Support

- Documentation: [scruple.ai/docs](https://scruple.ai)
- Contact: `scruple@docentechs.com`
- Publisher: Docent LLC (dba Docent Technologies)
