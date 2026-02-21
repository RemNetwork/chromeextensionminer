/**
 * Setup Wizard Controller - SIMPLIFIED
 * No crypto needed - just wallet address!
 */

// Generate UUID (inline - no crypto.js dependency)
function generateUUID() {
    return crypto.randomUUID();
}

// State
let currentStep = 1;
let config = {
    coordinator_url: 'wss://api.getrem.online/miners_ws',
    max_ram_gb: 4,
    embedding_dim: 384,
    index_version: 1,
    miner_secret: 'xuLHbzL7awVGHe-PQpAmwRuVJodUtwFRKGhSnAKS8pQ',
    node_id: '',
    sui_address: '',
    referral_address: 'f5e3a292-b3fc-480e-93c6-b475cffd6c18'
};

// Initialize
document.addEventListener('DOMContentLoaded', init);

function init() {
    console.log('[Setup] Initializing setup wizard...');

    // Setup event listeners
    setupEventListeners();

    // Load existing config if any (CRITICAL: Must load BEFORE generating node_id)
    // This ensures we preserve the existing node_id if config already exists
    loadExistingConfig().then(() => {
        // Did not generate node_id if missing - let coordinator assign it
        if (config.node_id) {
            console.log('[Setup] Preserved existing node_id:', config.node_id);
        } else {
            console.log('[Setup] No Node ID found. One will be assigned by the coordinator.');
        }
    });
}

/**
 * Setup all event listeners
 */
function setupEventListeners() {
    // Step 1: Configuration
    const ramSlider = document.getElementById('ramSlider');
    const ramValue = document.getElementById('ramValue');

    ramSlider.addEventListener('input', (e) => {
        const value = e.target.value;
        ramValue.textContent = value;
        config.max_ram_gb = parseInt(value);
    });

    document.getElementById('nextStep1').addEventListener('click', () => {
        // Save referral code
        const referralCode = document.getElementById('referralCode').value.trim();
        if (referralCode) {
            config.referral_address = referralCode;
        }

        goToStep(2);
    });

    // Step 2: Wallet
    document.getElementById('nextStep2').addEventListener('click', validateAndNextStep2);
    document.getElementById('backStep2').addEventListener('click', () => goToStep(1));

    // Step 3: Confirmation
    document.getElementById('backStep3').addEventListener('click', () => goToStep(2));
    document.getElementById('startMining').addEventListener('click', startMining);

    // Copy button
    const copyBtn = document.getElementById('copySuiAddress');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const address = document.getElementById('summaryAddress').textContent;
            copyToClipboard(address);
            copyBtn.textContent = '✅';
            setTimeout(() => {
                copyBtn.textContent = '📋';
            }, 2000);
        });
    }
}

/**
 * Load existing config if available
 * CRITICAL FIX: This now preserves node_id from existing config
 */
async function loadExistingConfig() {
    try {
        const response = await sendMessage({ type: 'getConfig' });

        if (response.config) {
            console.log('[Setup] Found existing config:', {
                has_node_id: !!response.config.node_id,
                has_sui_address: !!response.config.sui_address
            });

            // CRITICAL FIX: Preserve ALL existing config values, especially node_id
            if (response.config.node_id) {
                config.node_id = response.config.node_id;
                console.log('[Setup] Preserved existing node_id from config');
            }

            // Preserve other config values
            if (response.config.sui_address) {
                config.sui_address = response.config.sui_address;
            }
            if (response.config.max_ram_gb) {
                config.max_ram_gb = response.config.max_ram_gb;
            }
            if (response.config.referral_address) {
                config.referral_address = response.config.referral_address;
            }
            if (response.config.coordinator_url) {
                config.coordinator_url = response.config.coordinator_url;
            }

            // Ask if user wants to reconfigure (only if fully configured)
            if (response.config.sui_address && response.config.node_id) {
                if (confirm('You already have a miner configured. Do you want to reconfigure?')) {
                    // User wants to reconfigure - keep existing node_id but allow changing other settings
                    console.log('[Setup] User chose to reconfigure, preserving node_id:', config.node_id);
                } else {
                    // Close this tab
                    window.close();
                }
            }
        }
    } catch (error) {
        console.error('[Setup] Error loading config:', error);
    }
}

