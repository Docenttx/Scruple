/**
 * asset-encoder.js - Ravencoin Asset Transaction Builder
 * 
 * Builds complete asset issuance transactions for SCRUPLE proof assets.
 * Handles the 4-output structure:
 *   Output 0: 500 RVN to burn address (asset creation fee)
 *   Output 1: Asset issuance (SCR_XXXXXX) to self
 *   Output 2: Ownership token (SCR_XXXXXX!) to self
 *   Output 3: Change back to self
 * 
 * SCRUPLE Studio V3 - AI Provenance Middleware
 * Patent Pending
 */

const crypto = require('crypto');

// ============================================================================
// CONSTANTS
// ============================================================================

// Ravencoin network parameters — mainnet
const NETWORK_MAINNET = {
  messagePrefix: '\x16Raven Signed Message:\n',
  bech32: 'rc',
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4
  },
  pubKeyHash: 0x3c,    // 60  — addresses start with 'R'
  scriptHash: 0x7a,    // 122
  wif: 0x80            // 128
};

// Ravencoin network parameters — testnet
const NETWORK_TESTNET = {
  messagePrefix: '\x16Raven Signed Message:\n',
  bech32: 'rc',
  bip32: {
    public: 0x043587cf,
    private: 0x04358394
  },
  pubKeyHash: 0x6f,    // 111 — addresses start with 'm' or 'n'
  scriptHash: 0xc4,    // 196
  wif: 0xef            // 239
};

// Legacy alias — defaults to mainnet for backward compatibility
const NETWORK = NETWORK_MAINNET;

// Derivation path for Ravencoin (BIP44) — same for mainnet and testnet
const DERIVATION_PATH = "m/44'/175'/0'/0/0";

// Asset issuance burn addresses
const BURN_ADDRESS_MAINNET = 'RXissueAssetXXXXXXXXXXXXXXXXXhhZGt';
const BURN_ADDRESS_TESTNET = 'n1issueAssetXXXXXXXXXXXXXXXXWdnemQ';

// Legacy alias
const BURN_ADDRESS_ISSUE = BURN_ADDRESS_MAINNET;

// Asset creation cost (500 RVN in satoshis)
const ASSET_CREATION_COST = 500 * 1e8; // 50,000,000,000 satoshis

// Minimum output value (dust threshold)
const DUST_THRESHOLD = 546; // satoshis

// Default fee rate (satoshis per byte)
const DEFAULT_FEE_RATE = 1000; // 1000 sat/byte is standard for RVN

// Opcodes
const OP = {
  DUP: 0x76,
  HASH160: 0xa9,
  EQUALVERIFY: 0x88,
  CHECKSIG: 0xac,
  RVN_ASSET: 0xc0,
  DROP: 0x75,
  PUSHDATA1: 0x4c,
  PUSHDATA2: 0x4d
};

// ============================================================================
// KEY DERIVATION
// ============================================================================

/**
 * Derive private key and address from mnemonic.
 * Uses BIP44 derivation path for Ravencoin.
 * 
 * @param {string} mnemonic - BIP39 mnemonic phrase
 * @param {number} index - Address index (default 0)
 * @param {Object} network - Network params (default NETWORK_MAINNET)
 * @returns {Object} { privateKey, publicKey, address }
 */
function deriveKeyFromMnemonic(mnemonic, index = 0, network = NETWORK_MAINNET) {
  // Load dependencies
  let bip39, bip32, ecc;
  
  try {
    bip39 = require('bip39');
  } catch (e) {
    throw new Error('bip39 not installed. Run: npm install bip39');
  }
  
  try {
    // Try different bip32 packages
    try {
      const { BIP32Factory } = require('bip32');
      ecc = require('tiny-secp256k1');
      bip32 = BIP32Factory(ecc);
    } catch (e1) {
      // Fallback to older bip32
      bip32 = require('bip32');
    }
  } catch (e) {
    throw new Error('bip32 not installed. Run: npm install bip32 tiny-secp256k1');
  }

  // Mnemonic to seed
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  
  // Derive master key
  const root = bip32.fromSeed(seed);
  
  // Derive child key using RVN path: m/44'/175'/0'/0/index
  const path = `m/44'/175'/0'/0/${index}`;
  const child = root.derivePath(path);
  
  // Get private key (32 bytes)
  const privateKey = child.privateKey;
  
  // Get public key (33 bytes compressed)
  const publicKey = child.publicKey;
  
  // Derive address from public key
  const address = publicKeyToAddress(publicKey, network);
  
  return {
    privateKey,
    publicKey,
    address,
    path
  };
}

