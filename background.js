/**
 * Background Service Worker
 * Manages the miner lifecycle and keeps it running
 */

import { WebSocketMiner } from './miner.js';

let miner = null;
let minerConfig = null;
let offscreenContexts = new Map(); // Map of contextId -> {documentId, allocatedGB}

// Keep service worker alive
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.create('saveState', { periodInMinutes: 5 });

/**
 * Handle alarm events
 */
chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'keepAlive') {
        // Touch miner to keep service worker alive
        if (miner) {
            const stats = miner.getStats();
            console.log('[Background] Keep-alive:', {
                connected: stats.connected,
                vectors: stats.engine_stats.total_vectors
            });

            // Update badge with connection status
            if (stats.connected) {
                chrome.action.setBadgeText({ text: '●' });
                chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
            } else {
                chrome.action.setBadgeText({ text: '●' });
                chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
            }
        }
    } else if (alarm.name === 'saveState') {
        // Periodically save state
        if (miner) {
            await miner.engine.saveAll();
            console.log('[Background] State saved');
        }
    }
});

/**
 * Handle installation
 */
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('[Background] Extension installed:', details.reason);

    if (details.reason === 'install') {
        // First time install - show setup page
        chrome.tabs.create({ url: 'setup.html' });
    } else if (details.reason === 'update') {
        // Extension updated
        console.log('[Background] Extension updated to version', chrome.runtime.getManifest().version);
    }

    // Try to load existing config and start miner
    await loadConfigAndStart();
});

/**
 * Handle startup (browser launched)
 */
chrome.runtime.onStartup.addListener(async () => {
    console.log('[Background] Browser started');
    await loadConfigAndStart();
});

/**
 * Handle messages from popup/setup pages
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Background] Received message:', message.type);

    switch (message.type) {
        case 'getStats':
            handleGetStats(sendResponse);
            return true; // Keep channel open for async response

        case 'saveConfig':
            handleSaveConfig(message.config, sendResponse);
            return true;

        case 'startMiner':
            handleStartMiner(sendResponse);
            return true;

        case 'stopMiner':
            handleStopMiner(sendResponse);
            return true;

        case 'getConfig':
            handleGetConfig(sendResponse);
            return true;

        case 'create_offscreen_contexts':
            handleCreateOffscreenContexts(message, sendResponse);
            return true;

        case 'generate_chunk':
            handleGenerateChunk(message, sendResponse);
            return true;

        case 'cleanup_offscreen':
            handleCleanupOffscreen(message, sendResponse);
            return true;

        case 'close_offscreen_contexts':
            handleCloseOffscreenContexts(message, sendResponse);
            return true;

        case 'create_memory_tabs':
            handleCreateMemoryTabs(message, sendResponse);
            return true;

        case 'memory_tab_ready':
        case 'memory_tab_initialized':
        case 'memory_tab_error':
            // Forward to waiting listeners
            break;

        case 'offscreen_ready':
            // Handled in handleCreateOffscreenContexts
            break;

        case 'offscreen_initialized':
        case 'offscreen_error':
            // Forward to any waiting listeners (handled by PoRAMManager and handleCreateOffscreenContexts)
            break;

        default:
            console.warn('[Background] Unknown message type:', message.type);
            sendResponse({ error: 'Unknown message type' });
    }
});

/**
 * Load config from storage and start miner
 */
async function loadConfigAndStart() {
    try {
        const result = await chrome.storage.local.get(['minerConfig']);

        if (result.minerConfig) {
            minerConfig = result.minerConfig;
            console.log('[Background] Config loaded:', {
                node_id: minerConfig.node_id,
                max_ram_gb: minerConfig.max_ram_gb
            });

            // Start miner if config is complete
            if (isConfigComplete(minerConfig)) {
                await startMiner();
            } else {
                console.log('[Background] Config incomplete, waiting for setup');
            }
        } else {
            console.log('[Background] No config found, waiting for setup');
        }
    } catch (error) {
        console.error('[Background] Error loading config:', error);
    }
}

/**
 * Check if config is complete
 */
