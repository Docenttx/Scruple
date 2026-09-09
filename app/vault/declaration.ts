// WHO IS ENTITLED TO SAY WHAT A FILE IS.
//
// The legacy vault answered this with the filename:
//
//     } else if (filename.endsWith('.safetensors')) {
//         const headerResult = hashSafetensorsHeader(filePath);
//
// docs/DESIGN.md replaces that branch with DECLARED MIME, "refusing rather
// than guessing", and CANON_SKELETON.md §5 property 1 is the rule behind it:
// MIME is declared, never guessed — "never from an extension, never from
// mimetypes.guess_type()". `services/scruple-capture/src/mime.ts` is the same
// rule for ComfyUI, where the DECLARER is the writing node class.
//
// A vault has no writing node and no wire, so the declarer is the party that
// filled the directory: the trainer, the exporter, or Desktop Studio on their
// behalf. It writes ONE file, `scruple-vault.json`, and that file is the whole
// of the vault's type information:
//
//     {
//       "vault_declaration": "v1",
//       "declared_by": "kohya-ss/sd-scripts 21.8.5",
//       "files": {
//         "config.toml":  { "mime": "application/toml" },
//         "opaque.bin":   { "mime": null, "reason": "no type is declarable for these bytes" }
//       }
//     }
//
// THREE OUTCOMES, AND THE VAULT KEEPS THEM APART:
//
//   named with a mime      → `measured`.       The declarer typed it.
//   named with mime: null  → `absent`.         The declarer WAS asked and said
//                                              there is no type. A real answer.
//   not named at all       → `indeterminate`.  Nobody was asked, or nobody who
//                                              was entitled answered.
//
// The last two both REFUSE the file, and a reader who wants to know why gets a
// different word for each. That is WO-62's rule applied to MIME rather than to
// a manifest hash: collapsing "genuinely absent" into "could not determine" is
// the original defect, and refusing both does not excuse conflating them.
//
// ⚑ THERE IS NO EXTENSION TABLE IN THIS FILE AND THERE MUST NOT BE ONE. The
// control in scenarios/vault-capture.json is a file called `undeclared.png`
// sitting beside a declared `accepted.png`. Any lookup keyed on '.png' — a
// map, a regex, a `mimetypes` import, a "sensible default" — makes that
// control pass, and the control passing is the failure.

import fs from 'node:fs';
import path from 'node:path';

import { absent, indeterminate, measured, type Measurement } from './measurement';

/** The declaration file's name inside the vault. Excluded from the file set it
 *  describes — see `VaultSurface` for why it is hashed anyway. */
export const DECLARATION_FILENAME = 'scruple-vault.json';

export interface DeclarationFile {
  vault_declaration: string;
  declared_by: string;
  files: Record<string, { mime?: string | null; reason?: string | null }>;
}

export class Declaration {
  private constructor(
    readonly path: string,
    readonly declaredBy: string,
    private readonly entries: Record<string, { mime?: string | null; reason?: string | null }>,
  ) {}

  /**
   * Read the declaration, or refuse to open the vault.
   *
   * A MISSING DECLARATION IS NOT AN EMPTY ONE. A vault with no declaration
   * would refuse every file, and a surface that refuses everything passes no
   * control — it looks identical to a correct surface pointed at a directory
   * of undeclared files. So this throws, and `VaultSurface.open()` lets it: a
   * surface that cannot acquire its observation position must throw
   * (lib/capture/surface.ts), and the type information IS part of the position
   * for a surface whose whole job is refusing to guess.
   */
  static read(vaultDir: string): Declaration {
    const p = path.join(vaultDir, DECLARATION_FILENAME);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      throw new Error(
        `vault: no ${DECLARATION_FILENAME} at ${p} (${String((e as NodeJS.ErrnoException).code ?? e)}). ` +
          'A vault carries its own type declarations; without one, nothing is entitled to ' +
          'say what any of these bytes are and every file would be refused. Refusing to ' +
          'OPEN is the honest failure — a surface that refuses everything cannot be told ' +
          'apart from a correct one.',
      );
    }
    let doc: DeclarationFile;
    try {
      doc = JSON.parse(raw) as DeclarationFile;
    } catch (e) {
      throw new Error(`vault: ${p} is not JSON: ${String(e)}`);
    }
    if (doc.vault_declaration !== 'v1') {
      throw new Error(
        `vault: ${p} declares version ${JSON.stringify(doc.vault_declaration)}; this surface ` +
          'reads v1 only. A declaration read under the wrong rules is worse than none.',
      );
    }
    if (!doc.files || typeof doc.files !== 'object') {
      throw new Error(`vault: ${p} has no \`files\` object.`);
    }
    return new Declaration(p, String(doc.declared_by ?? 'unattributed'), doc.files);
  }

  /**
   * The declared MIME for one entry, as a three-state measurement.
   *
   * `relPath` is the path RELATIVE TO THE VAULT ROOT, in posix form, so a
   * declaration is portable and a file in a subdirectory is nameable. Lookup
   * is exact: no normalisation, no case folding, no prefix matching. A
   * declaration that does not name this exact path did not name this file.
   */
  mimeFor(relPath: string): Measurement<string> {
    const src = `${DECLARATION_FILENAME} declared_by=${this.declaredBy}`;
    if (!Object.prototype.hasOwnProperty.call(this.entries, relPath)) {
      return indeterminate(
        src,
        `no entry for ${JSON.stringify(relPath)}. Nobody entitled to type these bytes was ` +
          'asked, and this surface does not read the extension.',
      );
    }
    const e = this.entries[relPath];
    const m = e && typeof e.mime === 'string' ? e.mime.trim() : '';
    if (m) return measured(m, src);
    return absent(
      src,
      e && e.reason
        ? String(e.reason)
        : 'the declaration names this file and declares no type for it.',
    );
  }

  /** Every path the declaration names, for the "declared but not present" report. */
  declaredPaths(): string[] {
    return Object.keys(this.entries).sort();
  }
}