/**
 * Scan multiple derivation indices to find addresses with UTXOs.
 * 
 * @param {string} mnemonic - BIP39 mnemonic
 * @param {number} count - Number of addresses to derive
 * @param {Object} network - Network params (default NETWORK_MAINNET)
 * @returns {Array} Array of { privateKey, publicKey, address, path }
 */
function deriveMultipleKeys(mnemonic, count = 20, network = NETWORK_MAINNET) {
  const keys = [];
  
  for (let i = 0; i < count; i++) {
    keys.push(deriveKeyFromMnemonic(mnemonic, i, network));
  }
  
  // Also check change addresses (m/44'/175'/0'/1/x)
  let bip39, bip32;
  try {
    bip39 = require('bip39');
    const { BIP32Factory } = require('bip32');
    const ecc = require('tiny-secp256k1');
    bip32 = BIP32Factory(ecc);
  } catch (e) {
    return keys; // Return what we have
  }
  
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed);
  
  for (let i = 0; i < count; i++) {
    const path = `m/44'/175'/0'/1/${i}`;
    const child = root.derivePath(path);
    keys.push({
        privateKey: child.privateKey,
        publicKey: child.publicKey,
        address: publicKeyToAddress(child.publicKey, network),
        path
      });
  }
  
  return keys;
}

/**
 * Convert public key to Ravencoin address.
 * 
 * @param {Buffer} publicKey - 33-byte compressed public key
 * @param {Object} network - Network params (default NETWORK_MAINNET)
 * @returns {string} Ravencoin address (starts with 'R' on mainnet, 'm'/'n' on testnet)
 */
function publicKeyToAddress(publicKey, network = NETWORK_MAINNET) {
  // SHA256 then RIPEMD160 (Hash160)
  const sha256Hash = crypto.createHash('sha256').update(publicKey).digest();
  const ripemdHash = crypto.createHash('ripemd160').update(sha256Hash).digest();
  
  // Add version byte from network params
  const versionedHash = Buffer.concat([Buffer.from([network.pubKeyHash]), ripemdHash]);
  
  // Double SHA256 for checksum
  const checksum = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(versionedHash).digest())
    .digest()
    .slice(0, 4);
  
  // Combine and encode base58
  const address = Buffer.concat([versionedHash, checksum]);
  
  let bs58;
  try {
    bs58 = require('bs58');
    if (bs58.default) bs58 = bs58.default;
  } catch (e) {
    throw new Error('bs58 not installed');
  }
  
  return bs58.encode(address);
}

/**
 * Decode Ravencoin address to pubkey hash.
 * 
 * @param {string} address - Ravencoin address
 * @returns {Buffer} 20-byte pubkey hash
 */
function addressToPubkeyHash(address) {
  let bs58;
  try {
    bs58 = require('bs58');
    if (bs58.default) bs58 = bs58.default;
  } catch (e) {
    throw new Error('bs58 not installed');
  }
  
  const decoded = bs58.decode(address);
  // Remove version byte (first) and checksum (last 4)
  return Buffer.from(decoded.slice(1, 21));
}

// ============================================================================
// SCRIPT BUILDERS
// ============================================================================

/**
 * Create P2PKH scriptPubKey.
 * 
 * @param {string} address - Ravencoin address
 * @returns {Buffer} scriptPubKey
 */
