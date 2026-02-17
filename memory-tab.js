/**
 * Memory Tab Handler
 * Each tab runs in a separate process with its own ~15GB memory limit
 * This allows us to allocate memory across multiple processes
 */

console.log('[Memory Tab] Script loading...');

// Inline sha256
async function sha256(data) {
    const buffer = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return new Uint8Array(hashBuffer);
}

class MemoryTabAllocator {
    constructor() {
        this.memory = [];
        this.allocatedGB = 0;
        this.targetGB = 0;
        this.tabId = null;
        this.contextId = null;
        this.initialized = false;
    }

    async initialize(targetGB, contextId, tabId) {
        this.targetGB = targetGB;
        this.contextId = contextId;
        this.tabId = tabId;
        
        console.log(`[Memory Tab ${tabId}] Initializing ${targetGB}GB allocation...`);
        this.updateStatus(`Allocating ${targetGB}GB...`);

        try {
            const CHUNK_SIZE_GB = 0.25; // 256MB chunks
            const CHUNK_SIZE_BYTES = CHUNK_SIZE_GB * 1024 * 1024 * 1024;
            const numChunks = Math.ceil(targetGB / CHUNK_SIZE_GB);
            const CHROME_MEMORY_LIMIT_GB = 15;

            this.memory = [];
            let totalAllocatedGB = 0;

            for (let i = 0; i < numChunks; i++) {
                const remainingGB = targetGB - (i * CHUNK_SIZE_GB);
                const actualChunkGB = Math.min(CHUNK_SIZE_GB, remainingGB);
                const actualChunkBytes = actualChunkGB * 1024 * 1024 * 1024;

                // Check limit before allocating
                if (totalAllocatedGB + actualChunkGB > CHROME_MEMORY_LIMIT_GB - 0.5) {
                    console.warn(`[Memory Tab ${tabId}] ⚠️ Limit reached at ${totalAllocatedGB.toFixed(1)}GB`);
                    break;
                }

                this.updateStatus(`Allocating chunk ${i + 1}/${numChunks} (${totalAllocatedGB.toFixed(1)}GB / ${targetGB}GB)`);

                try {
                    const chunk = new ArrayBuffer(actualChunkBytes);
                    this.memory.push(chunk);
                    totalAllocatedGB += actualChunkGB;

                    // Touch pages asynchronously
                    await this.touchPagesAsync(chunk, actualChunkBytes);

                    console.log(`[Memory Tab ${tabId}] ✅ Chunk ${i + 1}/${numChunks} allocated (${totalAllocatedGB.toFixed(2)}GB total)`);

                    // Progressive delays
                    let delayMs = 50;
                    if (totalAllocatedGB > 10) delayMs = 200;
                    else if (totalAllocatedGB > 5) delayMs = 100;
                    if (i > 0 && i % 4 === 0) delayMs *= 2;
                    if (i < numChunks - 1) {
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                    }

                } catch (error) {
                    console.error(`[Memory Tab ${tabId}] ❌ Failed to allocate chunk ${i + 1}:`, error);
                    throw error;
                }
            }

            this.allocatedGB = totalAllocatedGB;
            this.initialized = true;

            console.log(`[Memory Tab ${tabId}] ✅ Successfully allocated ${totalAllocatedGB.toFixed(1)}GB!`);

            // Notify background script
            console.log(`[Memory Tab ${tabId}] 📤 Sending memory_tab_initialized message: ${totalAllocatedGB.toFixed(1)}GB`);
            chrome.runtime.sendMessage({
                type: 'memory_tab_initialized',
                tabId: tabId,
                contextId: contextId,
                allocatedGB: totalAllocatedGB
            }).then(() => {
                console.log(`[Memory Tab ${tabId}] ✅ memory_tab_initialized message sent successfully`);
            }).catch(e => {
                console.error(`[Memory Tab ${tabId}] ❌ Failed to send initialized:`, e);
            });

            this.updateStatus(`✅ Allocated ${totalAllocatedGB.toFixed(1)}GB`);

        } catch (error) {
            console.error(`[Memory Tab ${tabId}] ❌ Failed to initialize:`, error);
            chrome.runtime.sendMessage({
                type: 'memory_tab_error',
                tabId: tabId,
                contextId: contextId,
                error: error.message
            }).catch(e => console.error(`[Memory Tab ${tabId}] Failed to send error:`, e));
            this.updateStatus(`❌ Error: ${error.message}`);
            throw error;
        }
    }

    async touchPagesAsync(chunk, chunkBytes) {
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

    updateStatus(text) {
        const statusEl = document.getElementById('status');
        const progressEl = document.getElementById('progress');
        if (statusEl) statusEl.textContent = text;
        if (progressEl) progressEl.textContent = `${this.allocatedGB.toFixed(1)}GB / ${this.targetGB}GB`;
    }

    cleanup() {
        this.memory = [];
        this.initialized = false;
    }
}

// Global instance
const allocator = new MemoryTabAllocator();

// Listen for messages from background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log(`[Memory Tab] 📨 Received message:`, message.type, message);

    if (message.type === 'initialize_memory_tab') {
        console.log(`[Memory Tab] 🚀 Starting initialization: ${message.targetGB}GB for context ${message.contextId}`);
        // Initialize asynchronously - response comes via memory_tab_initialized message
        allocator.initialize(message.targetGB, message.contextId, message.tabId)
            .then(() => {
                console.log(`[Memory Tab] ✅ Initialization complete, memory_tab_initialized message already sent`);
            })
            .catch(error => {
                console.error(`[Memory Tab] ❌ Initialization failed:`, error);
                // Error message already sent via memory_tab_error in initialize()
            });
        return false; // Response comes via memory_tab_initialized message, not sendResponse
    }

    if (message.type === 'generate_chunk_tab') {
        // Check if message is for this tab
        const messageTabId = message.tabId;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const myTabId = tabs && tabs.length > 0 ? tabs[0].id : null;
            if (messageTabId && messageTabId !== myTabId) {
                // Not for us, ignore
                return;
            }
            
            if (!allocator.initialized) {
                sendResponse({ success: false, error: 'Not initialized' });
                return;
            }
            allocator.generateChunk(message.epochSeedHex, message.offset, message.chunkSize)
                .then(chunk => {
                    sendResponse({ success: true, chunk });
                })
                .catch(error => {
                    sendResponse({ success: false, error: error.message });
                });
        });
        return true; // Keep channel open
    }

    if (message.type === 'cleanup_tab') {
        allocator.cleanup();
        sendResponse({ success: true });
        return false;
    }

    sendResponse({ success: false, error: 'Unknown message type' });
    return false;
});

// Get tab ID and notify background
// Extension pages can't directly query their own tab ID, so we'll let background track it
window.addEventListener('load', () => {
    console.log(`[Memory Tab] Page loaded, notifying background...`);
    // Send ready message - background script knows which tab it just created
    chrome.runtime.sendMessage({
        type: 'memory_tab_ready',
        tabId: null // Background will match this to the tab it just created
    }).then(() => {
        console.log(`[Memory Tab] ✅ Ready message sent`);
    }).catch(e => {
        console.error(`[Memory Tab] ❌ Failed to send ready:`, e);
    });
});

console.log('[Memory Tab] ✅ Script loaded and ready');

