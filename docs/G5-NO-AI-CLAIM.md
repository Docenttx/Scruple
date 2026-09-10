# WO-G5 — the claim this plugin exists to make

_2026-09-10. Gate: `bash scripts/g5-gate.sh` — **21/21**, including the §4 control
inside a real Blender 4.2.23. 19 unit refusals, 7 live registration checks._

## The market is the opposite of Studio's, and that changes the proof

Studio proves **AI made this**, and a signature over the output is most of that.
This plugin's market is **a human made this without AI**, and a signature proves
nothing about it.

> **A signature over an output proves the output. Nothing about an output proves
> what did NOT go into it.**

Absence is carried by the **completeness of the record**, so every gap is exactly
where the AI step could have been, and a claim made over a gap is not a weaker
claim — it is a false one. That single observation determined the whole design.

## `digitalSourceType` is derived, never chosen

Standard §9.1 puts `digitalSourceType` in the manifest. For this plugin **that
field IS the claim**; everything else is bookkeeping around it. Before G5 the
add-on named it **nowhere** — two test files said `DIGITAL_CREATION` and nothing
in the product said anything.

A checkbox reading *"no AI was used"* is worth exactly what the person ticking it
says it is, which in an evidentiary system is nothing. So `source_type.derive()`
reads the record the add-on already keeps and returns the strongest claim it
actually supports:

| Record says | Claim |
|---|---|
| complete, nothing generative | `DIGITAL_CREATION` |
| complete, and it is an edit of existing work | `HUMAN_EDITS` |
| complete, and names generative material | `COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA` |
| **has a hole** | **refusal, with the hole named** |
| — | 🔴 **never** `TRAINED_ALGORITHMIC_MEDIA` |

The last row is asserted three ways in the gate. Studio's answer is this plugin's
exact opposite, and a plugin emitting it would assert that AI made a human's work.

### The six refusals

`no_datablock_enumeration` · `unreadable_datablocks` · `no_addon_enumeration` ·
`unreadable_addons` · `addon_set_changed` · and the shape where `source: none`
is not an empty set.

**The refusals are the module, not its edge cases.** A version of the test file
that only exercised the happy path would pass against a function that returned
`DIGITAL_CREATION` unconditionally. Each refusal has a must-NOT-fire beside it:
an *unchanged* add-on set must leave the claim alone, or the change-refusal proves
nothing.

## Standard §4 is what carries the claim, not §9

*"Changing an integration is itself a witnessed event."*

Our own add-on being witnessed is the easy half and the useless half. The question
a verifier actually has is **"was there an AI plugin in this Blender?"**, and
nothing about `scruple_blender` answers it. So `host_addons.py` enumerates **every
enabled add-on** — module, declared version, and a **digest over its files** —
because an add-on can be edited in place without its version changing, and a
record that held only names and versions would call that the same Blender. The
gate proves that case specifically.

⚑ **The module never judges whether an add-on is "an AI add-on."** That would be a
blocklist, and a blocklist is one rename away from wrong; its failure mode is a
confident non-AI claim over a scene an unlisted generator built. What the record
supports is checkable instead: *these were the add-ons, here is the digest, it did
not change* — and a verifier who cares can read the list.

### The control, in a real Blender

```
baseline    8 add-ons, 0 unhashable    sha256:d87affe45e2…
claim       DIGITAL_CREATION
                ↓  install g5_probe_addon
after       9 add-ons                  sha256:b03ecf97a5c…
change      added: ['g5_probe_addon']  changed: true
claim       REFUSED — addon_set_changed
```

And the same scene with the texture **declared** generative:
`COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA`, naming `texture.png`. Declared
generative material is a **fact, not a hole** — which is what lets one module
serve both this plugin and Studio.

## 🔴 The bug that made the whole plugin useless

`ADDON_DIGEST_LIMIT_BYTES` was 32 MB. **Blender ships `cycles` — its own renderer
— at 34 MB.** So on a *stock* Blender one bundled add-on was always unhashable,
`derive()` always returned `unreadable_addons`, and **the no-AI claim could never
be made by anybody.**

The bound was written to stop a pathological add-on stalling a user, and it was
quietly deciding the product's central claim instead. Raised to 512 MB — no add-on
a person would install trips it, and it is affordable because **the reading is not
on the save path**: the set is hashed when a baseline is taken and when a claim is
made, not on every handler. Anything still over it is a genuine gap and still
refuses.

Found only because the gate ran against a real Blender. Every unit test passed
throughout.

## 🔴 And a test that tested itself

The first fixtures invented their own key names — `imported_datablocks_source`
rather than the document's `source`, which is what `wire_fields()` prefixes.
**All 19 tests passed and `derive()` refused every document a real Blender
produced.** The fixtures now build documents with `declaration()` and `entry()`,
the real constructors. A fixture that does not come from the code under test is a
test of the fixture.

## What is left

**The derived type is not on the wire.** `client.mark()` takes `leaf_id`, `mime`,
`modalities`, `chain_tier` and `payment_intent_id` — there is **no field for a
`digitalSourceType`**, so the server cannot be told what a scene supports. The
add-on computes the claim, shows it, and refuses when it cannot make it; carrying
it to the signer is a wire-format change on both sides and is not in this work
order. `adapter/claim.py`'s `wire` block already assembles the value and names the
gap where a reader will look for it.

Until then the gate's first clause — *"a human-made Blender render is signed
asserting a non-AI digitalSourceType"* — is proven up to the signer's door: the
claim is derived, correct, and withheld when the record is incomplete. **It is not
proven in a manifest.** That is the honest state and it is the next increment.

Two buttons exist and run: **Baseline Add-ons** (§4) and **Check Claim**. Neither
signs anything, deliberately — what a user needs before they lock is whether their
scene can carry the claim at all, and which hole is the reason when it cannot. A
button that silently signed with a weaker type would take that decision away from
the person whose work it is.