function createP2PKHScript(address) {
  const pubkeyHash = addressToPubkeyHash(address);
  
  return Buffer.concat([
    Buffer.from([OP.DUP, OP.HASH160, 0x14]),  // OP_DUP OP_HASH160 PUSH(20)
    pubkeyHash,
    Buffer.from([OP.EQUALVERIFY, OP.CHECKSIG]) // OP_EQUALVERIFY OP_CHECKSIG
  ]);
}

/**
 * Create asset issuance script (appended after P2PKH).
 * 
 * Format: OP_RVN_ASSET <length> <payload> OP_DROP
 * Payload: "rvnq" | name_len | name | amount(8) | units | reissuable | has_data | [data]
 * 
 * @param {string} assetName - Asset name (e.g., "SCR_XXXXXX")
 * @param {number} amount - Number of units to issue
 * @param {string|null} dataHex - Optional data field (64-char hex merkle root)
 * @returns {Buffer} Asset script
 */
function createAssetScript(assetName, amount, dataHex = null) {
  const nameBuffer = Buffer.from(assetName, 'ascii');
  
  // Amount in satoshis (8-byte little-endian)
  // For asset units, 1 unit = 1e8 satoshis
  const amountSats = BigInt(Math.floor(amount * 1e8));
  const amountBuffer = Buffer.alloc(8);
  amountBuffer.writeBigUInt64LE(amountSats);
  
  // Asset metadata
  const units = 0;        // 0 = indivisible
  const reissuable = 0;   // 0 = not reissuable (permanent)
  const hasData = dataHex ? 1 : 0;
  
  // Build payload
  const parts = [
    Buffer.from('rvnq', 'ascii'),           // Header for new asset
    Buffer.from([nameBuffer.length]),        // Name length
    nameBuffer,                              // Asset name
    amountBuffer,                            // Amount (8 bytes LE)
    Buffer.from([units]),                    // Divisibility (0 = indivisible)
    Buffer.from([reissuable]),               // Reissuable flag (0 = no)
    Buffer.from([hasData])                   // Has data flag
  ];
  
  // Add data field if present (merkle root as raw bytes)
  // Add data field if present (merkle root wrapped as IPFS multihash)
  if (dataHex) {
    // Convert 64-char hex to 32 bytes
    const rawData = Buffer.from(dataHex, 'hex');
    // Wrap with Ravencoin hash prefix: 0x54 0x20 + data
    const multihash = Buffer.concat([
      Buffer.from([0x54, 0x20]),
      rawData
    ]);
    parts.push(multihash);
  }
  
  const payload = Buffer.concat(parts);
  
  // Build push operation
  let pushOp;
  if (payload.length < 76) {
    pushOp = Buffer.from([payload.length]);
  } else if (payload.length < 256) {
    pushOp = Buffer.from([OP.PUSHDATA1, payload.length]);
  } else {
    pushOp = Buffer.alloc(3);
    pushOp[0] = OP.PUSHDATA2;
    pushOp.writeUInt16LE(payload.length, 1);
  }
  
  // Complete script: OP_RVN_ASSET <push> <payload> OP_DROP
  return Buffer.concat([
    Buffer.from([OP.RVN_ASSET]),
    pushOp,
    payload,
    Buffer.from([OP.DROP])
  ]);
}

/**
 * Create ownership token script.
 * Ownership tokens have "!" suffix and grant reissuance rights.
 * 
 * @param {string} assetName - Base asset name (without "!")
 * @returns {Buffer} Ownership token script
 */
/**
 * Create ownership token script.
 * Ownership tokens have "!" suffix and grant reissuance rights.
 * Format is simpler than asset script - just header + name.
 * 
 * @param {string} assetName - Base asset name (without "!")
 * @returns {Buffer} Ownership token script
 */
