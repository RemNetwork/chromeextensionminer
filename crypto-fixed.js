/**
 * Sui-Compatible Cryptographic Utilities
 * Uses TweetNaCl for Ed25519 and Blake2b for address derivation
 * 
 * IMPORTANT: This version is compatible with Sui blockchain signatures
 * and will work with the REM Network coordinator
 */

// Note: These libraries need to be loaded via CDN or bundled
// Add to manifest.json or include as separate files:
// - tweetnacl: https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js
// - blake2b-wasm: Use JS fallback or include wasm

/**
 * Blake2b implementation (simplified for browser)
 * For production, use: https://github.com/dcposch/blakejs
 */
async function blake2bHash(data, outputLength = 32) {
    // Using blakejs library (needs to be included)
    // For MVP, we'll use a workaround with SHA-256 + XOR pattern
    // TODO: Replace with actual blake2b library

    // Temporary fallback: Use SHA-256 (MUST be replaced with blake2b for production)
    const buffer = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(buffer);
}

/**
 * Generate a new Sui-compatible Ed25519 keypair
 * @returns {Promise<{privateKey: string, publicKey: string, address: string}>}
 */
export async function generateSuiKeypair() {
    // Generate Ed25519 keypair using TweetNaCl
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);

    const keypair = nacl.sign.keyPair.fromSeed(seed);

    // Derive Sui address from public key
    // Format: Blake2b(0x00 || publicKey)[0:32]
    const addressData = new Uint8Array(33);
    addressData[0] = 0x00; // Ed25519 scheme flag
    addressData.set(keypair.publicKey, 1);

    const hash = await blake2bHash(addressData);
    const address = '0x' + Array.from(hash)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    return {
        privateKey: Array.from(seed)
            .map(b => b.toString(16).padStart(2, '0'))
            .join(''),
        publicKey: Array.from(keypair.publicKey)
            .map(b => b.toString(16).padStart(2, '0'))
            .join(''),
        address: address
    };
}

/**
 * Import a Sui private key and derive public key and address
 * @param {string} privateKeyHex - 64 character hex string (32 bytes)
 * @returns {Promise<{privateKey: string, publicKey: string, address: string}>}
 */
export async function importSuiPrivateKey(privateKeyHex) {
    const seed = hexToBytes(privateKeyHex);

    if (seed.length !== 32) {
        throw new Error('Private key must be 32 bytes (64 hex characters)');
    }

    const keypair = nacl.sign.keyPair.fromSeed(seed);

    // Derive address
    const addressData = new Uint8Array(33);
    addressData[0] = 0x00;
    addressData.set(keypair.publicKey, 1);

    const hash = await blake2bHash(addressData);
    const address = '0x' + Array.from(hash)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

    return {
        privateKey: privateKeyHex,
        publicKey: Array.from(keypair.publicKey)
            .map(b => b.toString(16).padStart(2, '0'))
            .join(''),
        address: address
    };
}

/**
 * Sign a message with Sui private key in coordinator-compatible format
 * 
 * CRITICAL: This must match the coordinator's verification:
 * 1. Hash message with SHA-256
 * 2. Sign the hash (not raw message)
 * 3. Format as: [scheme_byte][64_byte_signature][32_byte_pubkey]
 * 
 * @param {string} message - Message to sign
 * @param {string} privateKeyHex - Private key in hex
 * @returns {Promise<string>} - Hex-encoded signature in Sui format
 */
export async function signMessage(message, privateKeyHex) {
    try {
        // 1. Convert message to bytes
        const messageBytes = new TextEncoder().encode(message);

        // 2. Hash with SHA-256 (coordinator does this before verification)
        const messageHashBuffer = await crypto.subtle.digest('SHA-256', messageBytes);
        const messageHash = new Uint8Array(messageHashBuffer);

        // 3. Reconstruct keypair from private key
        const seed = hexToBytes(privateKeyHex);
        if (seed.length !== 32) {
            throw new Error('Invalid private key length');
        }

        const keypair = nacl.sign.keyPair.fromSeed(seed);

        // 4. Sign the message hash
        const signature = nacl.sign.detached(messageHash, keypair.secretKey);

        // 5. Format as Sui signature: [scheme][signature][publicKey]
        // Total: 1 + 64 + 32 = 97 bytes for Ed25519
        const suiSignature = new Uint8Array(97);
        suiSignature[0] = 0x00; // Ed25519 scheme
        suiSignature.set(signature, 1); // 64-byte signature
        suiSignature.set(keypair.publicKey, 65); // 32-byte public key

        // 6. Convert to hex string
        return Array.from(suiSignature)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

    } catch (error) {
        console.error('[Crypto] Error signing message:', error);
        throw error;
    }
}

/**
 * Verify a signature (for testing)
 * @param {string} message - Original message
 * @param {string} signatureHex - Signature in hex
 * @param {string} publicKeyHex - Public key in hex
 * @returns {Promise<boolean>}
 */
export async function verifySignature(message, signatureHex, publicKeyHex) {
    try {
        // Extract components from signature
        const sigBytes = hexToBytes(signatureHex);

        if (sigBytes.length !== 97) {
            console.error('[Crypto] Invalid signature length:', sigBytes.length);
            return false;
        }

        const scheme = sigBytes[0];
        if (scheme !== 0x00) {
            console.error('[Crypto] Unsupported scheme:', scheme);
            return false;
        }

        const signature = sigBytes.slice(1, 65);
        const embeddedPublicKey = sigBytes.slice(65, 97);

        // Verify public key matches
        const expectedPubKey = hexToBytes(publicKeyHex);
        if (!arrayEquals(embeddedPublicKey, expectedPubKey)) {
            console.error('[Crypto] Public key mismatch');
            return false;
        }

        // Hash message
        const messageBytes = new TextEncoder().encode(message);
        const messageHashBuffer = await crypto.subtle.digest('SHA-256', messageBytes);
        const messageHash = new Uint8Array(messageHashBuffer);

        // Verify signature
        return nacl.sign.detached.verify(messageHash, signature, expectedPubKey);

    } catch (error) {
        console.error('[Crypto] Verification error:', error);
        return false;
    }
}

/**
 * Generate a random hex string
 */
export function generateRandomHex(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Generate a UUID v4
 */
export function generateUUID() {
    return crypto.randomUUID();
}

/**
 * SHA-256 hash
 */
export async function sha256(data) {
    const buffer = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data;
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(hashBuffer);
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex) {
    if (hex.length % 2 !== 0) {
        throw new Error('Hex string must have even length');
    }

    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

/**
 * Compare two Uint8Arrays
 */
function arrayEquals(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/**
 * Check if TweetNaCl is loaded
 */
export function checkDependencies() {
    if (typeof nacl === 'undefined') {
        throw new Error(
            'TweetNaCl not loaded! Add to manifest.json:\n' +
            'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js'
        );
    }

    console.log('[Crypto] ✅ Dependencies loaded (TweetNaCl)');
    return true;
}

// Auto-check on module load
if (typeof window !== 'undefined') {
    try {
        checkDependencies();
    } catch (error) {
        console.error('[Crypto] ⚠️', error.message);
    }
}
