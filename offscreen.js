/**
 * Offscreen Document - RAM Shard Handler
 * 
 * Each offscreen document runs in its own renderer process, 
 * allowing us to bypass Chrome's per-process memory limit.
 * 
 * This script handles:
 * 1. Allocating a portion of RAM (up to 8GB)
 * 2. Responding to challenge requests for its offset range
 * 3. Keeping memory alive to prevent GC
 */

import { sha256 } from './crypto.js';

// Shard configuration (set by background.js when creating this document)
let shardId = null;
let shardSizeGB = 0;
let shardStartOffset = 0;
let memory = [];
let initialized = false;

const CHUNK_SIZE_GB = 1; // Allocate in 1GB chunks within the shard
const CHUNK_SIZE_BYTES = CHUNK_SIZE_GB * 1024 * 1024 * 1024;

/**
 * Initialize this shard's memory allocation
 */
async function initializeShard(config) {
    shardId = config.shardId;
    shardSizeGB = config.shardSizeGB;
    shardStartOffset = config.shardStartOffset;

    console.log(`[Shard ${shardId}] Initializing ${shardSizeGB}GB...`);

    try {
        const numChunks = shardSizeGB;
        memory = [];

        for (let i = 0; i < numChunks; i++) {
            console.log(`[Shard ${shardId}] Allocating chunk ${i + 1}/${numChunks}...`);

            const chunk = new ArrayBuffer(CHUNK_SIZE_BYTES);
            memory.push(chunk);

            // Touch pages to force allocation
            const view = new Uint8Array(chunk);
            const pageSize = 4096;
            for (let offset = 0; offset < CHUNK_SIZE_BYTES; offset += pageSize) {
                view[offset] = (shardId * 17 + offset / pageSize) % 256;
            }

            console.log(`[Shard ${shardId}] ✅ Chunk ${i + 1} allocated`);
        }

        initialized = true;

        // Start keep-alive loop
        startKeepAlive();

        console.log(`[Shard ${shardId}] ✅ Successfully allocated ${shardSizeGB}GB!`);
        return { success: true, shardId, allocatedGB: shardSizeGB };

    } catch (error) {
        console.error(`[Shard ${shardId}] ❌ Allocation failed:`, error);
        return { success: false, shardId, error: error.message };
    }
}

/**
 * Keep memory alive by periodically touching it
 */
function startKeepAlive() {
    setInterval(() => {
        if (!memory || memory.length === 0) return;

        const chunkIndex = Math.floor(Math.random() * memory.length);
        const chunk = memory[chunkIndex];
        const view = new Uint8Array(chunk);
        const randomOffset = Math.floor(Math.random() * (chunk.byteLength - 4096));
        view[randomOffset] = (view[randomOffset] + 1) % 256;
    }, 10000);
}

/**
 * Handle a PoRAM challenge for this shard's offset range
 */
async function handleChallenge(challenge) {
    const startTime = performance.now();

    console.log(`[Shard ${shardId}] Processing challenge:`, challenge.challenge_id);

    try {
        const { epoch_seed, offsets, chunk_size } = challenge;
        const chunks = [];

        for (const offset of offsets) {
            const chunk = await generateChunk(epoch_seed, offset, chunk_size);
            chunks.push(chunk);
        }

        const responseTime = Math.floor(performance.now() - startTime);

        console.log(`[Shard ${shardId}] Challenge completed in ${responseTime}ms`);

        return {
            success: true,
            challenge_id: challenge.challenge_id,
            chunks: chunks,
            response_time_ms: responseTime
        };

    } catch (error) {
        console.error(`[Shard ${shardId}] Challenge error:`, error);
        return {
            success: false,
            challenge_id: challenge.challenge_id,
            chunks: [],
            response_time_ms: 0,
            error: error.message
        };
    }
}

/**
 * Generate chunk data matching coordinator's algorithm
 */
async function generateChunk(epochSeedHex, offset, chunkSize) {
    const epochSeed = hexToBytes(epochSeedHex);
    const chunkData = new Uint8Array(chunkSize);
    let currentOffset = offset;
    let writePos = 0;

    while (writePos < chunkSize) {
        const offsetBytes = numberToBytes(currentOffset, 8);
        const input = new Uint8Array([...epochSeed, ...offsetBytes]);
        const hashBytes = await sha256(input);

        const remaining = chunkSize - writePos;
        const copyLen = Math.min(32, remaining);

        chunkData.set(hashBytes.subarray(0, copyLen), writePos);
        writePos += copyLen;
        currentOffset += copyLen;
    }

    return arrayToBase64(chunkData);
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
}

function numberToBytes(num, byteCount) {
    const bytes = new Uint8Array(byteCount);
    for (let i = byteCount - 1; i >= 0; i--) {
        bytes[i] = num & 0xff;
        num = Math.floor(num / 256);
    }
    return bytes;
}

function arrayToBase64(array) {
    let binary = '';
    const len = array.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(array[i]);
    }
    return btoa(binary);
}

/**
 * Get shard statistics
 */
function getStats() {
    return {
        shardId,
        shardSizeGB,
        shardStartOffset,
        initialized,
        memoryChunks: memory.length
    };
}

/**
 * Message handler from background.js
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`[Shard ${shardId || 'uninitialized'}] Received message:`, message.type);

    (async () => {
        switch (message.type) {
            case 'shard_init':
                const initResult = await initializeShard(message.config);
                sendResponse(initResult);
                break;

            case 'shard_challenge':
                const challengeResult = await handleChallenge(message.challenge);
                sendResponse(challengeResult);
                break;

            case 'shard_stats':
                sendResponse(getStats());
                break;

            case 'shard_ping':
                sendResponse({ alive: true, shardId, initialized });
                break;

            default:
                console.warn(`[Shard ${shardId}] Unknown message type:`, message.type);
                sendResponse({ error: 'Unknown message type' });
        }
    })();

    return true; // Keep channel open for async response
});

console.log('[OffscreenShard] Loaded and ready for initialization');