function createOwnershipScript(assetName) {
  const ownerName = assetName + '!';
  const nameBuffer = Buffer.from(ownerName, 'ascii');
  
  // Ownership token payload is ONLY: header + name_len + name
  const payload = Buffer.concat([
    Buffer.from('rvno', 'ascii'),
    Buffer.from([nameBuffer.length]),
    nameBuffer
  ]);
  
  let pushOp;
  if (payload.length < 76) {
    pushOp = Buffer.from([payload.length]);
  } else {
    pushOp = Buffer.from([OP.PUSHDATA1, payload.length]);
  }
  
  return Buffer.concat([
    Buffer.from([OP.RVN_ASSET]),
    pushOp,
    payload,
    Buffer.from([OP.DROP])
  ]);
}

/**
 * Create complete scriptPubKey for asset output.
 * Combines P2PKH locking with asset script.
 * 
 * @param {string} address - Destination address
 * @param {string} assetName - Asset name
 * @param {number} amount - Asset amount
 * @param {string|null} dataHex - Optional data (merkle root)
 * @returns {Buffer} Complete scriptPubKey
 */
function createAssetOutputScript(address, assetName, amount, dataHex = null) {
  const p2pkh = createP2PKHScript(address);
  const asset = createAssetScript(assetName, amount, dataHex);
  return Buffer.concat([p2pkh, asset]);
}

/**
 * Create complete scriptPubKey for ownership token output.
 * 
 * @param {string} address - Destination address
 * @param {string} assetName - Base asset name (without "!")
 * @returns {Buffer} Complete scriptPubKey
 */
function createOwnershipOutputScript(address, assetName) {
  const p2pkh = createP2PKHScript(address);
  const ownership = createOwnershipScript(assetName);
  return Buffer.concat([p2pkh, ownership]);
}

// ============================================================================
// TRANSACTION BUILDER
// ============================================================================

/**
 * Build an asset issuance transaction.
 * 
 * Structure:
 *   Input(s): UTXOs from wallet (must cover 500 RVN + fee)
 *   Output 0: 500 RVN to burn address
 *   Output 1: Asset (1 unit) to self with merkle root data
 *   Output 2: Ownership token to self
 *   Output 3: Change to self
 * 
 * @param {Object} params - Transaction parameters
 * @param {string} params.assetName - Asset name (e.g., "SCR_XXXXXX")
 * @param {string} params.merkleRoot - 64-char hex merkle root
 * @param {string} params.address - Wallet address (for asset receipt and change)
 * @param {Array} params.utxos - Available UTXOs [{ txid, vout, value }]
 * @param {number} params.feeRate - Fee rate in sat/byte (default 1000)
 * @param {Object} params.network - Network params (default NETWORK_MAINNET)
 * @returns {Object} { inputs, outputs, estimatedSize, totalFee }
 */
