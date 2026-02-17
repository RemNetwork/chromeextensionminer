/**
 * Offscreen Document Handler
 * Runs in a separate context to allocate memory beyond the 15GB limit
 * Each offscreen document has its own ~15GB memory limit
 */

console.log('[Offscreen] ⚡ Script starting to load...');
console.log('[Offscreen] Document readyState:', document.readyState);
console.log('[Offscreen] chrome.runtime available:', typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined');

// CRITICAL: Set up message listener IMMEDIATELY at the top of the file
// This must happen before any other code executes
console.log('[Offscreen] Setting up message listener FIRST (before anything else)...');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`[Offscreen] 📨 Received message:`, message?.type);

    // Handle ping/pong for connection testing
    if (message && message.type === 'ping') {
        console.log('[Offscreen] 🏓 Responding to ping');
        try {
            const pongResponse = { success: true, type: 'pong' };
            sendResponse(pongResponse);
            console.log('[Offscreen] ✅ Pong sent:', pongResponse);
            return true; // Keep channel open
        } catch (e) {
            console.error('[Offscreen] ❌ Error sending pong:', e);
            return false;
        }
    }

    // Return false for other messages (will be handled below)
    return false;
});

console.log('[Offscreen] ✅ Message listener registered at top level');

// Notify background that we're ready
function notifyReady() {
    console.log('[Offscreen] 📤 Sending offscreen_ready message...');
    try {
        chrome.runtime.sendMessage({ type: 'offscreen_ready' }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('[Offscreen] ❌ Error sending ready:', chrome.runtime.lastError.message);
            } else {
                console.log('[Offscreen] ✅ Successfully sent offscreen_ready');
            }
        });
    } catch (e) {
        console.error('[Offscreen] ❌ Exception sending ready:', e);
    }
}

// Send ready immediately
notifyReady();
setTimeout(notifyReady, 100);
setTimeout(notifyReady, 500);

// Inline sha256 to avoid module import issues
async function sha256(data) {
    const buffer = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(hashBuffer);
}

console.log('[Offscreen] sha256 function defined');

class OffscreenPoRAMManager {
    constructor() {
        this.memory = [];
        this.committedGB = 0;
        this.initialized = false;
        this.contextId = null;
    }

    /**
     * Initialize memory allocation in this offscreen context
     */
    async initialize(allocatedGB, contextId) {
        // If this is a new context, reset memory. Otherwise, accumulate.
        if (this.contextId !== contextId) {
            this.memory = [];
            this.committedGB = 0;
            this.contextId = contextId;
            console.log(`[Offscreen ${contextId}] Starting new context, resetting memory`);
        }
        
        // Accumulate the allocation
        this.committedGB += allocatedGB;
        
        console.log(`[Offscreen ${contextId}] Adding ${allocatedGB}GB allocation (total: ${this.committedGB.toFixed(1)}GB)...`);

        try {
            const CHUNK_SIZE_GB = 0.25; // 256MB chunks
            const CHUNK_SIZE_BYTES = CHUNK_SIZE_GB * 1024 * 1024 * 1024;
            const numChunks = Math.ceil(allocatedGB / CHUNK_SIZE_GB);

            console.log(`[Offscreen ${contextId}] Allocating ${numChunks} chunks of ${CHUNK_SIZE_GB}GB (256MB) each...`);

            // Don't reset memory - accumulate it
            // Calculate current total from existing memory
            const existingChunks = this.memory.length;
            let totalAllocatedGB = existingChunks * CHUNK_SIZE_GB; // Current total from existing memory
            const CHROME_MEMORY_LIMIT_GB = 15;

            console.log(`[Offscreen ${contextId}] Existing memory: ${existingChunks} chunks (${totalAllocatedGB.toFixed(2)}GB), adding ${numChunks} more chunks`);

            for (let i = 0; i < numChunks; i++) {
                const remainingGB = allocatedGB - (i * CHUNK_SIZE_GB);
                const actualChunkGB = Math.min(CHUNK_SIZE_GB, remainingGB);
                const actualChunkBytes = actualChunkGB * 1024 * 1024 * 1024;

                // Check limit BEFORE allocating (with small buffer to account for overhead)
                const limitWithBuffer = CHROME_MEMORY_LIMIT_GB - 0.5; // Leave 0.5GB buffer
                if (totalAllocatedGB + actualChunkGB > limitWithBuffer) {
                    const errorMsg = `Chrome memory limit reached at ~${totalAllocatedGB.toFixed(1)}GB in context ${contextId}. Cannot allocate ${actualChunkGB.toFixed(2)}GB more (limit: ${CHROME_MEMORY_LIMIT_GB}GB)`;
                    console.error(`[Offscreen ${contextId}] ❌ ${errorMsg}`);
                    throw new Error(errorMsg);
                }

                console.log(`[Offscreen ${contextId}] Allocating chunk ${i + 1}/${numChunks} (${actualChunkGB.toFixed(2)}GB)...`);

                try {
                    const chunk = await this.allocateChunkWithTimeout(actualChunkBytes, 30000);
                    this.memory.push(chunk);
                    totalAllocatedGB += actualChunkGB;

                    await this.touchPagesAsync(chunk, actualChunkBytes, i + 1, numChunks);

                    console.log(`[Offscreen ${contextId}] ✅ Chunk ${i + 1}/${numChunks} allocated (${totalAllocatedGB.toFixed(2)}GB total)`);

                    let delayMs = 50;
                    if (totalAllocatedGB > 10) {
                        delayMs = 200;
                    } else if (totalAllocatedGB > 5) {
                        delayMs = 100;
                    }

                    if (i > 0 && i % 4 === 0) {
                        delayMs *= 2;
                    }

                    if (i < numChunks - 1) {
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }

                } catch (error) {
                    console.error(`[Offscreen ${contextId}] ❌ Failed to allocate chunk ${i + 1}:`, error);
                    throw error;
                }
            }

            this.initialized = true;
            console.log(`[Offscreen ${contextId}] ✅ Successfully added ${allocatedGB}GB! Total: ${this.committedGB.toFixed(1)}GB`);

            // Notify background script
            chrome.runtime.sendMessage({
                type: 'offscreen_initialized',
                contextId: contextId,
                allocatedGB: allocatedGB
            }).catch(e => {
                console.error(`[Offscreen ${contextId}] Failed to send initialized message:`, e);
            });

        } catch (error) {
            console.error(`[Offscreen ${contextId}] ❌ Failed to initialize:`, error);
            chrome.runtime.sendMessage({
                type: 'offscreen_error',
                contextId: contextId,
                error: error.message
            });
            throw error;
        }
    }

