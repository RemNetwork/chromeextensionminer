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
        this.useOffscreenContexts = committedGB > 15; // Use offscreen for >15GB
        this.offscreenContexts = []; // Array of context IDs
        this.contextAllocations = {}; // Map of contextId -> allocated GB
    }

    /**
     * Initialize PoRAM memory allocation
     * For >15GB: Uses multiple offscreen contexts (each with ~15GB limit)
     * For <=15GB: Uses main context with chunked allocation
     */
    async initialize() {
        console.log(`[PoRAM] Initializing ${this.committedGB}GB allocation...`);

        // For very large allocations (>30GB), use multiple tabs (each tab = separate process = 15GB limit)
        // This is the "insane" approach: multiple tabs = multiple processes = multiple 15GB limits
        if (this.committedGB > 30) {
            console.log(`[PoRAM] 🚀 INSANE MODE: Allocation exceeds 30GB, using multiple tabs (each tab = 15GB limit)!`);
            return await this.initializeWithMultipleTabs();
        }

        // If allocation > 15GB, use multiple offscreen contexts
        if (this.useOffscreenContexts) {
            console.log(`[PoRAM] Allocation exceeds 15GB, using multiple offscreen contexts...`);
            return await this.initializeWithOffscreenContexts();
        }

        // Otherwise, allocate in main context (up to 15GB)
        return await this.initializeInMainContext();
    }

    /**
     * INSANE MODE: Use multiple browser tabs (each tab = separate process = 15GB limit)
     * This allows us to allocate up to 15GB * N tabs (theoretically 128GB+ with 9 tabs)
     */
    async initializeWithMultipleTabs() {
        const GB_PER_TAB = 14.5; // Leave 0.5GB buffer per tab
        const numTabsNeeded = Math.ceil(this.committedGB / GB_PER_TAB);
        
        console.log(`[PoRAM] 🚀 Creating ${numTabsNeeded} memory tabs (${GB_PER_TAB}GB each) for ${this.committedGB}GB total...`);

        try {
            // Request background script to create tabs
            let response;
            
            if (typeof globalThis.createMemoryTabsHandler === 'function') {
                response = await globalThis.createMemoryTabsHandler({
                    totalGB: this.committedGB,
                    gbPerTab: GB_PER_TAB
                });
            } else {
                response = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({
                        type: 'create_memory_tabs',
                        totalGB: this.committedGB,
                        gbPerTab: GB_PER_TAB
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(response);
                        }
                    });
                });
            }

            if (!response || !response.success) {
                throw new Error(response?.error || 'Failed to create memory tabs');
            }

            this.offscreenContexts = response.tabIds.map(id => `tab_${id}`);
            this.contextAllocations = response.allocations;

            console.log(`[PoRAM] ✅ Created ${this.offscreenContexts.length} memory tabs`);
            console.log(`[PoRAM] Tab allocations:`, this.contextAllocations);

            this.initialized = true;
            this.lastAccessTime = Date.now();
            const totalAllocated = Object.values(this.contextAllocations).reduce((sum, gb) => sum + gb, 0);
            console.log(`[PoRAM] 🚀 INSANE MODE SUCCESS: ${totalAllocated.toFixed(1)}GB allocated across ${this.offscreenContexts.length} tabs!`);

        } catch (error) {
            console.error(`[PoRAM] ❌ Failed to initialize with multiple tabs:`, error);
            throw error;
        }
    }

    /**
     * Initialize using multiple offscreen contexts (for >15GB)
     * Each context can handle up to ~15GB
     */
    async initializeWithOffscreenContexts() {
        const MAX_PER_CONTEXT_GB = 12; // Leave 3GB buffer per context (Chrome limit is ~15GB)
        const numContexts = Math.ceil(this.committedGB / MAX_PER_CONTEXT_GB);
        
        console.log(`[PoRAM] Creating ${numContexts} offscreen contexts (${MAX_PER_CONTEXT_GB}GB each)...`);

        try {
            // CRITICAL FIX: Since poram.js runs in background script context (via miner.js),
            // we can't use chrome.runtime.sendMessage to send to ourselves.
            // We need to call the handler function directly via globalThis.
            let response;
            
            if (typeof globalThis.createOffscreenContextsHandler === 'function') {
                // We're in background context - call handler directly
                console.log('[PoRAM] Calling offscreen handler directly (background context)');
                response = await globalThis.createOffscreenContextsHandler({
                    totalGB: this.committedGB,
                    maxPerContext: MAX_PER_CONTEXT_GB
                });
            } else {
                // Fallback: Try sendMessage (works from popup/setup contexts)
                console.log('[PoRAM] Using sendMessage (non-background context)');
                response = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({
                        type: 'create_offscreen_contexts',
                        totalGB: this.committedGB,
                        maxPerContext: MAX_PER_CONTEXT_GB
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(`Message error: ${chrome.runtime.lastError.message}`));
                        } else {
                            resolve(response);
                        }
                    });
                });
            }

            if (!response) {
                throw new Error(`No response from background script. Check if extension is loaded properly.`);
            }

            if (!response.success) {
                const errorMsg = response.error || 'Unknown error';
                console.error(`[PoRAM] Offscreen context creation failed: ${errorMsg}`);
                throw new Error(`Failed to create offscreen contexts: ${errorMsg}`);
            }

            this.offscreenContexts = response.contextIds;
            this.contextAllocations = response.allocations;

            console.log(`[PoRAM] ✅ Created ${this.offscreenContexts.length} offscreen contexts`);
            console.log(`[PoRAM] Context allocations:`, this.contextAllocations);

            // Calculate how much was actually allocated in offscreen
            const offscreenAllocatedGB = Object.values(this.contextAllocations).reduce((sum, gb) => sum + gb, 0);
            const remainingGB = this.committedGB - offscreenAllocatedGB;

            // If there's remaining memory, allocate it in the main context
            if (remainingGB > 0) {
                console.log(`[PoRAM] ⚠️ Offscreen document limit reached (${offscreenAllocatedGB.toFixed(1)}GB allocated)`);
                console.log(`[PoRAM] Allocating remaining ${remainingGB.toFixed(1)}GB in main background context...`);
                
                try {
                    // Allocate remaining memory in main context
                    await this.initializeRemainingInMainContext(remainingGB);
                    console.log(`[PoRAM] ✅ Successfully allocated ${remainingGB.toFixed(1)}GB in main context`);
                } catch (error) {
                    console.error(`[PoRAM] ❌ Failed to allocate remaining memory in main context:`, error);
                    // Don't throw - we still have the offscreen allocation working
                    console.warn(`[PoRAM] ⚠️ Continuing with ${offscreenAllocatedGB.toFixed(1)}GB allocation only`);
                }
            }

            // Initialization complete
            this.initialized = true;
            this.lastAccessTime = Date.now();
            const totalAllocated = offscreenAllocatedGB + (this.memory ? this.memory.length * 0.25 : 0);
            console.log(`[PoRAM] ✅ Total allocation: ${totalAllocated.toFixed(1)}GB (${offscreenAllocatedGB.toFixed(1)}GB offscreen + ${(totalAllocated - offscreenAllocatedGB).toFixed(1)}GB main)`);

        } catch (error) {
            console.error(`[PoRAM] ❌ Failed to initialize with offscreen contexts:`, error);
            throw error;
        }
    }

    /**
     * Initialize remaining memory in main context (hybrid approach)
     */
    async initializeRemainingInMainContext(remainingGB) {
        const CHUNK_SIZE_GB = 0.25; // 256MB chunks
        const CHUNK_SIZE_BYTES = CHUNK_SIZE_GB * 1024 * 1024 * 1024;
        const numChunks = Math.ceil(remainingGB / CHUNK_SIZE_GB);
        const CHROME_MAIN_CONTEXT_LIMIT_GB = 15; // Main context also has ~15GB limit

        console.log(`[PoRAM] Allocating ${numChunks} chunks of ${CHUNK_SIZE_GB}GB (256MB) each in main context...`);

        if (!this.memory) {
            this.memory = [];
        }

        let totalAllocatedGB = this.memory.length * CHUNK_SIZE_GB;

        for (let i = 0; i < numChunks; i++) {
            const remainingChunkGB = remainingGB - (i * CHUNK_SIZE_GB);
            const actualChunkGB = Math.min(CHUNK_SIZE_GB, remainingChunkGB);
            const actualChunkBytes = actualChunkGB * 1024 * 1024 * 1024;

            // Check limit before allocating
            if (totalAllocatedGB + actualChunkGB > CHROME_MAIN_CONTEXT_LIMIT_GB - 0.5) {
                console.warn(`[PoRAM] ⚠️ Main context limit reached at ${totalAllocatedGB.toFixed(1)}GB. Cannot allocate remaining ${(remainingGB - i * CHUNK_SIZE_GB).toFixed(1)}GB`);
                break;
            }

            console.log(`[PoRAM] Allocating chunk ${i + 1}/${numChunks} (${actualChunkGB.toFixed(2)}GB) in main context - Total: ${totalAllocatedGB.toFixed(2)}GB...`);

            try {
                const chunk = new ArrayBuffer(actualChunkBytes);
                this.memory.push(chunk);
                totalAllocatedGB += actualChunkGB;

                // Touch pages asynchronously
                const view = new Uint8Array(chunk);
                const pageSize = 4096;
                const touchInterval = 4;
                const pagesPerBatch = 1000;

                let offset = 0;
                while (offset < actualChunkBytes) {
                    const batchEnd = Math.min(offset + (pagesPerBatch * pageSize * touchInterval), actualChunkBytes);
                    for (let currentOffset = offset; currentOffset < batchEnd; currentOffset += pageSize * touchInterval) {
                        view[currentOffset] = (currentOffset / pageSize) % 256;
                    }
                    offset = batchEnd;
                    if (offset < actualChunkBytes) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                }

                console.log(`[PoRAM] ✅ Chunk ${i + 1}/${numChunks} allocated in main context (${totalAllocatedGB.toFixed(2)}GB total)`);

                // Progressive delays
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
                console.error(`[PoRAM] ❌ Failed to allocate chunk ${i + 1} in main context:`, error);
                throw error;
            }
        }

        console.log(`[PoRAM] ✅ Main context allocation complete: ${totalAllocatedGB.toFixed(1)}GB`);
    }

    /**
     * Initialize in main context (for <=15GB)
     */
    async initializeInMainContext() {
        try {
            // Use very small chunks (256MB) to work around Chrome's ~15GB process memory limit
            // Chrome extensions have a practical limit around 15-16GB total allocation
            // Smaller chunks + longer delays help avoid hitting this limit
            const CHUNK_SIZE_GB = 0.25; // 256MB chunks - smaller to avoid Chrome limits
            const CHUNK_SIZE_BYTES = CHUNK_SIZE_GB * 1024 * 1024 * 1024;
            const numChunks = Math.ceil(this.committedGB / CHUNK_SIZE_GB);

            console.log(`[PoRAM] Allocating ${numChunks} chunks of ${CHUNK_SIZE_GB}GB (256MB) each...`);

            this.memory = []; // Array of ArrayBuffers
            let totalAllocatedGB = 0;
            const CHROME_MEMORY_LIMIT_GB = 15; // Approximate Chrome extension limit

            // Allocate each chunk with delays and async page touching
            for (let i = 0; i < numChunks; i++) {
                // Calculate actual chunk size (last chunk might be smaller)
                const remainingGB = this.committedGB - (i * CHUNK_SIZE_GB);
                const actualChunkGB = Math.min(CHUNK_SIZE_GB, remainingGB);
                const actualChunkBytes = actualChunkGB * 1024 * 1024 * 1024;

                // Check if we're approaching Chrome's memory limit
                if (totalAllocatedGB >= CHROME_MEMORY_LIMIT_GB) {
                    const errorMsg = `Chrome memory limit reached at ~${totalAllocatedGB.toFixed(1)}GB. Chrome extensions have a practical limit around 15-16GB. Please reduce RAM allocation or use a standalone miner application.`;
                    console.error(`[PoRAM] ❌ ${errorMsg}`);
                    this.cleanup();
                    throw new Error(errorMsg);
                }

                console.log(`[PoRAM] Allocating chunk ${i + 1}/${numChunks} (${actualChunkGB.toFixed(2)}GB) - Total: ${totalAllocatedGB.toFixed(2)}GB/${this.committedGB}GB...`);

                try {
                    // Allocate the chunk with timeout protection
                    const allocationStart = Date.now();
                    const chunk = await this.allocateChunkWithTimeout(actualChunkBytes, 30000); // 30s timeout
                    const allocationTime = Date.now() - allocationStart;
                    
                    if (allocationTime > 5000) {
                        console.warn(`[PoRAM] ⚠️ Chunk ${i + 1} allocation took ${allocationTime}ms (slow, may indicate memory pressure)`);
                    }

                    this.memory.push(chunk);
                    totalAllocatedGB += actualChunkGB;

                    // Touch pages asynchronously to prevent blocking
                    await this.touchPagesAsync(chunk, actualChunkBytes, i + 1, numChunks);

                    console.log(`[PoRAM] ✅ Chunk ${i + 1}/${numChunks} allocated and touched (${totalAllocatedGB.toFixed(2)}GB total)`);

                    // Progressive delays: longer delays as we approach the limit
                    // Also longer delays for larger total allocations
                    let delayMs = 50; // Base delay
                    if (totalAllocatedGB > 10) {
                        delayMs = 200; // 200ms delay after 10GB
                    } else if (totalAllocatedGB > 5) {
                        delayMs = 100; // 100ms delay after 5GB
                    }
                    
                    // Extra delay every 4 chunks to let Chrome manage memory
                    if (i > 0 && i % 4 === 0) {
                        delayMs *= 2; // Double delay every 4 chunks
                        console.log(`[PoRAM] Memory management pause: ${delayMs}ms delay...`);
                    }

                    if (i < numChunks - 1) {
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }

                } catch (error) {
                    console.error(`[PoRAM] ❌ Failed to allocate chunk ${i + 1}:`, error);
                    
                    // If we've allocated some memory, provide partial success info
                    if (totalAllocatedGB > 0) {
                        const errorMsg = `Memory allocation failed at chunk ${i + 1}/${numChunks} (${totalAllocatedGB.toFixed(2)}GB allocated). ${error.message}. Chrome extensions have a practical limit around 15GB. Try reducing RAM allocation or closing other browser tabs.`;
                        this.cleanup();
                        throw new Error(errorMsg);
                    } else {
                        this.cleanup();
                        throw new Error(`Failed to allocate ${actualChunkGB}GB at chunk ${i + 1}/${numChunks}. ${error.message}. This may indicate insufficient system RAM or browser memory limits.`);
                    }
                }
            }

            this.initialized = true;
            this.lastAccessTime = Date.now();

            console.log(`[PoRAM] ✅ Successfully allocated ${this.committedGB}GB across ${numChunks} chunks!`);
            console.log(`[PoRAM] Memory details:`, {
                total_bytes: this.committedBytes,
                total_gb: this.committedGB,
                chunks: numChunks,
                chunk_size_gb: CHUNK_SIZE_GB,
                total_allocated_gb: totalAllocatedGB
            });

            // Start keep-alive loop to prevent garbage collection
            this.startKeepAlive();

        } catch (error) {
            console.error(`[PoRAM] ❌ Failed to allocate ${this.committedGB}GB:`, error);
            // Ensure cleanup on failure
            this.cleanup();
            throw new Error(
                `Cannot allocate ${this.committedGB}GB RAM. ${error.message}`
            );
        }
    }

    /**
     * Allocate a chunk with timeout protection
     * Since ArrayBuffer allocation is synchronous, we wrap it in a promise
     * and use a timeout to detect if the browser is hanging
     */
    async allocateChunkWithTimeout(sizeBytes, timeoutMs) {
        return Promise.race([
            new Promise((resolve, reject) => {
                try {
                    // Allocate synchronously (this will block if memory is exhausted)
                    const chunk = new ArrayBuffer(sizeBytes);
                    resolve(chunk);
                } catch (error) {
                    reject(error);
                }
            }),
            new Promise((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`Allocation appears to be hanging. Chrome may have hit its ~15GB memory limit.`));
                }, timeoutMs);
            })
        ]);
    }

    /**
     * Touch pages asynchronously to prevent blocking the event loop
     * Yields to the browser periodically to prevent hangs
     */
    async touchPagesAsync(chunk, chunkBytes, chunkNum, totalChunks) {
        const view = new Uint8Array(chunk);
        const pageSize = 4096;
        
        // Touch every 4th page to reduce work while still committing memory
        const touchInterval = 4;
        const pagesPerBatch = 1000; // Process 1000 pages at a time, then yield
        
        let offset = 0;

        while (offset < chunkBytes) {
            // Touch a batch of pages
            const batchEnd = Math.min(offset + (pagesPerBatch * pageSize * touchInterval), chunkBytes);
            
            for (let currentOffset = offset; currentOffset < batchEnd; currentOffset += pageSize * touchInterval) {
                view[currentOffset] = (currentOffset / pageSize) % 256;
            }

            offset = batchEnd;

            // Yield to the event loop every batch to prevent blocking
            // This is critical to prevent the browser from hanging
            if (offset < chunkBytes) {
                await new Promise(resolve => {
                    // Use setTimeout with 0ms to yield to event loop
                    setTimeout(resolve, 0);
                });
            }
        }

        // Log progress for large allocations
        if (totalChunks > 16 && chunkNum % 4 === 0) {
            console.log(`[PoRAM] Progress: ${chunkNum}/${totalChunks} chunks (${((chunkNum / totalChunks) * 100).toFixed(1)}%)`);
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

            // If using multiple tabs (INSANE MODE), generate chunks in tabs
            if (this.offscreenContexts.length > 0 && this.offscreenContexts[0] && this.offscreenContexts[0].startsWith('tab_')) {
                // These are tab IDs, not offscreen contexts
                const tabIds = this.offscreenContexts.map(ctx => parseInt(ctx.replace('tab_', '')));
                const offsetsPerTab = Math.ceil(offsets.length / tabIds.length);
                
                const chunkPromises = offsets.map(async (offset, index) => {
                    const tabIndex = Math.floor(index / offsetsPerTab);
                    const tabId = tabIds[tabIndex];
                    
                    // Request chunk generation from tab via runtime message
                    const response = await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({
                            type: 'generate_chunk_tab',
                            tabId: tabId,
                            epochSeedHex: epoch_seed,
                            offset: offset,
                            chunkSize: chunk_size
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                reject(new Error(chrome.runtime.lastError.message));
                            } else {
                                resolve(response);
                            }
                        });
                    });

                    if (!response || !response.success) {
                        throw new Error(`Failed to generate chunk in tab ${tabId}: ${response?.error || 'Unknown error'}`);
                    }

                    return response.chunk;
                });

                chunks.push(...await Promise.all(chunkPromises));
            }
            // If using offscreen contexts, distribute chunk generation across them
            else if (this.useOffscreenContexts && this.offscreenContexts.length > 0) {
                // Distribute offsets across contexts
                const offsetsPerContext = Math.ceil(offsets.length / this.offscreenContexts.length);
                
                const chunkPromises = offsets.map(async (offset, index) => {
                    // Determine which context should handle this offset
                    const contextIndex = Math.floor(index / offsetsPerContext);
                    const contextId = this.offscreenContexts[contextIndex];
                    
                    // Request chunk generation from offscreen context
                    const response = await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({
                            type: 'generate_chunk',
                            contextId: contextId,
                            epochSeedHex: epoch_seed,
                            offset: offset,
                            chunkSize: chunk_size
                        }, (response) => {
                            if (chrome.runtime.lastError) {
                                reject(new Error(chrome.runtime.lastError.message));
                            } else {
                                resolve(response);
                            }
                        });
                    });

                    if (!response || !response.success) {
                        throw new Error(`Failed to generate chunk in context ${contextId}: ${response?.error || 'Unknown error'}`);
                    }

                    return response.chunk;
                });

                chunks.push(...await Promise.all(chunkPromises));
            } else {
                // Generate chunks in main context
                for (const offset of offsets) {
                    const chunk = await this.generateChunk(epoch_seed, offset, chunk_size);
                    chunks.push(chunk);
                }
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
    async cleanup() {
        console.log('[PoRAM] Cleaning up memory allocation...');
        
        // Cleanup offscreen contexts if used
        if (this.useOffscreenContexts && this.offscreenContexts.length > 0) {
            try {
                await chrome.runtime.sendMessage({
                    type: 'close_offscreen_contexts',
                    contextIds: this.offscreenContexts
                });
            } catch (error) {
                console.error(`[PoRAM] Error closing offscreen contexts:`, error);
            }
            
            this.offscreenContexts = [];
            this.contextAllocations = {};
        }
        
        this.memory = null;
        this.initialized = false;
    }
}