function isConfigComplete(config) {
    if (!config) {
        return false;
    }
    
    if (!config.node_id || config.node_id.trim() === '') {
        console.error('[Background] Config incomplete: missing node_id');
        return false;
    }
    
    if (!config.sui_address || config.sui_address.trim() === '') {
        console.error('[Background] Config incomplete: missing sui_address');
        return false;
    }
    
    if (!config.max_ram_gb || config.max_ram_gb <= 0) {
        console.error('[Background] Config incomplete: invalid max_ram_gb:', config.max_ram_gb);
        return false;
    }
    
    // Validate RAM is within reasonable bounds
    if (config.max_ram_gb > 128) {
        console.error('[Background] Config invalid: max_ram_gb exceeds 128GB:', config.max_ram_gb);
        return false;
    }
    
    return true;
}

/**
 * Start the miner
 */
async function startMiner() {
    if (miner) {
        console.log('[Background] Miner already running');
        return { success: true, message: 'Miner already running' };
    }

    if (!minerConfig) {
        const errorMsg = 'Cannot start miner: no configuration found. Please complete the setup wizard.';
        console.error('[Background]', errorMsg);
        return { success: false, error: errorMsg };
    }
    
    if (!isConfigComplete(minerConfig)) {
        let errorMsg = 'Cannot start miner: configuration incomplete.';
        if (!minerConfig.node_id) errorMsg += ' Missing node ID.';
        if (!minerConfig.sui_address) errorMsg += ' Missing wallet address.';
        if (!minerConfig.max_ram_gb || minerConfig.max_ram_gb <= 0) {
            errorMsg += ' Invalid RAM allocation.';
        }
        if (minerConfig.max_ram_gb > 128) {
            errorMsg += ' RAM allocation exceeds 128GB limit.';
        }
        console.error('[Background]', errorMsg);
        return { success: false, error: errorMsg };
    }

    console.log('[Background] Starting miner...');

    try {
        miner = new WebSocketMiner(minerConfig);
        await miner.start();

        console.log('[Background] ✅ Miner started successfully');

        // Update badge (icon change disabled - causes errors)
        // chrome.action.setIcon({ path: 'icons/icon-active.png' });
        chrome.action.setBadgeText({ text: '●' });
        chrome.action.setBadgeBackgroundColor({ color: '#10b981' });

        return { success: true };

    } catch (error) {
        console.error('[Background] Failed to start miner:', error);
        miner = null;
        
        // Provide user-friendly error messages
        let errorMsg = error.message || 'Unknown error occurred';
        if (errorMsg.includes('Cannot allocate')) {
            errorMsg = `Memory allocation failed: ${errorMsg}. Try reducing RAM allocation or closing other browser tabs.`;
        } else if (errorMsg.includes('config')) {
            errorMsg = `Configuration error: ${errorMsg}. Please check your settings.`;
        }
        
        return { success: false, error: errorMsg };
    }
}

/**
 * Stop the miner
 */
async function stopMiner() {
    if (!miner) {
        console.log('[Background] Miner not running');
        return { success: true, message: 'Miner not running' };
    }

    console.log('[Background] Stopping miner...');

    try {
        await miner.stop();
        miner = null;

        console.log('[Background] ✅ Miner stopped');

        // Update badge (icon change disabled)
        // chrome.action.setIcon({ path: 'icons/icon.png' });
        chrome.action.setBadgeText({ text: '' });

        return { success: true };

    } catch (error) {
        console.error('[Background] Error stopping miner:', error);
        return { success: false, error: error.message || 'Failed to stop miner' };
    }
}

/**
 * Message handlers
 */
async function handleGetStats(sendResponse) {
    if (miner) {
        const stats = miner.getStats();
        sendResponse({ stats });
    } else {
        sendResponse({
            stats: {
                connected: false,
                registered: false,
                message: 'Miner not running'
            }
        });
    }
}

async function handleSaveConfig(config, sendResponse) {
    try {
        minerConfig = config;
        await chrome.storage.local.set({ minerConfig: config });
        console.log('[Background] Config saved');
        sendResponse({ success: true });
    } catch (error) {
        console.error('[Background] Error saving config:', error);
        sendResponse({ success: false, error: error.message });
    }
}

async function handleStartMiner(sendResponse) {
    try {
        const result = await startMiner();
        sendResponse(result);
    } catch (error) {
        console.error('[Background] Error in handleStartMiner:', error);
        sendResponse({ success: false, error: error.message || 'Failed to start miner' });
    }
}

async function handleStopMiner(sendResponse) {
    try {
        const result = await stopMiner();
        sendResponse(result);
    } catch (error) {
        console.error('[Background] Error in handleStopMiner:', error);
        sendResponse({ success: false, error: error.message || 'Failed to stop miner' });
    }
}

