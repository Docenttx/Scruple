# scruple_check.py — diagnostic for Scruple palette state.
#
# Install: drop into %APPDATA%\Autodesk\Autodesk Fusion 360\API\Scripts\scruple_check\
# Run via Shift+S → Scripts tab → scruple_check → Run.

import adsk.core
import traceback


def run(context):
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        report_lines = []

        # 1. List ALL palettes the app knows about
        report_lines.append("=== All registered palettes ===")
        try:
            count = ui.palettes.count
            report_lines.append(f"Total palettes: {count}")
            for i in range(count):
                p = ui.palettes.item(i)
                report_lines.append(f"  [{i}] id={p.id!r}  name={p.name!r}  visible={p.isVisible}  dock={p.dockingState}")
        except Exception as e:
            report_lines.append(f"  (could not iterate palettes: {e})")

        # 2. Look specifically for the Scruple palette by id
        report_lines.append("")
        report_lines.append("=== Scruple palette (by id 'scruple_main_palette') ===")
        p = ui.palettes.itemById("scruple_main_palette")
        if p is None:
            report_lines.append("NOT FOUND — palette failed to mount or was never created")
        else:
            report_lines.append(f"  id          = {p.id!r}")
            report_lines.append(f"  name        = {p.name!r}")
            report_lines.append(f"  isVisible   = {p.isVisible}")
            report_lines.append(f"  dockingState = {p.dockingState}")
            report_lines.append(f"  width       = {p.width}")
            report_lines.append(f"  height      = {p.height}")
            report_lines.append(f"  htmlFileURL = {p.htmlFileURL}")
            try:
                report_lines.append(f"  isPinned    = {p.isPinned}")
            except Exception:
                pass

            # Force-show it on the right
            report_lines.append("")
            report_lines.append("=== Force-docking to right side ===")
            try:
                p.isVisible = True
                p.dockingState = adsk.core.PaletteDockingStates.PaletteDockStateRight
                report_lines.append("  done — check the right side of Fusion now")
            except Exception as e:
                report_lines.append(f"  failed: {e}")

        ui.messageBox("\n".join(report_lines))

    except Exception:
        if ui:
            ui.messageBox("scruple_check failed:\n" + traceback.format_exc())
