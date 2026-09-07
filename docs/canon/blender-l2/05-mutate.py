"""Break one thing at a time and check the suite notices."""
import subprocess, sys, shutil, os

MUT = [
    ("panel draws everything signed out",
     "panels/main.py",
     "            if _dash.draw_signin(layout, m):\n                # The gate. Nothing else is drawn signed out -- there is\n                # no session, so every other region would be describing\n                # state that does not exist.\n                return",
     "            if _dash.draw_signin(layout, m):\n                pass"),
    ("queue box always drawn",
     "panels/model.py",
     "    def show_queue(self) -> bool:\n        return self.queue_depth > 0",
     "    def show_queue(self) -> bool:\n        return True"),
    ("offline banner fires on UNKNOWN too",
     "panels/model.py",
     "        return self.connection in (_projects.OFFLINE, _projects.UNAUTHORIZED, _projects.ERROR)",
     "        return self.connection != _projects.ONLINE"),
    ("surrogate warning drawn unconditionally",
     "panels/dashboard.py",
     "    if rec.signature.signer_surrogate:",
     "    if True:"),
    ("blocked lock still draws its operator",
     "panels/dashboard.py",
     "        if action.available and action.operator:",
     "        if action.operator:"),
    ("capture addressed by position",
     "adapter/assurance.py",
     "    leaf_id = getattr(rec, \"leaf_id\", None)\n    if leaf_id:\n        return f\"leaf:{leaf_id}\"",
     "    leaf_id = None\n    if leaf_id:\n        return f\"leaf:{leaf_id}\""),
    ("witness stops carrying project_id",
     "adapter/flow.py",
     "        project_id=_state.get().active_project_id,",
     "        project_id=None,"),
    ("drill-down shown for a refused capture",
     "panels/model.py",
     "        return bool(rec is not None and getattr(rec, \"leaf_id\", None))",
     "        return rec is not None"),
    ("draw() fetches the project list",
     "panels/dashboard.py",
     "def draw_projects(layout, m) -> bool:\n    if not m.show_projects:\n        return False",
     "def draw_projects(layout, m) -> bool:\n    if not m.show_projects:\n        return False\n    from operators import dashboard as _o; _o.refresh_projects()"),
    ("restore archives instead of restoring",
     "tests/mocks/v2.py",
     "                row[\"is_archived\"] = 1 if verb == \"POST\" else 0",
     "                row[\"is_archived\"] = 1"),
    ("receipt sub-panel ignores the sign-in gate",
     "panels/model.py",
     "        if not self.signed_in:\n            return False\n        rec = self.selected_capture",
     "        rec = self.selected_capture"),
    ("payment failure reported as 'not read yet'",
     "operators/dashboard.py",
     "        _state.set_payment_config(None, error=result.error or \"no reason given\")",
     "        _state.set_payment_config(None, error=None)"),
    ("project switch never told to the server",
     "adapter/projects.py",
     "    if tell_server and client is not None:",
     "    if False and client is not None:"),
    ("connection is guessed instead of measured",
     "adapter/projects.py",
     "def _classify(result) -> str:\n    if result.ok:\n        return ONLINE",
     "def _classify(result) -> str:\n    if True:\n        return ONLINE"),
    ("tracker shown with no captures",
     "panels/model.py",
     "        return self.signed_in and bool(self.captures)",
     "        return self.signed_in"),
    ("error region never clears",
     "panels/model.py",
     "    def show_error(self) -> bool:\n        return bool(self.last_error)",
     "    def show_error(self) -> bool:\n        return True"),
]

for name, path, old, new in MUT:
    src = open(path).read()
    if old not in src:
        print(f"SKIP  {name}: anchor not found in {path}")
        continue
    shutil.copy(path, path + ".bak")
    open(path, "w").write(src.replace(old, new, 1))
    r = subprocess.run([sys.executable, "-m", "pytest", "-q", "--no-header", "-x", "-q",
                        "--deselect", "tests/test_sdk_adoption.py::test_every_vendored_file_hashes_to_what_the_manifest_says",
                        "--deselect", "tests/test_sdk_adoption.py::test_the_vendored_copy_matches_the_source_tree_it_came_from"],
                       capture_output=True, text=True)
    shutil.move(path + ".bak", path)
    tail = [l for l in r.stdout.splitlines() if l.startswith("FAILED") or " failed" in l or " passed" in l]
    verdict = "CAUGHT" if r.returncode != 0 else "*** NOT CAUGHT ***"
    print(f"{verdict:20s} {name}")
    for l in tail[:3]:
        print(f"                     {l}")