async function handleGetConfig(sendResponse) {
    sendResponse({ config: minerConfig });
}

// Expose handler function globally so poram.js can call it directly
// (since poram.js runs in background context and can't use sendMessage to self)
async function createOffscreenContextsHandler(message) {
    return new Promise((resolve) => {
        handleCreateOffscreenContexts(message, resolve);
    });
}

// Make it available globally
globalThis.createOffscreenContextsHandler = createOffscreenContextsHandler;

// Expose memory tabs handler globally
async function createMemoryTabsHandler(message) {
    return new Promise((resolve) => {
        handleCreateMemoryTabs(message, resolve);
    });
}

globalThis.createMemoryTabsHandler = createMemoryTabsHandler;

/**
 * Create multiple offscreen contexts for memory allocation
 */
async function handleCreateOffscreenContexts(message, sendResponse) {
    // Helper to send response (works for both callback and promise-based calls)
    const respond = (result) => {
        if (typeof sendResponse === 'function') {
            sendResponse(result);
        }
        return result;
    };
    
    try {
        const { totalGB, maxPerContext } = message;
        const numContexts = Math.ceil(totalGB / maxPerContext);
        const contextIds = [];
        const allocations = {};

        console.log(`[Background] Creating ${numContexts} offscreen contexts for ${totalGB}GB...`);

        // Note: Chrome only allows ONE offscreen document at a time
        // So we'll need to use a different approach - create one and allocate sequentially
        // OR use a workaround with multiple extension instances (not practical)
        
        // For now, we'll create one offscreen document and allocate in batches
        // This is a limitation we need to work around
        console.warn(`[Background] ⚠️ Chrome limitation: Only one offscreen document allowed. Using sequential allocation.`);

        // Create single offscreen document
        const hasExisting = await chrome.offscreen.hasDocument();
        if (hasExisting) {
            await chrome.offscreen.closeDocument();
        }

        // Set up listener BEFORE creating document to catch ready message
        let offscreenReady = false;
        const readyListener = (message, sender, sendResponse) => {
            console.log('[Background] Ready listener received message:', message?.type);
            if (message && message.type === 'offscreen_ready') {
                offscreenReady = true;
                console.log('[Background] ✅ Offscreen document is ready');
                chrome.runtime.onMessage.removeListener(readyListener);
                return true;
            }
            return false;
        };
        chrome.runtime.onMessage.addListener(readyListener);
        console.log('[Background] ✅ Ready listener registered');

        try {
            await chrome.offscreen.createDocument({
                url: 'offscreen.html',
                reasons: ['DOM_SCRAPING'],
                justification: 'Allocating memory beyond Chrome extension limits'
            });
        } catch (error) {
            chrome.runtime.onMessage.removeListener(readyListener);
            console.error('[Background] Failed to create offscreen document:', error);
            throw new Error(`Cannot create offscreen document: ${error.message}. Make sure the extension has offscreen permission.`);
        }

        // Verify offscreen document exists
        const hasDoc = await chrome.offscreen.hasDocument();
        if (!hasDoc) {
            chrome.runtime.onMessage.removeListener(readyListener);
            throw new Error('Offscreen document was not created successfully');
        }

        // Wait for offscreen document to be ready
        console.log('[Background] Waiting for offscreen document to be ready...');
        console.log('[Background] Offscreen document created, checking if it exists...');
        
        // Verify document exists
        const docExists = await chrome.offscreen.hasDocument();
        console.log('[Background] Offscreen document exists:', docExists);
        
        if (!docExists) {
            chrome.runtime.onMessage.removeListener(readyListener);
            throw new Error('Offscreen document was not created successfully');
        }
        
        // Give the document a moment to load and execute inline script
        console.log('[Background] Waiting 800ms for document to load and execute inline script...');
        await new Promise(r => setTimeout(r, 800));
        
        // Try to wait for offscreen_ready message, but with a shorter timeout
        // If it doesn't arrive, we'll try pinging directly
        console.log('[Background] Waiting for offscreen_ready message (2 second timeout)...');
        console.log('[Background] Current offscreenReady state:', offscreenReady);
        
        let receivedReady = false;
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    console.warn('[Background] ⚠️ Timeout waiting for offscreen_ready, will try ping instead');
                    resolve(); // Don't reject, just continue
                }, 2000); // 2 second timeout

                // Check if already ready
                if (offscreenReady) {
                    console.log('[Background] Already ready, resolving immediately');
                    receivedReady = true;
                    clearTimeout(timeout);
                    resolve();
                } else {
                    // Poll every 50ms
                    const checkInterval = setInterval(() => {
                        if (offscreenReady) {
                            console.log('[Background] Ready flag set, resolving');
                            receivedReady = true;
                            clearInterval(checkInterval);
                            clearTimeout(timeout);
                            resolve();
                        }
                    }, 50);
                }
            });
        } catch (error) {
            console.warn('[Background] Error waiting for ready message:', error);
        }
        
        if (!receivedReady) {
            console.log('[Background] ⚠️ Did not receive offscreen_ready message, but will try ping anyway');
        } else {
            console.log('[Background] ✅ Received offscreen_ready message');
        }

        console.log('[Background] ✅ Received offscreen_ready, document is loaded');
        
        // Now ping to verify connection works
        console.log('[Background] Pinging offscreen document to verify connection...');
        console.log('[Background] ⚠️ IMPORTANT: Check offscreen document console for logs!');
        console.log('[Background] To view offscreen console: chrome://extensions -> REM Network Miner -> service worker -> click "offscreen" link');
        
        let pingSuccess = false;
        for (let i = 0; i < 10; i++) {
            try {
                // Increase delay between pings to give document more time
                if (i > 0) {
                    await new Promise(r => setTimeout(r, 300));
                }
                
                const pingResponse = await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        console.log(`[Background] Ping ${i + 1} timed out after 1 second`);
                        resolve(null);
                    }, 1000);
                    
                    chrome.runtime.sendMessage({ type: 'ping' }, (response) => {
                        clearTimeout(timeout);
                        if (chrome.runtime.lastError) {
                            console.error(`[Background] Ping ${i + 1} error:`, chrome.runtime.lastError.message);
                            resolve(null);
                        } else {
                            resolve(response);
                        }
                    });
                });
                
                if (pingResponse && pingResponse.type === 'pong') {
                    pingSuccess = true;
                    console.log(`[Background] ✅ Ping successful on attempt ${i + 1}, offscreen is responsive`);
                    break;
                } else {
                    console.log(`[Background] Ping attempt ${i + 1}/10: No pong response (got: ${JSON.stringify(pingResponse)})`);
                }
            } catch (error) {
                console.log(`[Background] Ping attempt ${i + 1} exception:`, error);
            }
        }

        if (!pingSuccess) {
            chrome.runtime.onMessage.removeListener(readyListener);
            const hasDoc = await chrome.offscreen.hasDocument();
            if (!hasDoc) {
                throw new Error('Offscreen document was closed or failed to load. Check browser console for script errors.');
            }
            throw new Error('Cannot establish connection with offscreen document. The document loaded but ping failed. Check browser console (chrome://extensions -> REM Network Miner -> service worker -> offscreen) for errors.');
        }
        
        // Wait a bit more for the main script to fully load
        console.log('[Background] Connection verified, waiting for main script to load...');
        await new Promise(r => setTimeout(r, 300));

        // Allocate memory sequentially in the single offscreen context
        // CRITICAL: Chrome has a ~15GB limit per offscreen document
        // We allocate in 1GB chunks, grouping into 12GB "contexts"
        const CHROME_OFFSCREEN_LIMIT_GB = 15;
        const CHUNK_SIZE_GB = 1; // Allocate in 1GB chunks
        const MAX_PER_CONTEXT_GB = 12; // Each context handles up to 12GB
        
        let remainingGB = totalGB;
        let contextIndex = 0;
        let totalAllocatedInDocument = 0;
        let currentContextAllocated = 0; // Track allocation for current context

        while (remainingGB > 0) {
            // Check if we need to start a new context (current one reached 12GB)
            if (currentContextAllocated >= MAX_PER_CONTEXT_GB) {
                console.log(`[Background] Context ${contextIndex} reached ${MAX_PER_CONTEXT_GB}GB, moving to next context`);
                contextIndex++;
                currentContextAllocated = 0;
            }
            
            // Check if we've hit the document limit (with buffer to prevent going over)
            const limitWithBuffer = CHROME_OFFSCREEN_LIMIT_GB - 0.5; // Leave 0.5GB buffer
            if (totalAllocatedInDocument >= limitWithBuffer) {
                console.warn(`[Background] ⚠️ Reached Chrome's offscreen document limit (${limitWithBuffer.toFixed(1)}GB). Cannot allocate remaining ${remainingGB.toFixed(1)}GB`);
                break;
            }
            
            // Allocate 1GB chunk (ensure we don't exceed limit)
            const availableGB = limitWithBuffer - totalAllocatedInDocument;
            const chunkGB = Math.min(CHUNK_SIZE_GB, remainingGB, availableGB);
            
            if (chunkGB <= 0) {
                break;
            }

            const contextId = `poram_context_${contextIndex}`;
            console.log(`[Background] Allocating ${chunkGB}GB chunk for context ${contextId} (${currentContextAllocated.toFixed(1)}GB / ${MAX_PER_CONTEXT_GB}GB in context, ${totalAllocatedInDocument.toFixed(1)}GB / ${CHROME_OFFSCREEN_LIMIT_GB}GB in document)`);

            // Initialize memory in offscreen context with proper error handling
            const initResponse = await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve({ success: false, error: 'Timeout waiting for offscreen response (5 minutes)' });
                }, 300000); // 5 min timeout

                const listener = (message, sender, sendResponse) => {
                    // Only handle messages from offscreen context
                    if (message.type === 'offscreen_initialized' && message.contextId === contextId) {
                        clearTimeout(timeout);
                        chrome.runtime.onMessage.removeListener(listener);
                        resolve({ success: true });
                        return true;
                    } else if (message.type === 'offscreen_error' && message.contextId === contextId) {
                        clearTimeout(timeout);
                        chrome.runtime.onMessage.removeListener(listener);
                        resolve({ success: false, error: message.error });
                        return true;
                    }
                    return false;
                };

                chrome.runtime.onMessage.addListener(listener);

                // Send initialization message to offscreen (no retry - response comes via message)
                chrome.offscreen.hasDocument().then(hasDoc => {
                    if (!hasDoc) {
                        clearTimeout(timeout);
                        chrome.runtime.onMessage.removeListener(listener);
                        resolve({ success: false, error: 'Offscreen document no longer exists' });
                        return;
                    }

                    // Send message - response will come via offscreen_initialized/offscreen_error message
                    // The listener returns false, so callback errors are expected and can be ignored
                    chrome.runtime.sendMessage({
                        type: 'initialize_memory',
                        contextId: contextId,
                        allocatedGB: chunkGB
                    }, () => {
                        // Callback is optional - ignore errors since response comes via message
                        if (!chrome.runtime.lastError) {
                            console.log(`[Background] Initialization message sent to offscreen for context ${contextId}, waiting for response...`);
                        }
                    });
                }).catch(error => {
                    clearTimeout(timeout);
                    chrome.runtime.onMessage.removeListener(listener);
                    resolve({ success: false, error: `Failed to verify offscreen document: ${error.message}` });
                });
            });

            if (!initResponse || !initResponse.success) {
                await chrome.offscreen.closeDocument();
                const errorResult = { success: false, error: `Failed to initialize context ${contextId}: ${initResponse?.error || 'Unknown error'}` };
                return respond(errorResult);
            }

            // Track allocation
            if (!allocations[contextId]) {
                if (!contextIds.includes(contextId)) {
                    contextIds.push(contextId);
                }
                allocations[contextId] = 0;
            }
            allocations[contextId] += chunkGB;
            currentContextAllocated += chunkGB;
            totalAllocatedInDocument += chunkGB;
            remainingGB -= chunkGB;

            console.log(`[Background] ✅ Allocated ${chunkGB}GB chunk`);
            console.log(`[Background] Context ${contextId}: ${allocations[contextId].toFixed(1)}GB / ${MAX_PER_CONTEXT_GB}GB, Document: ${totalAllocatedInDocument.toFixed(1)}GB / ${CHROME_OFFSCREEN_LIMIT_GB}GB, Remaining: ${remainingGB.toFixed(1)}GB`);
        }
        
        if (remainingGB > 0) {
            console.warn(`[Background] ⚠️ WARNING: Could only allocate ${(totalGB - remainingGB).toFixed(1)}GB out of ${totalGB}GB requested due to Chrome's 15GB offscreen document limit`);
            console.warn(`[Background] ⚠️ Remaining ${remainingGB.toFixed(1)}GB cannot be allocated. Consider reducing RAM commitment or using a different approach.`);
        }

        const result = {
            success: true,
            contextIds: contextIds,
            allocations: allocations
        };
        
        return respond(result);

    } catch (error) {
        console.error('[Background] Error creating offscreen contexts:', error);
        const errorResult = { success: false, error: error.message };
        return respond(errorResult);
    }
}

