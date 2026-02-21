/**
 * Cryptographic utilities for Sui blockchain integration
 * Uses Web Crypto API for Ed25519 signatures
 */

/**
 * Generate a new Ed25519 keypair for Sui wallet
 * @returns {Promise<{privateKey: string, publicKey: string, address: string}>}
 */
export async function generateSuiKeypair() {
    const keyPair = await crypto.subtle.generateKey(
        {
            name: "Ed25519",
            namedCurve: "Ed25519"
        },
        true,
        ["sign", "verify"]
    );

    const privateKeyRaw = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const publicKeyRaw = await crypto.subtle.exportKey("spki", keyPair.publicKey);

    // Extract the 32-byte private key from PKCS#8 format
    const privateKeyBytes = new Uint8Array(privateKeyRaw).slice(-32);
    const publicKeyBytes = new Uint8Array(publicKeyRaw).slice(-32);

    // Sui address = 0x + blake2b(0x00 || publicKey)[0:32]
    const address = await deriveSuiAddress(publicKeyBytes);

    return {
        privateKey: arrayToHex(privateKeyBytes),
        publicKey: arrayToHex(publicKeyBytes),
        address: address
    };
}

/**
 * Import a private key (hex string) and derive public key and address
 * @param {string} privateKeyHex - 64 character hex string
 * @returns {Promise<{privateKey: string, publicKey: string, address: string}>}
 */
export async function importSuiPrivateKey(privateKeyHex) {
    const privateKeyBytes = hexToArray(privateKeyHex);

    // Import the private key
    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        toPKCS8(privateKeyBytes),
        {
            name: "Ed25519",
            namedCurve: "Ed25519"
        },
        true,
        ["sign"]
    );

    // Derive public key from private key
    const keyPair = await crypto.subtle.generateKey(
        {
            name: "Ed25519",
            namedCurve: "Ed25519"
        },
        true,
        ["sign", "verify"]
    );

    // For Ed25519, we need to compute the public key from private key
    // This is a simplified approach - in production, use a proper library
    const publicKeyBytes = await derivePublicKeyFromPrivate(privateKeyBytes);
    const address = await deriveSuiAddress(publicKeyBytes);

    return {
        privateKey: privateKeyHex,
        publicKey: arrayToHex(publicKeyBytes),
        address: address
    };
}

/**
 * Sign a message with Sui private key
 * @param {string} message - Message to sign
 * @param {string} privateKeyHex - Private key in hex
 * @returns {Promise<string>} - Hex-encoded signature
 */
export async function signMessage(message, privateKeyHex) {
    const privateKeyBytes = hexToArray(privateKeyHex);
    const messageBytes = new TextEncoder().encode(message);

    // Import private key for signing
    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        toPKCS8(privateKeyBytes),
        {
            name: "Ed25519",
            namedCurve: "Ed25519"
        },
        false,
        ["sign"]
    );

    // Sign the message
    const signature = await crypto.subtle.sign(
        {
            name: "Ed25519"
        },
        privateKey,
        messageBytes
    );

    return arrayToHex(new Uint8Array(signature));
}

/**
 * Verify a signature
 * @param {string} message - Original message
 * @param {string} signatureHex - Signature in hex
 * @param {string} publicKeyHex - Public key in hex
 * @returns {Promise<boolean>}
 */
export async function verifySignature(message, signatureHex, publicKeyHex) {
    const publicKeyBytes = hexToArray(publicKeyHex);
    const signatureBytes = hexToArray(signatureHex);
    const messageBytes = new TextEncoder().encode(message);

    const publicKey = await crypto.subtle.importKey(
        "spki",
        toSPKI(publicKeyBytes),
        {
            name: "Ed25519",
            namedCurve: "Ed25519"
        },
        false,
        ["verify"]
    );

    return await crypto.subtle.verify(
        {
            name: "Ed25519"
        },
        publicKey,
        signatureBytes,
        messageBytes
    );
}

/**
 * Derive Sui address from public key
 * @param {Uint8Array} publicKeyBytes - 32-byte Ed25519 public key
 * @returns {Promise<string>} - Sui address (0x + 64 hex chars)
 */
async function deriveSuiAddress(publicKeyBytes) {
    // Sui address = 0x + blake2b(flag || publicKey)[0:32]
    // flag = 0x00 for Ed25519
    const flag = new Uint8Array([0x00]);
    const data = new Uint8Array([...flag, ...publicKeyBytes]);

    // Use SHA-256 as fallback (blake2b not in Web Crypto API)
    // In production, use @noble/hashes or similar for blake2b
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);

    // Take first 32 bytes and convert to hex
    const address = '0x' + arrayToHex(hashArray.slice(0, 32));
    return address;
}

/**
 * Derive public key from private key (Ed25519)
 * Simplified version - in production use proper Ed25519 library
 */
async function derivePublicKeyFromPrivate(privateKeyBytes) {
    // For Ed25519, public key is derived from private key
    // This requires proper Ed25519 implementation
    // For now, we'll use a placeholder that requires full keypair generation

    // In a real implementation, you'd use @noble/ed25519 or similar
    throw new Error("Use generateSuiKeypair() to create a new keypair, or provide both keys");
}

/**
 * Convert Uint8Array to hex string
 */
function arrayToHex(array) {
    return Array.from(array)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Convert hex string to Uint8Array
 */
function hexToArray(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

/**
 * Wrap raw Ed25519 private key in PKCS#8 format
 */
function toPKCS8(privateKeyBytes) {
    // PKCS#8 wrapper for Ed25519 private key
    const pkcs8Prefix = new Uint8Array([
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
        0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
    ]);
    return new Uint8Array([...pkcs8Prefix, ...privateKeyBytes]);
}

/**
 * Wrap raw Ed25519 public key in SPKI format
 */
function toSPKI(publicKeyBytes) {
    // SPKI wrapper for Ed25519 public key
    const spkiPrefix = new Uint8Array([
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65,
        0x70, 0x03, 0x21, 0x00
    ]);
    return new Uint8Array([...spkiPrefix, ...publicKeyBytes]);
}

/**
 * Generate a random hex string of specified byte length
 */
export function generateRandomHex(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return arrayToHex(bytes);
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
 * Generate a UUID v4
 */
export function generateUUID() {
    return crypto.randomUUID();
}
