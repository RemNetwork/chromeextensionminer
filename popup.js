/**
 * Popup UI Controller
 * Updates the dashboard with real-time miner statistics
 */

// DOM Elements
const statusIndicator = document.getElementById('statusIndicator');
const ramCommitted = document.getElementById('ramCommitted');
const vectorsStored = document.getElementById('vectorsStored');
const uptime = document.getElementById('uptime');
const queriesServed = document.getElementById('queriesServed');
const storagePercent = document.getElementById('storagePercent');
const storageFill = document.getElementById('storageFill');
const walletAddress = document.getElementById('walletAddress');
const referralCode = document.getElementById('referralCode');
const copyReferralBtn = document.getElementById('copyReferralBtn');
const minerToggleInput = document.getElementById('minerToggleInput');
const settingsBtn = document.getElementById('settingsBtn');
const statsBtn = document.getElementById('statsBtn');
const loadingOverlay = document.getElementById('loadingOverlay');

let isMinerRunning = true; // Track miner state

/**
 * Initialize popup
 */
async function init() {
    console.log('[Popup] Initializing...');

    // Load stats immediately
    await updateStats();

    // Update stats every 2 seconds
    setInterval(updateStats, 2000);

    // Setup button handlers
    settingsBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'setup.html' });
    });

    statsBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://www.getrem.online/explorer.html' });
    });

    copyReferralBtn.addEventListener('click', async () => {
        const code = referralCode.textContent;
        if (code && code !== 'Loading...' && code !== 'Not available') {
            try {
                await navigator.clipboard.writeText(code);
                // Visual feedback
                const originalText = copyReferralBtn.textContent;
                copyReferralBtn.textContent = '✓';
                copyReferralBtn.style.backgroundColor = '#10b981';
                setTimeout(() => {
                    copyReferralBtn.textContent = originalText;
                    copyReferralBtn.style.backgroundColor = '';
                }, 1000);
            } catch (error) {
                console.error('[Popup] Error copying referral code:', error);
            }
        }
    });

    // Miner toggle handler
    minerToggleInput.addEventListener('change', async (e) => {
        const shouldRun = e.target.checked;
        minerToggleInput.disabled = true; // Disable during operation

        try {
            if (shouldRun) {
                console.log('[Popup] Starting miner...');
                await sendMessage({ type: 'startMiner' });
                isMinerRunning = true;
            } else {
                console.log('[Popup] Stopping miner...');
                await sendMessage({ type: 'stopMiner' });
                isMinerRunning = false;
            }
        } catch (error) {
            console.error('[Popup] Error toggling miner:', error);
            // Revert toggle on error
            minerToggleInput.checked = !shouldRun;
        } finally {
            minerToggleInput.disabled = false;
        }
    });
}

/**
 * Update statistics from background
 */
async function updateStats() {
    try {
        const response = await sendMessage({ type: 'getStats' });

        if (response.stats) {
            updateUI(response.stats);
        }
    } catch (error) {
        console.error('[Popup] Error updating stats:', error);
    }
}

/**
 * Update UI with stats
 */
function updateUI(stats) {
    // Update status indicator and sync toggle
    if (stats.connected && stats.registered) {
        statusIndicator.classList.add('online');
        statusIndicator.querySelector('.status-text').textContent = 'Online';
        if (!minerToggleInput.disabled) {
            minerToggleInput.checked = true;
        }
        isMinerRunning = true;
    } else if (stats.connected) {
        statusIndicator.classList.remove('online');
        statusIndicator.querySelector('.status-text').textContent = 'Connecting...';
        if (!minerToggleInput.disabled) {
            minerToggleInput.checked = true;
        }
        isMinerRunning = true;
    } else {
        statusIndicator.classList.remove('online');
        statusIndicator.querySelector('.status-text').textContent = 'Offline';
        // Only update toggle if miner is actually stopped (not just disconnected)
        if (!isMinerRunning && !minerToggleInput.disabled) {
            minerToggleInput.checked = false;
        }
    }

    // Update RAM committed
    if (stats.poram_stats) {
        ramCommitted.textContent = `${stats.poram_stats.committed_gb} GB`;
    }

    // Update vectors stored
    if (stats.engine_stats) {
        const totalVectors = stats.engine_stats.total_vectors || 0;
        vectorsStored.textContent = formatNumber(totalVectors);

        // Update storage progress
        const usagePercent = parseFloat(stats.engine_stats.usage_percentage) || 0;
        storagePercent.textContent = `${usagePercent.toFixed(1)}%`;
        storageFill.style.width = `${usagePercent}%`;
    }

    // Update uptime
    if (stats.uptime_formatted) {
        uptime.textContent = stats.uptime_formatted;
    }

    // Update queries served
    if (stats.queriesServed !== undefined) {
        queriesServed.textContent = formatNumber(stats.queriesServed);
    }

    // Update wallet address
    if (stats.sui_address) {
        walletAddress.textContent = formatAddress(stats.sui_address);
    }

    // Update referral code (node_id)
    if (stats.node_id) {
        referralCode.textContent = stats.node_id;
    } else {
        referralCode.textContent = 'Not available';
    }
}

/**
 * Format large numbers with commas
 */
function formatNumber(num) {
    if (num === 0) return '0';
    if (!num) return '--';
    return num.toLocaleString();
}

/**
 * Format wallet address (show first 10 and last 8 chars)
 */
function formatAddress(address) {
    if (!address || address.length < 20) return address;
    return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

/**
 * Send message to background script
 */
function sendMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(response);
            }
        });
    });
}

/**
 * Show loading overlay
 */
function showLoading() {
    loadingOverlay.classList.add('active');
}

/**
 * Hide loading overlay
 */
function hideLoading() {
    loadingOverlay.classList.remove('active');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
