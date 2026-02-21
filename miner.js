/**
 * WebSocket Miner Client
 * Connects to REM Network coordinator and handles mining operations
 */

import { VectorEngine } from './engine.js';
import { PoRAMManager } from './poram.js';

/**
 * Generate a UUID v4
 */
function generateUUID() {
    return crypto.randomUUID();
}

export class WebSocketMiner {
    constructor(config, onConfigUpdate) {
        this.config = config;
        this.onConfigUpdate = onConfigUpdate;
        this.ws = null;
        this.engine = new VectorEngine(config.max_ram_gb);
        this.poram = new PoRAMManager(config.max_ram_gb);
        this.heartbeatInterval = null;
        this.reconnectTimeout = null;
        this.connected = false;
        this.registered = false;
        this.stats = {
            totalVectorsStored: 0,
            queriesServed: 0,
            challengesCompleted: 0,
            lastHeartbeat: null,
            uptimeStart: Date.now()
        };
    }

    /**
     * Start the miner
     */
    async start() {
        console.log('[Miner] Starting miner...');

        // Initialize vector engine
        await this.engine.init();

        // Initialize PoRAM
        await this.poram.initialize();

        // Connect to coordinator
        await this.connect();
    }

    /**
     * Connect to coordinator WebSocket
     */
    async connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            console.log('[Miner] Already connected');
            return;
        }

        console.log(`[Miner] Connecting to ${this.config.coordinator_url}...`);

        try {
            this.ws = new WebSocket(this.config.coordinator_url);

            this.ws.onopen = async () => {
                console.log('[Miner] ✅ WebSocket opened, connecting to coordinator...');
                this.connected = true;
                this.registered = false; // Reset registration status on new connection
                await this.register();
            };

            this.ws.onmessage = async (event) => {
                try {
                    const message = JSON.parse(event.data);
                    await this.handleMessage(message);
                } catch (error) {
                    console.error('[Miner] Error handling message:', error);
                }
            };

            this.ws.onerror = (error) => {
                console.error('[Miner] WebSocket error:', error);
                this.connected = false;
            };

            this.ws.onclose = (event) => {
                console.log('[Miner] Disconnected from coordinator', {
                    code: event.code,
                    reason: event.reason || 'No reason provided',
                    wasClean: event.wasClean
                });
                this.connected = false;
                this.registered = false;

                if (this.heartbeatInterval) {
                    clearInterval(this.heartbeatInterval);
                    this.heartbeatInterval = null;
                }

                // Reconnect after 5 seconds
                console.log('[Miner] Reconnecting in 5 seconds...');
                this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
            };

        } catch (error) {
            console.error('[Miner] Connection error:', error);
            // Retry after 5 seconds
            this.reconnectTimeout = setTimeout(() => this.connect(), 5000);
        }
    }

    /**
     * Register with coordinator
     * NOTE: No signature required - blockchain verifies ownership at claim time
     */
    async register() {
        console.log('[Miner] Registering with coordinator...');

        const registerMsg = {
            type: 'register',
            node_id: this.config.node_id || "", // Allow empty for new assignment
            capacity_gb: this.config.max_ram_gb,
            embedding_dim: this.config.embedding_dim,
            index_version: this.config.index_version,
            secret: this.config.miner_secret,
            sui_address: this.config.sui_address,
            referral_code: this.config.referral_address || null,
            version: "1.0.5"
        };

        console.log('[Miner] Sending registration:', {
            node_id: registerMsg.node_id,
            capacity_gb: registerMsg.capacity_gb,
            sui_address: registerMsg.sui_address,
            has_secret: !!registerMsg.secret,
            secret_length: registerMsg.secret?.length || 0
        });

        this.send(registerMsg);

        // Set a timeout to retry if no response received
        // The actual registration confirmation will come via handleRegisterResponse
        setTimeout(() => {
            if (!this.registered) {
                console.warn('[Miner] ⚠️ No registration response received after 10 seconds, retrying...');
                // Don't set registered = true here - wait for actual confirmation
                // Retry registration
                this.register();
            }
        }, 10000);
    }

    /**
     * Start sending heartbeats
     */
    startHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        // Send heartbeat every 5 minutes (300 seconds) as per 1.0.4 standard
        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeat();
        }, 300000);

        // Send first heartbeat immediately
        this.sendHeartbeat();
    }

    /**
     * Send heartbeat message
     */
    sendHeartbeat() {
        if (!this.connected || !this.registered) {
            if (!this.connected) {
                console.warn('[Miner] ⚠️ Cannot send heartbeat: not connected');
            } else if (!this.registered) {
                console.warn('[Miner] ⚠️ Cannot send heartbeat: not registered');
            }
            return;
        }

        // Check WebSocket state before sending
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('[Miner] ⚠️ WebSocket not open, marking as disconnected');
            this.connected = false;
            return;
        }

        const heartbeat = {
            type: 'heartbeat',
            node_id: this.config.node_id,
            vectors_stored: this.engine.getTotalVectors(),
            bytes_used: this.engine.getBytesUsed(),
            timestamp: new Date().toISOString()
        };

        try {
            this.send(heartbeat);
            this.stats.lastHeartbeat = new Date().toISOString();

            console.log('[Miner] ❤️ Heartbeat sent:', {
                vectors: heartbeat.vectors_stored,
                bytes: heartbeat.bytes_used,
                registered: this.registered,
                connected: this.connected
            });
        } catch (error) {
            console.error('[Miner] Error sending heartbeat:', error);
            this.connected = false;
        }
    }

    /**
     * Handle incoming message from coordinator
     */
    async handleMessage(message) {
        const type = message.type;

        console.log(`[Miner] Received message: ${type}`);

        switch (type) {
            case 'welcome':
                await this.handleWelcome(message);
                break;

            case 'register_response':
                // Legacy support, but 'welcome' is preferred
                await this.handleRegisterResponse(message);
                break;

            case 'store_request':
                await this.handleStore(message);
                break;

            case 'search_request':
                await this.handleSearch(message);
                break;

            case 'challenge_request':
                await this.handleChallenge(message);
                break;

            case 'fetch_request':
                await this.handleFetch(message);
                break;

            case 'delete_request':
                await this.handleDelete(message);
                break;

            case 'heartbeat_ack':
                console.log('[Miner] Heartbeat acknowledged by coordinator');
                break;

            case 'error':
                console.error('[Miner] Error from coordinator:', message.error_message);
                // If registration error, try again
                if (message.error_message.includes('secret') ||
                    message.error_message.includes('signature') ||
                    message.error_message.includes('registration')) {
                    console.log('[Miner] Registration failed, retrying in 10s...');
                    this.registered = false;
                    setTimeout(() => this.register(), 10000);
                }
                break;

            default:
                console.warn('[Miner] Unknown message type:', type);
        }
    }

    /**
     * Handle Welcome message (Success response for 1.0.4+)
     */
    async handleWelcome(message) {
        console.log('[Miner] Received WELCOME message:', message);

        this.registered = true;

        // Check if Node ID was assigned/updated
        if (message.node_id && message.node_id !== this.config.node_id) {
            console.log(`[Miner] New Node ID assigned: ${message.node_id}`);
            this.config.node_id = message.node_id;

            // Persist revised config
            if (this.onConfigUpdate) {
                await this.onConfigUpdate(this.config);
            }
        }

        console.log('[Miner] ✅ Miner successfully registered and ready');

        // Start heartbeats now
        if (!this.heartbeatInterval) {
            this.startHeartbeat();
        }
    }

    /**
     * Handle registration response from coordinator
     */
    async handleRegisterResponse(message) {
        console.log('[Miner] Received registration response:', message);

        if (message.status === 'ok') {
            console.log('[Miner] ✅ Registration confirmed by coordinator');
            this.registered = true;

            // Start heartbeats now that we're registered
            if (!this.heartbeatInterval) {
                this.startHeartbeat();
            }
        } else {
            console.error('[Miner] Registration failed:', message.message || 'Unknown error');
            this.registered = false;

            // Retry registration after delay
            setTimeout(() => {
                if (!this.registered) {
                    console.log('[Miner] Retrying registration...');
                    this.register();
                }
            }, 5000);
        }
    }

    /**
     * Handle store request (save vectors)
     */
    async handleStore(request) {
        console.log('[Miner] Handling store request:', {
            request_id: request.request_id,
            collection_id: request.collection_id,
            shard_id: request.shard_id,
            doc_count: request.doc_ids.length
        });

        try {
            // Decode vectors from base64
            const vectors = this.decodeVectors(request.vectors_b64, request.shape);

            // Store vectors
            await this.engine.addVectors(
                request.collection_id,
                vectors,
                request.doc_ids,
                request.shard_id
            );

            // Send success response
            const response = {
                type: 'store_response',
                request_id: request.request_id,
                node_id: this.config.node_id,
                stored_count: request.doc_ids.length,
                status: 'ok'
            };

            this.send(response);

            this.stats.totalVectorsStored += request.doc_ids.length;

            console.log(`[Miner] ✅ Stored ${request.doc_ids.length} vectors`);

        } catch (error) {
            console.error('[Miner] Store error:', error);

            const response = {
                type: 'store_response',
                request_id: request.request_id,
                node_id: this.config.node_id,
                stored_count: 0,
                status: 'error',
                error_message: error.message
            };

            this.send(response);
        }
    }

    /**
     * Handle search request (find similar vectors)
     */
    async handleSearch(request) {
        console.log('[Miner] Handling search request:', {
            request_id: request.request_id,
            collection_id: request.collection_id,
            shard_id: request.shard_id,
            top_k: request.top_k
        });

        try {
            // Decode query vector
            const queryVector = this.decodeQueryVector(request.query_b64, request.shape);

            // Search
            const results = await this.engine.search(
                request.collection_id,
                queryVector,
                request.top_k,
                request.shard_id
            );

            // Send response
            const response = {
                type: 'search_response',
                request_id: request.request_id,
                node_id: this.config.node_id,
                results: results.map(r => ({
                    doc_id: r.docId,
                    score: r.score
                }))
            };

            this.send(response);

            this.stats.queriesServed++;

            console.log(`[Miner] ✅ Search completed, returned ${results.length} results`);

        } catch (error) {
            console.error('[Miner] Search error:', error);

            const response = {
                type: 'search_response',
                request_id: request.request_id,
                node_id: this.config.node_id,
                results: []
            };

            this.send(response);
        }
    }

    /**
     * Handle PoRAM challenge
     */
    async handleChallenge(request) {
        console.log('[Miner] 🎯 Handling PoRAM challenge:', {
            challenge_id: request.challenge_id,
            offsets: request.offsets?.length || 0,
            chunk_size: request.chunk_size,
            deadline_ms: request.deadline_ms,
            epoch_seed: request.epoch_seed ? request.epoch_seed.substring(0, 16) + '...' : 'missing',
            registered: this.registered,
            connected: this.connected
        });

        if (!this.registered) {
            console.error('[Miner] ❌ Received challenge but not registered! This should not happen.');
        }

        try {
            const response = await this.poram.handleChallenge(request);

            // Send response
            const responseMsg = {
                type: 'challenge_response',
                ...response
            };

            this.send(responseMsg);

            this.stats.challengesCompleted++;

            console.log('[Miner] ✅ Challenge response sent:', {
                challenge_id: response.challenge_id,
                chunks_count: response.chunks?.length || 0,
                response_time_ms: response.response_time_ms
            });

        } catch (error) {
            console.error('[Miner] ❌ Challenge error:', error);

            this.send({
                type: 'challenge_response',
                challenge_id: request.challenge_id,
                chunks: [],
                response_time_ms: 0
            });
        }
    }

    /**
     * Handle fetch request (retrieve vectors by ID)
     */
    async handleFetch(request) {
        console.log('[Miner] Handling fetch request:', {
            request_id: request.request_id,
            collection_id: request.collection_id,
            doc_count: request.doc_ids.length
        });

        try {
            const vectors = this.engine.fetchVectors(
                request.collection_id,
                request.doc_ids
            );

            this.send({
                type: 'fetch_response',
                request_id: request.request_id,
                node_id: this.config.node_id,
                vectors: vectors,
                status: 'ok'
            });

            console.log(`[Miner] Fetched ${vectors.length} vectors`);
        } catch (error) {
            console.error('[Miner] Fetch error:', error);

            this.send({
                type: 'fetch_response',
                request_id: request.request_id,
                node_id: this.config.node_id,
                vectors: [],
                status: 'error',
                error_message: error.message
            });
        }
    }

    /**
     * Handle delete request (remove vectors by ID)
     */
    async handleDelete(request) {
        console.log('[Miner] Handling delete request:', {
            request_id: request.request_id,
            collection_id: request.collection_id,
            doc_count: request.doc_ids.length
        });

        try {
            const deletedCount = await this.engine.deleteVectors(
                request.collection_id,
                request.doc_ids
            );

            this.send({
                type: 'delete_response',
                request_id: request.request_id,
                node_id: this.config.node_id,
                deleted_count: deletedCount,
                status: 'ok'
            });

            console.log(`[Miner] Deleted ${deletedCount} vectors`);
        } catch (error) {
            console.error('[Miner] Delete error:', error);

            this.send({
                type: 'delete_response',
                request_id: request.request_id,
                node_id: this.config.node_id,
                deleted_count: 0,
                status: 'error',
                error_message: error.message
            });
        }
    }

    /**
     * Send message to coordinator
     */
    send(message) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('[Miner] Cannot send, not connected');
            return;
        }

        try {
            this.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error('[Miner] Error sending message:', error);
        }
    }

    /**
     * Decode vectors from base64 + zstd compression
     * Format: base64(zstd(float32_array))
     */
    decodeVectors(vectors_b64, shape) {
        // Decode base64
        const compressed = atob(vectors_b64);
        const bytes = new Uint8Array(compressed.length);
        for (let i = 0; i < compressed.length; i++) {
            bytes[i] = compressed.charCodeAt(i);
        }

        // For now, assume uncompressed (TODO: add zstd decompression)
        // shape = [num_vectors, embedding_dim]
        const [numVectors, embeddingDim] = shape;
        const float32Array = new Float32Array(bytes.buffer);

        // Split into individual vectors
        const vectors = [];
        for (let i = 0; i < numVectors; i++) {
            const start = i * embeddingDim;
            const end = start + embeddingDim;
            vectors.push(float32Array.slice(start, end));
        }

        return vectors;
    }

    /**
     * Decode query vector from base64
     */
    decodeQueryVector(query_b64, shape) {
        // Decode base64
        const binary = atob(query_b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        // Convert to Float32Array
        const float32Array = new Float32Array(bytes.buffer);
        return float32Array;
    }

    /**
     * Get miner statistics
     */
    getStats() {
        const uptimeSeconds = Math.floor((Date.now() - this.stats.uptimeStart) / 1000);

        // Check actual WebSocket state for accurate connection status
        const wsState = this.ws ? this.ws.readyState : WebSocket.CLOSED;
        const actuallyConnected = wsState === WebSocket.OPEN && this.connected;

        return {
            connected: actuallyConnected,
            registered: this.registered,
            ws_state: wsState, // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
            node_id: this.config.node_id,
            sui_address: this.config.sui_address,
            uptime_seconds: uptimeSeconds,
            uptime_formatted: this.formatUptime(uptimeSeconds),
            ...this.stats,
            engine_stats: this.engine.getStats(),
            poram_stats: this.poram.getStats()
        };
    }

    /**
     * Format uptime in human-readable format
     */
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${days}d ${hours}h ${minutes}m`;
    }

    /**
     * Stop the miner
     */
    async stop() {
        console.log('[Miner] Stopping miner...');

        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        if (this.ws) {
            this.ws.close();
        }

        // Save all vectors
        await this.engine.saveAll();

        console.log('[Miner] Miner stopped');
    }
}