function buildAssetIssuanceTx(params) {
  const {
    assetName,
    merkleRoot,
    address,
    utxos,
    feeRate = DEFAULT_FEE_RATE,
    network = NETWORK_MAINNET
  } = params;
  
  // Select correct burn address for this network
  const burnAddress = (network === NETWORK_TESTNET || network?.pubKeyHash === NETWORK_TESTNET.pubKeyHash)
    ? BURN_ADDRESS_TESTNET
    : BURN_ADDRESS_MAINNET;
  
  // Validate inputs
  if (!/^SCR_[A-F0-9]{6}$/.test(assetName)) {
    throw new Error('Invalid asset name format. Expected: SCR_XXXXXX');
  }
  
  if (!/^[0-9a-fA-F]{64}$/.test(merkleRoot)) {
    throw new Error('Invalid merkle root. Expected 64-character hex string.');
  }
  
  if (!utxos || utxos.length === 0) {
    throw new Error('No UTXOs provided');
  }
  
  // Calculate output scripts
  const burnScript = createP2PKHScript(burnAddress);
  const assetScript = createAssetOutputScript(address, assetName, 1, merkleRoot);
  const ownershipScript = createOwnershipOutputScript(address, assetName);
  const changeScript = createP2PKHScript(address);
  
  // Build outputs
  const outputs = [
    {
      value: ASSET_CREATION_COST,
      script: burnScript,
      purpose: 'burn'
    },
    {
      value: 0,
      script: ownershipScript,
      purpose: 'ownership'
    },
    {
      value: 0,
      script: assetScript,
      purpose: 'asset'
    }
    // Change output added below
  ];
  
  // Estimate transaction size
  // Base size: 10 bytes (version + locktime + input/output counts)
  // Per input: ~148 bytes (outpoint + scriptsig + sequence)
  // Per output: 8 (value) + varint + script length
  const baseSize = 10;
  const inputSize = 148; // Approximate for P2PKH
  const outputSizes = outputs.map(o => 8 + 1 + o.script.length);
  const changeOutputSize = 8 + 1 + changeScript.length;
  
  // Select UTXOs to cover 500 RVN + estimated fee
  let selectedUtxos = [];
  let totalInput = 0;
  
  // Sort UTXOs by value descending
  const sortedUtxos = [...utxos].sort((a, b) => b.value - a.value);
  
  // Estimate minimum needed (500 RVN + fee buffer)
  const minNeeded = ASSET_CREATION_COST + (feeRate * 500); // ~500 byte estimate
  
  for (const utxo of sortedUtxos) {
    selectedUtxos.push(utxo);
    totalInput += utxo.value;
    
    // Calculate current estimated size
    const currentSize = baseSize + 
      (selectedUtxos.length * inputSize) + 
      outputSizes.reduce((a, b) => a + b, 0) + 
      changeOutputSize;
    
    const estimatedFee = currentSize * feeRate;
    const needed = ASSET_CREATION_COST + estimatedFee;
    
    if (totalInput >= needed + DUST_THRESHOLD) {
      break;
    }
  }
  
  // Final size calculation
  const finalSize = baseSize + 
    (selectedUtxos.length * inputSize) + 
    outputSizes.reduce((a, b) => a + b, 0) + 
    changeOutputSize;
  
  const totalFee = finalSize * feeRate;
  const change = totalInput - ASSET_CREATION_COST - totalFee;
  
  if (change < 0) {
    throw new Error(`Insufficient funds. Need ${(ASSET_CREATION_COST + totalFee) / 1e8} RVN, have ${totalInput / 1e8} RVN`);
  }
  
  // Add change output if above dust
  if (change >= DUST_THRESHOLD) {
    outputs.push({
      value: change,
      script: changeScript,
      purpose: 'change'
    });
  }
  
  return {
    inputs: selectedUtxos,
    outputs,
    estimatedSize: finalSize,
    totalFee,
    totalInput,
    change: change >= DUST_THRESHOLD ? change : 0
  };
}

// ============================================================================
// TRANSACTION SERIALIZATION
// ============================================================================

/**
 * Serialize a transaction for signing or broadcast.
 * 
 * @param {Array} inputs - Transaction inputs
 * @param {Array} outputs - Transaction outputs
 * @param {number} version - Transaction version (default 1)
 * @param {number} locktime - Locktime (default 0)
 * @returns {Buffer} Serialized transaction
 */
function serializeTransaction(inputs, outputs, version = 1, locktime = 0) {
  const parts = [];
  
  // Version (4 bytes, little-endian)
  const versionBuf = Buffer.alloc(4);
  versionBuf.writeUInt32LE(version);
  parts.push(versionBuf);
  
  // Input count (varint)
  parts.push(encodeVarInt(inputs.length));
  
  // Inputs
  for (const input of inputs) {
    // Previous output txid (32 bytes, reversed)
    const txidBuf = Buffer.from(input.txid, 'hex').reverse();
    parts.push(txidBuf);
    
    // Previous output index (4 bytes, little-endian)
    const voutBuf = Buffer.alloc(4);
    voutBuf.writeUInt32LE(input.vout);
    parts.push(voutBuf);
    
    // ScriptSig (for unsigned tx, use empty or placeholder)
    if (input.scriptSig) {
      parts.push(encodeVarInt(input.scriptSig.length));
      parts.push(input.scriptSig);
    } else {
      parts.push(Buffer.from([0x00])); // Empty scriptSig
    }
    
    // Sequence (4 bytes)
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeUInt32LE(input.sequence || 0xffffffff);
    parts.push(seqBuf);
  }
  
  // Output count (varint)
  parts.push(encodeVarInt(outputs.length));
  
  // Outputs
  for (const output of outputs) {
    // Value (8 bytes, little-endian)
    const valueBuf = Buffer.alloc(8);
    valueBuf.writeBigUInt64LE(BigInt(output.value));
    parts.push(valueBuf);
    
    // ScriptPubKey
    parts.push(encodeVarInt(output.script.length));
    parts.push(output.script);
  }
  
  // Locktime (4 bytes, little-endian)
  const locktimeBuf = Buffer.alloc(4);
  locktimeBuf.writeUInt32LE(locktime);
  parts.push(locktimeBuf);
  
  return Buffer.concat(parts);
}

