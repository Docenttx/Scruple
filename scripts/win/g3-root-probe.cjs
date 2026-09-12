// Is the Merkle root of a CHECKPOINTED project reachable — by the interface,
// and by the app's own verifier?
//
// The tree itself is correct: after two captured iterations `merkle_nodes` holds
// both leaves at level 0 and a parent at level 1 whose children are exactly
// those leaves. The arithmetic is not in question.
//
// What is in question is the FIELD. `MerkleManager.addLeaf()` returns the new
// root and does not write it anywhere on the project row; `merkle.js:189`
// (`verifyProject`) reads `project.merkle_root` and refuses when it is empty;
// and the workspace header renders that same column, which is why a
// checkpointed project shows "N/A MERKLE ROOT" on screen.
//
//   electron g3-root-probe.cjs     (ELECTRON_RUN_AS_NODE=1)
//
// Run against the database the click-through left behind, so this is the state
// a person actually produced by pressing Checkpoint — not a fixture.

const path = require('node:path');
const Module = require('node:module');

const HOME = process.env.SCRUPLE_HOME || 'C:\\SCRUPLEWORK\\.scratch\\g3-home-click';
const LEGACY = path.join(__dirname, 'app-legacy');
const req = Module.createRequire(path.join(LEGACY, 'x.js'));

const { DatabaseManager } = req('./database');
const { MerkleManager } = req('./lock/merkle');

(async () => {
  const db = new DatabaseManager(HOME);
  await db.initialize();
  const merkle = new MerkleManager(db);

  const project = db.getProjectByName('G3_Click_Through');
  if (!project) { console.log('no such project — run g3-click-through.mjs first'); process.exit(2); }

  const out = {
    status: project.status,
    projects_merkle_root: project.merkle_root || null,
    pre_scr_id: project.pre_scr_id || null,
    scr_id: project.scr_id || null,
  };

  // The root the TREE knows, read from merkle_nodes.
  try { out.getRoot = merkle.getRoot(project.id); } catch (e) { out.getRoot = `threw: ${e.message}`; }

  // The app's own verifier, which is what a "sealed" project has to survive.
  try { out.verifyProject = merkle.verifyProject(project.id); } catch (e) { out.verifyProject = `threw: ${e.message}`; }

  const iterations = db.getIterations(project.id) || [];
  out.iterations = iterations.length;

  console.log(JSON.stringify(out, null, 2));

  console.log('');
  const treeHasRoot = typeof out.getRoot === 'string' && /^[0-9a-f]{64}$/.test(out.getRoot);
  const rowHasRoot = !!out.projects_merkle_root;
  const verifies = out.verifyProject && out.verifyProject.valid === true;

  console.log(`the tree knows a root        : ${treeHasRoot ? 'YES  ' + out.getRoot.slice(0, 24) + '…' : 'no'}`);
  console.log(`the project ROW stores it    : ${rowHasRoot ? 'YES' : 'NO  ← the UI and the verifier both read this'}`);
  console.log(`the app can verify itself    : ${verifies ? 'YES' : `NO  ${JSON.stringify(out.verifyProject)}`}`);

  db.close();
  process.exit(treeHasRoot && !rowHasRoot ? 0 : 1);
})();
