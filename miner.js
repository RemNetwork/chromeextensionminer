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
    constructor(config) {
        this.config = config;
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
                console.log('[Miner] ✅ Connected to coordinator');
                this.connected = true;
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

            this.ws.onclose = () => {
                console.log('[Miner] Disconnected from coordinator');
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
            node_id: this.config.node_id,
            capacity_gb: this.config.max_ram_gb,
            embedding_dim: this.config.embedding_dim,
            index_version: this.config.index_version,
            secret: this.config.miner_secret,
            sui_address: this.config.sui_address,
            referral_code: this.config.referral_address || null
        };

        console.log('[Miner] Sending registration:', {
            node_id: registerMsg.node_id,
            capacity_gb: registerMsg.capacity_gb,
            sui_address: registerMsg.sui_address,
            has_secret: !!registerMsg.secret,
            secret_length: registerMsg.secret?.length || 0
        });

        this.send(registerMsg);

        // Wait for confirmation (if we start receiving heartbeats, we're registered)
        setTimeout(() => {
            if (!this.registered) {
                console.log('[Miner] ✅ Registration successful (no error received)');
                this.registered = true;
                this.startHeartbeat();
            }
        }, 2000);
    }

    /**
     * Start sending heartbeats
     */
    startHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }

        // Send heartbeat every 30 seconds
        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeat();
        }, 30000);

        // Send first heartbeat immediately
        this.sendHeartbeat();
    }

    /**
     * Send heartbeat message
     */
    sendHeartbeat() {
        if (!this.connected) return;

        const heartbeat = {
            type: 'heartbeat',
            node_id: this.config.node_id,
            vectors_stored: this.engine.getTotalVectors(),
            bytes_used: this.engine.getBytesUsed(),
            timestamp: new Date().toISOString()
        };

        this.send(heartbeat);
        this.stats.lastHeartbeat = new Date().toISOString();

        console.log('[Miner] ❤️ Heartbeat sent:', {
            vectors: heartbeat.vectors_stored,
            bytes: heartbeat.bytes_used
        });
    }

    /**
     * Handle incoming message from coordinator
     */
    async handleMessage(message) {
        const type = message.type;

        console.log(`[Miner] Received message: ${type}`);

        switch (type) {
            case 'store_request':
                await this.handleStore(message);
                break;

            case 'search_request':
                await this.handleSearch(message);
                break;

            case 'challenge_request':
                await this.handleChallenge(message);
                break;

            case 'error':
                console.error('[Miner] Error from coordinator:', message.error_message);
                // If registration error, try again
                if (message.error_message.includes('secret') ||
                    message.error_message.includes('signature')) {
                    console.log('[Miner] Registration failed, retrying in 10s...');
                    setTimeout(() => this.register(), 10000);
                }
                break;

            default:
                console.warn('[Miner] Unknown message type:', type);
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
        console.log('[Miner] Handling PoRAM challenge:', {
            challenge_id: request.challenge_id,
            offsets: request.offsets.length,
            chunk_size: request.chunk_size
        });

        try {
            const response = await this.poram.handleChallenge(request);

            // Send response
            this.send({
                type: 'challenge_response',
                ...response
            });

            this.stats.challengesCompleted++;

            console.log('[Miner] ✅ Challenge response sent');

        } catch (error) {
            console.error('[Miner] Challenge error:', error);

            this.send({
                type: 'challenge_response',
                challenge_id: request.challenge_id,
                chunks: [],
                response_time_ms: 0
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

        return {
            connected: this.connected,
            registered: this.registered,
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
