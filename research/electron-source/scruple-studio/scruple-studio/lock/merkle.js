/**
 * merkle.js - Merkle Tree Manager
 * 
 * Builds and maintains Merkle trees for provenance chains.
 * The root is used to derive the SCR identifier.
 * 
 * SCRUPLE V3 - AI Provenance Middleware
 * Patent Pending
 */

const crypto = require('crypto');

class MerkleManager {
  constructor(databaseManager) {
    this.db = databaseManager;
    this.trees = new Map();  // In-memory cache of trees by project ID
  }

  /**
   * Add a leaf hash to a project's Merkle tree.
   * Returns the new root hash.
   */
  addLeaf(projectId, leafHash) {
    // Get existing leaves
    const leaves = this.db.getLeafHashes(projectId);
    
    // Rebuild tree with new leaf included (it's already in DB)
    const root = this.buildTree(projectId, leaves);
    
    // Cache the root
    this.trees.set(projectId, root);
    
    return root;
  }

  /**
   * Build complete Merkle tree from leaves.
   * Stores nodes in database for later verification.
   */
  buildTree(projectId, leaves) {
    if (!leaves || leaves.length === 0) {
      return null;
    }

    // Clear existing tree
    this.db.clearMerkleTree(projectId);

    // Single leaf = root is just that hash
    if (leaves.length === 1) {
      this.db.storeMerkleNode(projectId, 0, 0, leaves[0], null, null);
      return leaves[0];
    }

    // Build tree level by level
    let currentLevel = [...leaves];
    let level = 0;

    // Store leaf level
    currentLevel.forEach((hash, position) => {
      this.db.storeMerkleNode(projectId, level, position, hash, null, null);
    });

    while (currentLevel.length > 1) {
      const nextLevel = [];
      level++;

      // Pad with last element if odd number
      if (currentLevel.length % 2 === 1) {
        currentLevel.push(currentLevel[currentLevel.length - 1]);
      }

      // Combine pairs
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = currentLevel[i + 1];
        const combined = this.hashPair(left, right);
        
        nextLevel.push(combined);
        
        // Store this node
        this.db.storeMerkleNode(
          projectId, 
          level, 
          nextLevel.length - 1, 
          combined, 
          left, 
          right
        );
      }

      currentLevel = nextLevel;
    }

    // Root is the single remaining element
    const root = currentLevel[0];
    
    console.log('[MERKLE] Built tree for project ' + projectId + 
                ' with ' + leaves.length + ' leaves, root: ' + root.substring(0, 16) + '...');
    
    return root;
  }

  /**
   * Hash two child hashes together.
   */
  hashPair(left, right) {
    // Sort to ensure consistent ordering (prevents manipulation)
    const combined = left < right ? left + right : right + left;
    return crypto.createHash('sha256').update(combined).digest('hex');
  }

  /**
   * Get current root for a project.
   */
  getRoot(projectId) {
    // Check cache first
    if (this.trees.has(projectId)) {
      return this.trees.get(projectId);
    }

    // Try database
    const dbRoot = this.db.getMerkleRoot(projectId);
    if (dbRoot) {
      this.trees.set(projectId, dbRoot);
      return dbRoot;
    }

    // Rebuild from leaves
    const leaves = this.db.getLeafHashes(projectId);
    if (leaves && leaves.length > 0) {
      const root = this.buildTree(projectId, leaves);
      this.trees.set(projectId, root);
      return root;
    }

    return null;
  }

  /**
   * Derive SCR identifier from Merkle root.
   */
  deriveScrId(merkleRoot, isPersistent = false) {
    if (!merkleRoot) return null;
    
    const prefix = isPersistent ? 'SCRB_' : 'SCR_';
    const suffix = merkleRoot.substring(0, 6).toUpperCase();
    
    return prefix + suffix;
  }

  /**
   * Verify a leaf exists in the tree (Merkle proof).
   * Returns true if leaf can be proven to be part of the tree.
   */
  verifyLeaf(projectId, leafHash, expectedRoot) {
    const leaves = this.db.getLeafHashes(projectId);
    
    // Check leaf exists
    if (!leaves.includes(leafHash)) {
      return { valid: false, error: 'Leaf not found in tree' };
    }

    // Rebuild tree and compare root
    const computedRoot = this.buildTree(projectId, leaves);
    
    if (computedRoot !== expectedRoot) {
      return { 
        valid: false, 
        error: 'Root mismatch',
        computed: computedRoot,
        expected: expectedRoot
      };
    }

    return { valid: true, root: computedRoot };
  }

  /**
   * Verify entire project integrity.
   * Rebuilds tree from iterations and compares to stored root.
   */
  verifyProject(projectId) {
    const project = this.db.getProject(projectId);
    if (!project) {
      return { valid: false, error: 'Project not found' };
    }

    // Get stored root
    const storedRoot = project.merkle_root;
    if (!storedRoot) {
      return { valid: false, error: 'No merkle root stored' };
    }

    // Rebuild from leaves
    const leaves = this.db.getLeafHashes(projectId);
    const computedRoot = this.computeRootFromLeaves(leaves);

    if (computedRoot !== storedRoot) {
      return {
        valid: false,
        error: 'Integrity check failed - tree has been modified',
        computed: computedRoot,
        stored: storedRoot
      };
    }

    return {
      valid: true,
      root: storedRoot,
      leafCount: leaves.length
    };
  }

  /**
   * Compute root without storing (for verification).
   */
  computeRootFromLeaves(leaves) {
    if (!leaves || leaves.length === 0) return null;
    if (leaves.length === 1) return leaves[0];

    let currentLevel = [...leaves];

    while (currentLevel.length > 1) {
      const nextLevel = [];

      if (currentLevel.length % 2 === 1) {
        currentLevel.push(currentLevel[currentLevel.length - 1]);
      }

      for (let i = 0; i < currentLevel.length; i += 2) {
        nextLevel.push(this.hashPair(currentLevel[i], currentLevel[i + 1]));
      }

      currentLevel = nextLevel;
    }

    return currentLevel[0];
  }

  /**
   * Get tree statistics for a project.
   */
  getTreeStats(projectId) {
    const leaves = this.db.getLeafHashes(projectId);
    const root = this.getRoot(projectId);
    
    return {
      leafCount: leaves ? leaves.length : 0,
      root: root,
      scrId: this.deriveScrId(root),
      scrbId: this.deriveScrId(root, true),
      depth: leaves ? Math.ceil(Math.log2(leaves.length || 1)) : 0
    };
  }

  /**
   * Clear cached tree (after project modification).
   */
  invalidateCache(projectId) {
    this.trees.delete(projectId);
  }
}

module.exports = { MerkleManager };
