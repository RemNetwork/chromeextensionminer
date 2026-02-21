/**
 * Background Service Worker
 * Manages the miner lifecycle and keeps it running
 */

import { WebSocketMiner } from './miner.js';

let miner = null;
let minerConfig = null;

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
    return config &&
        config.sui_address &&
        config.max_ram_gb > 0;
}

/**
 * Start the miner
 */
async function startMiner() {
    if (miner) {
        console.log('[Background] Miner already running');
        return;
    }

    if (!minerConfig || !isConfigComplete(minerConfig)) {
        console.error('[Background] Cannot start miner: config incomplete');
        return;
    }

    console.log('[Background] Starting miner...');

    try {
        // Pass callback to save config when Node ID is assigned
        miner = new WebSocketMiner(minerConfig, async (newConfig) => {
            minerConfig = newConfig;
            await chrome.storage.local.set({ minerConfig: newConfig });
            console.log('[Background] Config updated from miner (Node ID assigned/updated)');
        });
        await miner.start();

        console.log('[Background] ✅ Miner started successfully');

        // Update badge (icon change disabled - causes errors)
        // chrome.action.setIcon({ path: 'icons/icon-active.png' });
        chrome.action.setBadgeText({ text: '●' });
        chrome.action.setBadgeBackgroundColor({ color: '#10b981' });

    } catch (error) {
        console.error('[Background] Failed to start miner:', error);
        miner = null;
    }
}

/**
 * Stop the miner
 */
async function stopMiner() {
    if (!miner) {
        console.log('[Background] Miner not running');
        return;
    }

    console.log('[Background] Stopping miner...');

    try {
        await miner.stop();
        miner = null;

        console.log('[Background] ✅ Miner stopped');

        // Update badge (icon change disabled)
        // chrome.action.setIcon({ path: 'icons/icon.png' });
        chrome.action.setBadgeText({ text: '' });

    } catch (error) {
        console.error('[Background] Error stopping miner:', error);
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
        await startMiner();
        sendResponse({ success: true });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

async function handleStopMiner(sendResponse) {
    try {
        await stopMiner();
        sendResponse({ success: true });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

async function handleGetConfig(sendResponse) {
    sendResponse({ config: minerConfig });
}

console.log('[Background] Service worker initialized');