/**
 * Generate chunk in offscreen context
 */
async function handleGenerateChunk(message, sendResponse) {
    try {
        const { contextId, epochSeedHex, offset, chunkSize } = message;

        // Send message to offscreen document
        const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'generate_chunk',
                epochSeedHex: epochSeedHex,
                offset: offset,
                chunkSize: chunkSize
            }, resolve);
        });

        sendResponse(response || { success: false, error: 'No response from offscreen context' });

    } catch (error) {
        console.error('[Background] Error generating chunk:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Cleanup offscreen context
 */
async function handleCleanupOffscreen(message, sendResponse) {
    try {
        const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'cleanup'
            }, resolve);
        });

        sendResponse(response || { success: true });

    } catch (error) {
        console.error('[Background] Error cleaning up offscreen:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * INSANE MODE: Create multiple browser tabs for memory allocation
 * Each tab runs in a separate process with its own ~15GB memory limit
 * This allows us to allocate 15GB * N tabs (theoretically 128GB+ with 9 tabs)
 */
async function handleCreateMemoryTabs(message, sendResponse) {
    const respond = (result) => {
        if (typeof sendResponse === 'function') {
            sendResponse(result);
        }
        return result;
    };

    try {
        const { totalGB, gbPerTab } = message;
        const numTabsNeeded = Math.ceil(totalGB / gbPerTab);
        
        console.log(`[Background] 🚀 INSANE MODE: Creating ${numTabsNeeded} memory tabs for ${totalGB}GB...`);
        console.log(`[Background] Each tab can allocate up to ${gbPerTab}GB (separate process = separate 15GB limit)`);

        const tabIds = [];
        const allocations = {};
        let remainingGB = totalGB;
        let tabIndex = 0;

        // Set up listener for tab initialization
        const tabListeners = new Map(); // tabId -> {resolve, reject, timeout}

        const messageListener = (message, sender, sendResponse) => {
            if (message.type === 'memory_tab_ready') {
                // Tab is ready, can start initialization
                return false;
            }

            if (message.type === 'memory_tab_initialized') {
                const { tabId, contextId, allocatedGB } = message;
                console.log(`[Background] 📨 Received memory_tab_initialized from tab ${tabId}: ${allocatedGB.toFixed(1)}GB`);
                const listener = tabListeners.get(tabId);
                if (listener) {
                    clearTimeout(listener.timeout);
                    tabListeners.delete(tabId);
                    console.log(`[Background] ✅ Resolving promise for tab ${tabId}`);
                    listener.resolve({ success: true, allocatedGB });
                } else {
                    console.warn(`[Background] ⚠️ No listener found for tab ${tabId} (may have timed out)`);
                }
                return false;
            }

            if (message.type === 'memory_tab_error') {
                const { tabId, contextId, error } = message;
                const listener = tabListeners.get(tabId);
                if (listener) {
                    clearTimeout(listener.timeout);
                    tabListeners.delete(tabId);
                    listener.reject(new Error(error));
                }
                return false;
            }

            return false;
        };

        chrome.runtime.onMessage.addListener(messageListener);

        // Create tabs and allocate memory in each
        while (remainingGB > 0 && tabIndex < numTabsNeeded) {
            const tabGB = Math.min(gbPerTab, remainingGB);
            const contextId = `memory_tab_${tabIndex}`;

            console.log(`[Background] Creating memory tab ${tabIndex + 1}/${numTabsNeeded} for ${tabGB.toFixed(1)}GB...`);

            // Create tab
            const tab = await chrome.tabs.create({
                url: chrome.runtime.getURL('memory-tab.html'),
                active: false // Hidden tab
            });

            const tabId = tab.id;
            tabIds.push(tabId);

            console.log(`[Background] Tab ${tabId} created, waiting for it to load...`);

            // Wait for tab to load and be ready
            // We'll wait for both: tab status = complete AND memory_tab_ready message
            let tabLoaded = false;
            let readyMessageReceived = false;
            
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.warn(`[Background] Tab ${tabId} ready timeout (loaded: ${tabLoaded}, ready: ${readyMessageReceived}), proceeding anyway...`);
                    resolve();
                }, 5000); // 5 second timeout
                
                const listener = (message) => {
                    if (message.type === 'memory_tab_ready') {
                        readyMessageReceived = true;
                        console.log(`[Background] ✅ Tab ready message received for tab ${tabId}`);
                        if (tabLoaded && readyMessageReceived) {
                            clearTimeout(timeout);
                            chrome.runtime.onMessage.removeListener(listener);
                            resolve();
                        }
                    }
                };
                chrome.runtime.onMessage.addListener(listener);
                
                // Check if tab is loaded
                const checkTab = setInterval(() => {
                    chrome.tabs.get(tabId, (tab) => {
                        if (tab && tab.status === 'complete') {
                            tabLoaded = true;
                            console.log(`[Background] ✅ Tab ${tabId} loaded (status: complete)`);
                            clearInterval(checkTab);
                            if (tabLoaded && readyMessageReceived) {
                                clearTimeout(timeout);
                                chrome.runtime.onMessage.removeListener(listener);
                                resolve();
                            }
                        }
                    });
                }, 100);
            });

            // Initialize memory in tab
            console.log(`[Background] Initializing ${tabGB.toFixed(1)}GB in tab ${tabId}...`);

            const initResult = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    tabListeners.delete(tabId);
                    reject(new Error(`Timeout waiting for tab ${tabId} initialization (5 minutes)`));
                }, 300000); // 5 min timeout

                tabListeners.set(tabId, { resolve, reject, timeout });

                // Send initialization message to tab via runtime message
                // Extension pages receive chrome.runtime messages, not chrome.tabs messages
                console.log(`[Background] 📤 Sending initialize_memory_tab message to tab ${tabId}...`);
                chrome.runtime.sendMessage({
                    type: 'initialize_memory_tab',
                    targetGB: tabGB,
                    contextId: contextId,
                    tabId: tabId
                }, (response) => {
                    // Response comes via memory_tab_initialized message, not callback
                    if (chrome.runtime.lastError) {
                        if (chrome.runtime.lastError.message.includes('Receiving end')) {
                            console.log(`[Background] ℹ️ Message sent (callback error expected - response comes via message)`);
                        } else {
                            console.warn(`[Background] ⚠️ Message send error for tab ${tabId}:`, chrome.runtime.lastError.message);
                        }
                    } else {
                        console.log(`[Background] ✅ Message sent to tab ${tabId} (response will come via memory_tab_initialized)`);
                    }
                });
            });

            if (!initResult.success) {
                throw new Error(`Tab ${tabId} initialization failed: ${initResult.error}`);
            }

            allocations[`tab_${tabId}`] = initResult.allocatedGB;
            remainingGB -= initResult.allocatedGB;
            tabIndex++;

            console.log(`[Background] ✅ Tab ${tabId} allocated ${initResult.allocatedGB.toFixed(1)}GB (${remainingGB.toFixed(1)}GB remaining)`);
        }

        chrome.runtime.onMessage.removeListener(messageListener);

        const result = {
            success: true,
            tabIds: tabIds,
            allocations: allocations
        };

        const totalAllocated = Object.values(allocations).reduce((sum, gb) => sum + gb, 0);
        console.log(`[Background] 🚀 INSANE MODE SUCCESS: ${totalAllocated.toFixed(1)}GB allocated across ${tabIds.length} tabs!`);

        return respond(result);

    } catch (error) {
        console.error('[Background] Error creating memory tabs:', error);
        return respond({ success: false, error: error.message });
    }
}

/**
 * Close offscreen contexts
 */
async function handleCloseOffscreenContexts(message, sendResponse) {
    try {
        const { contextIds } = message;

        for (const contextId of contextIds) {
            offscreenContexts.delete(contextId);
        }

        // Close offscreen document
        const hasDocument = await chrome.offscreen.hasDocument();
        if (hasDocument) {
            await chrome.offscreen.closeDocument();
        }

        sendResponse({ success: true });

    } catch (error) {
        console.error('[Background] Error closing offscreen contexts:', error);
        sendResponse({ success: false, error: error.message });
    }
}

console.log('[Background] Service worker initialized');