/**
 * Encode variable-length integer.
 * 
 * @param {number} n - Integer to encode
 * @returns {Buffer} Encoded varint
 */
function encodeVarInt(n) {
  if (n < 0xfd) {
    return Buffer.from([n]);
  } else if (n <= 0xffff) {
    const buf = Buffer.alloc(3);
    buf[0] = 0xfd;
    buf.writeUInt16LE(n, 1);
    return buf;
  } else if (n <= 0xffffffff) {
    const buf = Buffer.alloc(5);
    buf[0] = 0xfe;
    buf.writeUInt32LE(n, 1);
    return buf;
  } else {
    const buf = Buffer.alloc(9);
    buf[0] = 0xff;
    buf.writeBigUInt64LE(BigInt(n), 1);
    return buf;
  }
}

/**
 * Create signature hash for input.
 * Uses SIGHASH_ALL (0x01).
 * 
 * @param {Buffer} txSerialized - Serialized transaction (with scriptSig placeholder)
 * @param {number} inputIndex - Index of input to sign
 * @param {Buffer} prevScriptPubKey - Previous output's scriptPubKey
 * @param {number} sighashType - Sighash type (default SIGHASH_ALL = 1)
 * @returns {Buffer} 32-byte signature hash
 */
function signatureHash(txSerialized, inputIndex, prevScriptPubKey, sighashType = 1) {
  // For proper signing, we need to:
  // 1. Clear all input scriptSigs
  // 2. Insert the prevScriptPubKey into the signing input
  // 3. Append sighash type (4 bytes)
  // 4. Double SHA256
  
  // This is a simplified version - for production, use bitcoinjs-lib
  // Here we assume the transaction is already in signing form
  
  const sighashBuf = Buffer.alloc(4);
  sighashBuf.writeUInt32LE(sighashType);
  
  const toHash = Buffer.concat([txSerialized, sighashBuf]);
  
  const hash1 = crypto.createHash('sha256').update(toHash).digest();
  const hash2 = crypto.createHash('sha256').update(hash1).digest();
  
  return hash2;
}

// ============================================================================
// SIGNING
// ============================================================================

/**
 * Sign a transaction input.
 * 
 * @param {Buffer} sigHash - 32-byte signature hash
 * @param {Buffer} privateKey - 32-byte private key
 * @returns {Buffer} DER-encoded signature with SIGHASH_ALL appended
 */
function signInput(sigHash, privateKey) {
  let ecc;
  try {
    ecc = require('tiny-secp256k1');
  } catch (e) {
    throw new Error('tiny-secp256k1 not installed. Run: npm install tiny-secp256k1');
  }
  
  // Sign with ECDSA
  const signature = ecc.sign(sigHash, privateKey);
  
  // Convert to DER format
  const derSignature = signatureToDER(signature);
  
  // Append SIGHASH_ALL (0x01)
  return Buffer.concat([derSignature, Buffer.from([0x01])]);
}