    async allocateChunkWithTimeout(sizeBytes, timeoutMs) {
        return Promise.race([
            new Promise((resolve, reject) => {
                try {
                    const chunk = new ArrayBuffer(sizeBytes);
                    resolve(chunk);
                } catch (error) {
                    reject(error);
                }
            }),
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Allocation timeout in context ${this.contextId}`));
                }, timeoutMs);
            })
        ]);
    }

    async touchPagesAsync(chunk, chunkBytes, chunkNum, totalChunks) {
        const view = new Uint8Array(chunk);
        const pageSize = 4096;
        const touchInterval = 4;
        const pagesPerBatch = 1000;

        let offset = 0;

        while (offset < chunkBytes) {
            const batchEnd = Math.min(offset + (pagesPerBatch * pageSize * touchInterval), chunkBytes);

            for (let currentOffset = offset; currentOffset < batchEnd; currentOffset += pageSize * touchInterval) {
                view[currentOffset] = (currentOffset / pageSize) % 256;
            }

            offset = batchEnd;

            if (offset < chunkBytes) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }

    /**
     * Generate chunk for PoRAM challenge
     */
    async generateChunk(epochSeedHex, offset, chunkSize) {
        const epochSeed = this.hexToBytes(epochSeedHex);
        const chunkData = new Uint8Array(chunkSize);
        let currentOffset = offset;
        let writePos = 0;

        while (writePos < chunkSize) {
            const offsetBytes = this.numberToBytes(currentOffset, 8);
            const input = new Uint8Array([...epochSeed, ...offsetBytes]);
            const hashBytes = await sha256(input);

            const remaining = chunkSize - writePos;
            const copyLen = Math.min(32, remaining);

            chunkData.set(hashBytes.subarray(0, copyLen), writePos);
            writePos += copyLen;
            currentOffset += copyLen;
        }

        return this.arrayToBase64(chunkData);
    }

    hexToBytes(hex) {
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    }

    numberToBytes(num, byteCount) {
        const bytes = new Uint8Array(byteCount);
        for (let i = byteCount - 1; i >= 0; i--) {
            bytes[i] = num & 0xff;
            num = Math.floor(num / 256);
        }
        return bytes;
    }

    arrayToBase64(array) {
        let binary = '';
        const len = array.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(array[i]);
        }
        return btoa(binary);
    }

    cleanup() {
        this.memory = [];
        this.initialized = false;
    }
}

// Now create the PoRAM manager
let poramManager;
try {
    poramManager = new OffscreenPoRAMManager();
    console.log('[Offscreen] ✅ PoRAM manager created');
} catch (error) {
    console.error('[Offscreen] ❌ Failed to create PoRAM manager:', error);
    // Don't throw - listener is already set up, we can still receive messages
    // Try to notify background
    try {
        chrome.runtime.sendMessage({
            type: 'offscreen_error',
            contextId: 'init',
            error: `Failed to create PoRAM manager: ${error.message}`
        });
    } catch (e) {
        console.error('[Offscreen] Failed to send error:', e);
    }
}

// Add handler for other message types (ping is already handled at top)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`[Offscreen] 📨 Received message (handler):`, message?.type);

    // Handle async operations
    if (message && message.type === 'initialize_memory') {
        if (!poramManager) {
            sendResponse({ success: false, error: 'PoRAM manager not initialized' });
            return false;
        }
        // Don't return true here - the response comes via offscreen_initialized message
        // Returning true causes the "message channel closed" error
        poramManager.initialize(message.allocatedGB, message.contextId)
            .then(() => {
                // Response sent via offscreen_initialized message, not sendResponse
                console.log(`[Offscreen] Initialization complete for ${message.contextId}`);
            })
            .catch(error => {
                console.error(`[Offscreen] Initialization failed:`, error);
                // Error is already sent via offscreen_error message
            });
        return false; // Don't keep channel open - response comes via separate message
    }

    if (message && message.type === 'generate_chunk') {
        if (!poramManager || !poramManager.initialized) {
            sendResponse({ success: false, error: 'Not initialized' });
            return false;
        }
        poramManager.generateChunk(message.epochSeedHex, message.offset, message.chunkSize)
            .then(chunk => {
                sendResponse({ success: true, chunk });
            })
            .catch(error => {
                sendResponse({ success: false, error: error.message });
            });
        return true; // Keep channel open for async
    }

    if (message && message.type === 'cleanup') {
        if (poramManager) {
            poramManager.cleanup();
        }
        sendResponse({ success: true });
        return false;
    }

    // Return false for unhandled messages (ping is handled by top-level listener)
    return false;
});

console.log('[Offscreen] ✅ All message handlers registered');

