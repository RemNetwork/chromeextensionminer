/**
 * Proof-of-RAM (PoRAM) Manager for Chrome Extension
 * Allocates and maintains RAM, responds to coordinator challenges
 */

import { sha256 } from './crypto.js';

export class PoRAMManager {
    constructor(committedGB) {
        this.committedGB = committedGB;
        this.committedBytes = committedGB * 1024 * 1024 * 1024;
        this.memory = null;
        this.initialized = false;
        this.lastAccessTime = Date.now();
    }

    /**
     * Initialize PoRAM memory allocation
     * Uses MULTIPLE ArrayBuffers to bypass Chrome's single-buffer limit
     * Chrome limit: ~2GB per ArrayBuffer
     * Solution: Split into 1GB chunks
     */
    async initialize() {
        console.log(`[PoRAM] Initializing ${this.committedGB}GB allocation...`);

        try {
            // Split memory into 1GB chunks to bypass Chrome's limit
            const CHUNK_SIZE_GB = 1;
            const CHUNK_SIZE_BYTES = CHUNK_SIZE_GB * 1024 * 1024 * 1024;
            const numChunks = this.committedGB / CHUNK_SIZE_GB;

            console.log(`[PoRAM] Allocating ${numChunks} chunks of ${CHUNK_SIZE_GB}GB each...`);

            this.memory = []; // Array of ArrayBuffers

            // Allocate each chunk
            for (let i = 0; i < numChunks; i++) {
                console.log(`[PoRAM] Allocating chunk ${i + 1}/${numChunks} (${CHUNK_SIZE_GB}GB)...`);

                try {
                    const chunk = new ArrayBuffer(CHUNK_SIZE_BYTES);
                    this.memory.push(chunk);

                    // Touch pages in this chunk
                    const view = new Uint8Array(chunk);
                    const pageSize = 4096;
                    const pagesInChunk = Math.floor(CHUNK_SIZE_BYTES / pageSize);

                    for (let offset = 0; offset < CHUNK_SIZE_BYTES; offset += pageSize) {
                        view[offset] = (offset / pageSize) % 256;
                    }

                    console.log(`[PoRAM] ✅ Chunk ${i + 1} allocated and touched (${pagesInChunk} pages)`);

                } catch (error) {
                    console.error(`[PoRAM] ❌ Failed to allocate chunk ${i + 1}:`, error);
                    throw new Error(`Failed at chunk ${i + 1}: ${error.message}`);
                }
            }

            this.initialized = true;
            this.lastAccessTime = Date.now();

            console.log(`[PoRAM] ✅ Successfully allocated ${this.committedGB}GB across ${numChunks} chunks!`);
            console.log(`[PoRAM] Memory details:`, {
                total_bytes: this.committedBytes,
                total_gb: this.committedGB,
                chunks: numChunks,
                chunk_size_gb: CHUNK_SIZE_GB
            });

            // Start keep-alive loop to prevent garbage collection
            this.startKeepAlive();

        } catch (error) {
            console.error(`[PoRAM] ❌ Failed to allocate ${this.committedGB}GB:`, error);
            throw new Error(
                `Cannot allocate ${this.committedGB}GB RAM. ${error.message}`
            );
        }
    }

    /**
     * Keep-alive loop to prevent memory from being swapped or GC'd
     * Touches a random page in a random chunk
     */
    startKeepAlive() {
        setInterval(() => {
            if (!this.memory || this.memory.length === 0) return;

            // Pick a random chunk
            const chunkIndex = Math.floor(Math.random() * this.memory.length);
            const chunk = this.memory[chunkIndex];
            const view = new Uint8Array(chunk);

            // Touch a random page in that chunk
            const randomOffset = Math.floor(Math.random() * (chunk.byteLength - 4096));
            view[randomOffset] = (view[randomOffset] + 1) % 256;

            this.lastAccessTime = Date.now();
        }, 10000); // Every 10 seconds
    }