/**
 * Convert compact signature to DER format with low-S normalization.
 * 
 * BIP 62 requires signatures to use low-S values (S must be in lower half
 * of the curve order). Signatures with high-S are valid mathematically but
 * rejected by Bitcoin/Ravencoin nodes as non-standard.
 * 
 * @param {Buffer} signature - 64-byte compact signature
 * @returns {Buffer} DER-encoded signature with low-S
 */
function signatureToDER(signature) {
  const r = signature.slice(0, 32);
  let s = signature.slice(32, 64);
  
  // ==========================================================================
  // BIP 62: Enforce low-S signature
  // ==========================================================================
  // secp256k1 curve order
  const ORDER = Buffer.from(
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141', 'hex'
  );
  // Half of the curve order
  const HALF_ORDER = Buffer.from(
    '7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0', 'hex'
  );
  
  // Compare S to half order (if S > HALF_ORDER, we need to negate it)
  if (Buffer.compare(s, HALF_ORDER) > 0) {
    // S is in the upper half, negate it: newS = ORDER - S
    const sBigInt = BigInt('0x' + s.toString('hex'));
    const orderBigInt = BigInt('0x' + ORDER.toString('hex'));
    const newS = orderBigInt - sBigInt;
    s = Buffer.from(newS.toString(16).padStart(64, '0'), 'hex');
  }
  
  // ==========================================================================
  // DER encoding
  // ==========================================================================
  function encodeDERInt(buf) {
    // Remove leading zeros but keep one if high bit is set
    let i = 0;
    while (i < buf.length - 1 && buf[i] === 0) i++;
    let result = buf.slice(i);
    
    // If high bit is set, prepend 0x00
    if (result[0] & 0x80) {
      result = Buffer.concat([Buffer.from([0x00]), result]);
    }
    
    return Buffer.concat([
      Buffer.from([0x02, result.length]),
      result
    ]);
  }
  
  const rDer = encodeDERInt(r);
  const sDer = encodeDERInt(s);
  
  const totalLen = rDer.length + sDer.length;
  
  return Buffer.concat([
    Buffer.from([0x30, totalLen]),
    rDer,
    sDer
  ]);
}

/**
 * Build scriptSig for P2PKH input.
 * 
 * @param {Buffer} signature - DER signature with sighash byte
 * @param {Buffer} publicKey - 33-byte compressed public key
 * @returns {Buffer} scriptSig
 */
function buildScriptSig(signature, publicKey) {
  return Buffer.concat([
    Buffer.from([signature.length]),
    signature,
    Buffer.from([publicKey.length]),
    publicKey
  ]);
}

// ============================================================================
// HIGH-LEVEL TRANSACTION BUILDER
// ============================================================================

/**
 * Build and sign a complete asset issuance transaction.
 * 
 * @param {Object} params
 * @param {string} params.assetName - Asset name (SCR_XXXXXX)
 * @param {string} params.merkleRoot - 64-char hex merkle root
 * @param {string} params.mnemonic - BIP39 mnemonic for signing
 * @param {Array} params.utxos - Available UTXOs with address info
 * @param {number} params.feeRate - Fee rate in sat/byte
 * @param {Object} params.network - Network params (default NETWORK_MAINNET)
 * @returns {Object} { txHex, txid, details }
 */