/**
 * Go to specific step
 */
function goToStep(step) {
    // Hide all steps
    document.querySelectorAll('.step-content').forEach(content => {
        content.classList.remove('active');
    });

    document.querySelectorAll('.step').forEach(stepEl => {
        stepEl.classList.remove('active', 'completed');
    });

    // Show current step
    document.getElementById(`step${step}`).classList.add('active');
    document.querySelector(`[data-step="${step}"]`).classList.add('active');

    // Mark previous steps as completed
    for (let i = 1; i < step; i++) {
        document.querySelector(`[data-step="${i}"]`).classList.add('completed');
    }

    // Update summary if going to step 3
    if (step === 3) {
        updateSummary();
    }

    currentStep = step;

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Validate step 2 and proceed
 */
function validateAndNextStep2() {
    const address = document.getElementById('suiAddress').value.trim();

    if (!address) {
        alert('Please enter your Sui wallet address');
        return;
    }

    // Validate address format
    if (!address.startsWith('0x') || address.length !== 66) {
        alert('Invalid Sui address format. Must be 66 characters starting with 0x');
        return;
    }

    // Update config
    config.sui_address = address;

    goToStep(3);
}

/**
 * Update summary in step 3
 */
function updateSummary() {
    document.getElementById('summaryRAM').textContent = `${config.max_ram_gb} GB`;
    document.getElementById('summaryAddress').textContent = formatAddress(config.sui_address);

    const referral = config.referral_address;
    if (referral && referral !== 'f5e3a292-b3fc-480e-93c6-b475cffd6c18') {
        document.getElementById('summaryReferral').textContent = referral.substring(0, 16) + '...';
    } else {
        document.getElementById('summaryReferral').textContent = 'Default (REM Network)';
    }

    // Calculate estimates (User requested ~10 REM for 15GB)
    const ramMultiplier = config.max_ram_gb * 0.7; // ~10.5 at 15GB
    document.getElementById('estimateEpoch').textContent = `~${formatNumber(ramMultiplier)} REM`;
    document.getElementById('estimateDay').textContent = `~${formatNumber(ramMultiplier * 24)} REM`;
}

/**
 * Start mining
 */
async function startMining() {
    showLoading('Saving configuration...');

    try {
        // Save config
        const saveResponse = await sendMessage({
            type: 'saveConfig',
            config: config
        });

        if (!saveResponse.success) {
            throw new Error('Failed to save configuration');
        }

        showLoading('Starting miner...');

        // Start miner
        const startResponse = await sendMessage({ type: 'startMiner' });

        if (startResponse.success) {
            showLoading('Miner started successfully! ✅');

            // Show success for 2 seconds then close
            setTimeout(() => {
                window.close();
            }, 2000);
        } else {
            throw new Error(startResponse.error || 'Failed to start miner');
        }

    } catch (error) {
        console.error('[Setup] Error starting miner:', error);
        hideLoading();
        alert('Error: ' + error.message);
    }
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
function showLoading(text = 'Processing...') {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    loadingText.textContent = text;
    overlay.classList.add('active');
}

/**
 * Hide loading overlay
 */
function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    overlay.classList.remove('active');
}

/**
 * Format address for display
 */
function formatAddress(address) {
    if (!address || address.length < 20) return address;
    return `${address.slice(0, 10)}...${address.slice(-8)}`;
}

/**
 * Format number with commas
 */
function formatNumber(num) {
    return num.toLocaleString();
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        console.log('[Setup] Copied to clipboard');
    } catch (error) {
        console.error('[Setup] Failed to copy:', error);
    }
}