    /**
     * Handle PoRAM challenge from coordinator
     * @param {Object} challenge - Challenge request from coordinator
     * @returns {Object} Challenge response with chunks and timing
     */
    async handleChallenge(challenge) {
        const startTime = performance.now();

        console.log('[PoRAM] Received challenge:', {
            id: challenge.challenge_id,
            offsets: challenge.offsets.length,
            chunk_size: challenge.chunk_size,
            deadline_ms: challenge.deadline_ms
        });

        try {
            const { epoch_seed, offsets, chunk_size } = challenge;
            const chunks = [];

            // Generate chunks matching coordinator's algorithm
            for (const offset of offsets) {
                const chunk = await this.generateChunk(epoch_seed, offset, chunk_size);
                chunks.push(chunk);
            }

            const responseTime = Math.floor(performance.now() - startTime);

            console.log('[PoRAM] Challenge completed:', {
                id: challenge.challenge_id,
                chunks: chunks.length,
                response_time_ms: responseTime
            });

            return {
                challenge_id: challenge.challenge_id,
                chunks: chunks,
                response_time_ms: responseTime
            };

        } catch (error) {
            console.error('[PoRAM] Challenge failed:', error);
            return {
                challenge_id: challenge.challenge_id,
                chunks: [],
                response_time_ms: 0
            };
        }
    }

    /**
     * Generate a chunk using the same algorithm as the coordinator
     * MUST match coordinator's compute_expected_value algorithm exactly
     * 
     * @param {string} epochSeedHex - Epoch seed as hex string
     * @param {number} offset - Byte offset for this chunk
     * @param {number} chunkSize - Size of chunk in bytes
     * @returns {string} Base64-encoded chunk data
     */
    async generateChunk(epochSeedHex, offset, chunkSize) {
        // Convert epoch seed from hex to bytes
        const epochSeed = this.hexToBytes(epochSeedHex);

        const chunkData = new Uint8Array(chunkSize);
        let currentOffset = offset;
        let writePos = 0;

        // Generate data by hashing (epoch_seed + offset)
        // This matches the coordinator's algorithm
        while (writePos < chunkSize) {
            // Create seed input: epoch_seed + current_offset (as 8-byte big-endian)
            const offsetBytes = this.numberToBytes(currentOffset, 8);
            const input = new Uint8Array([...epochSeed, ...offsetBytes]);

            // Hash to get 32 bytes
            const hashBytes = await sha256(input);

            // Copy as much as we need
            const remaining = chunkSize - writePos;
            const copyLen = Math.min(32, remaining);

            chunkData.set(hashBytes.subarray(0, copyLen), writePos);
            writePos += copyLen;
            currentOffset += copyLen;
        }

        // Base64 encode the chunk
        return this.arrayToBase64(chunkData);
    }

    /**
     * Convert hex string to Uint8Array
     */
    hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    }

    /**
     * Convert number to big-endian byte array
     */
    numberToBytes(num, byteCount) {
        const bytes = new Uint8Array(byteCount);
        for (let i = byteCount - 1; i >= 0; i--) {
            bytes[i] = num & 0xff;
            num = Math.floor(num / 256);
        }
        return bytes;
    }

    /**
     * Convert Uint8Array to base64 string
     */
    arrayToBase64(array) {
        let binary = '';
        const len = array.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(array[i]);
        }
        return btoa(binary);
    }

    /**
     * Get memory usage statistics
     */
    getStats() {
        return {
            committed_gb: this.committedGB,
            committed_bytes: this.committedBytes,
            initialized: this.initialized,
            last_access: new Date(this.lastAccessTime).toISOString(),
            memory_mb: this.committedBytes / (1024 * 1024)
        };
    }

    /**
     * Cleanup and release memory
     */
    cleanup() {
        console.log('[PoRAM] Cleaning up memory allocation...');
        this.memory = null;
        this.initialized = false;
    }
}