async function buildAndSignAssetTx(params) {
  const {
    assetName,
    merkleRoot,
    mnemonic,
    utxos,
    feeRate = DEFAULT_FEE_RATE,
    network = NETWORK_MAINNET
  } = params;
  
  // Derive keys from mnemonic using correct network
  const keys = deriveMultipleKeys(mnemonic, 10, network);
  
  // Find which key corresponds to each UTXO
  const keyMap = new Map();
  for (const key of keys) {
    keyMap.set(key.address, key);
  }
  
  // Filter UTXOs to only those we have keys for
  const usableUtxos = utxos.filter(utxo => keyMap.has(utxo.address));
  
  if (usableUtxos.length === 0) {
    throw new Error('No UTXOs found for derived addresses');
  }
  
  // Use first address with UTXOs as destination
  const destinationAddress = usableUtxos[0].address;
  
  // Build unsigned transaction
  const txPlan = buildAssetIssuanceTx({
    assetName,
    merkleRoot,
    address: destinationAddress,
    utxos: usableUtxos,
    feeRate,
    network
  });
  
  console.log(`[ASSET-ENCODER] Building TX with ${txPlan.inputs.length} inputs, ${txPlan.outputs.length} outputs`);
  console.log(`[ASSET-ENCODER] Fee: ${txPlan.totalFee / 1e8} RVN, Change: ${txPlan.change / 1e8} RVN`);
  
  // For each input, we need to sign it
  const signedInputs = [];
  
  for (let i = 0; i < txPlan.inputs.length; i++) {
    const input = txPlan.inputs[i];
    const key = keyMap.get(input.address);
    
    if (!key) {
      throw new Error(`No key found for input address: ${input.address}`);
    }
    
    // Get previous scriptPubKey
    const prevScriptPubKey = createP2PKHScript(input.address);
    
    // Build the transaction for signing this input
    // (with prevScriptPubKey in place of scriptSig for the signing input)
    const txForSigning = buildTxForSigning(txPlan, i, prevScriptPubKey);
    
    // Calculate signature hash
    const sigHash = signatureHash(txForSigning, i, prevScriptPubKey, 1);
    
    // Sign
    const signature = signInput(sigHash, key.privateKey);
    
    // Build scriptSig
    const scriptSig = buildScriptSig(signature, key.publicKey);
    
    signedInputs.push({
      ...input,
      scriptSig
    });
  }
  
  // Serialize final transaction
  const finalTx = serializeTransaction(signedInputs, txPlan.outputs, 2);
  const txHex = finalTx.toString('hex');
  
  // Calculate txid (double SHA256, reversed)
  const txid = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(finalTx).digest())
    .digest()
    .reverse()
    .toString('hex');
  
  return {
    txHex,
    txid,
    details: {
      inputs: txPlan.inputs.length,
      outputs: txPlan.outputs.length,
      size: finalTx.length,
      fee: txPlan.totalFee,
      feeRate,
      assetName,
      merkleRoot,
      burnAmount: ASSET_CREATION_COST,
      change: txPlan.change
    }
  };
}

/**
 * Build transaction serialization for signing a specific input.
 * 
 * @param {Object} txPlan - Transaction plan from buildAssetIssuanceTx
 * @param {number} inputIndex - Index of input being signed
 * @param {Buffer} scriptCode - Script to place in signing input
 * @returns {Buffer} Transaction ready for signature hash
 */
function buildTxForSigning(txPlan, inputIndex, scriptCode) {
  const inputs = txPlan.inputs.map((input, i) => ({
    txid: input.txid,
    vout: input.vout,
    scriptSig: i === inputIndex ? scriptCode : Buffer.alloc(0),
    sequence: 0xffffffff
  }));
  
  return serializeTransaction(inputs, txPlan.outputs);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Key derivation
  deriveKeyFromMnemonic,
  deriveMultipleKeys,
  publicKeyToAddress,
  addressToPubkeyHash,
  
  // Script builders
  createP2PKHScript,
  createAssetScript,
  createOwnershipScript,
  createAssetOutputScript,
  createOwnershipOutputScript,
  
  // Transaction building
  buildAssetIssuanceTx,
  buildAndSignAssetTx,
  serializeTransaction,
  
  // Network constants
  NETWORK,               // Legacy alias → NETWORK_MAINNET
  NETWORK_MAINNET,
  NETWORK_TESTNET,

  // Burn addresses
  BURN_ADDRESS_ISSUE,    // Legacy alias → BURN_ADDRESS_MAINNET
  BURN_ADDRESS_MAINNET,
  BURN_ADDRESS_TESTNET,

  // Other constants
  ASSET_CREATION_COST,
  DUST_THRESHOLD,
  DEFAULT_FEE_RATE,
  DERIVATION_PATH
};
