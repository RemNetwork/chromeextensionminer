/**
 * Vector Engine for Chrome Extension
 * Stores and searches vector embeddings using cosine similarity
 * Uses IndexedDB for persistence
 */

export class VectorEngine {
    constructor(maxRAM_GB) {
        this.maxRAM = maxRAM_GB * 1024 * 1024 * 1024;
        this.collections = new Map(); // collection_id -> { vectors, docIds, shard_id }
        this.db = null;
        this.dbName = 'dvm-vectors';
        this.embeddingDim = 384; // Default, will be updated from config
    }

    /**
     * Initialize vector engine and open IndexedDB
     */
    async init() {
        console.log('[VectorEngine] Initializing...');

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = () => {
                console.error('[VectorEngine] Failed to open IndexedDB:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                console.log('[VectorEngine] IndexedDB opened successfully');

                // Load existing collections from disk
                this.loadAll().then(() => {
                    console.log('[VectorEngine] Loaded existing collections');
                    resolve();
                }).catch(reject);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Create object stores
                if (!db.objectStoreNames.contains('collections')) {
                    db.createObjectStore('collections', { keyPath: 'id' });
                }

                if (!db.objectStoreNames.contains('metadata')) {
                    db.createObjectStore('metadata', { keyPath: 'key' });
                }
            };
        });
    }

    /**
     * Add vectors to a collection
     * @param {string} collectionId - Collection identifier
     * @param {Array<Float32Array>} vectors - Array of embedding vectors
     * @param {Array<string>} docIds - Corresponding document IDs
     * @param {string|null} shardId - Optional shard ID
     */
    async addVectors(collectionId, vectors, docIds, shardId = null) {
        const key = this.getCollectionKey(collectionId, shardId);

        console.log(`[VectorEngine] Adding ${vectors.length} vectors to ${key}`);

        if (!this.collections.has(key)) {
            this.collections.set(key, {
                collectionId,
                shardId,
                vectors: [],
                docIds: [],
                metadata: []
            });
        }

        const collection = this.collections.get(key);

        // Check capacity
        const newBytesNeeded = vectors.length * this.embeddingDim * 4; // 4 bytes per float32
        const currentBytes = this.getBytesUsed();

        if (currentBytes + newBytesNeeded > this.maxRAM) {
            throw new Error(`Storage full: ${currentBytes + newBytesNeeded} bytes exceeds ${this.maxRAM} bytes`);
        }

        // Add vectors
        collection.vectors.push(...vectors);
        collection.docIds.push(...docIds);

        // Persist to IndexedDB (background)
        await this.saveCollection(key);

        console.log(`[VectorEngine] Added ${vectors.length} vectors. Total: ${collection.vectors.length}`);
    }

    /**
     * Search for similar vectors
     * @param {string} collectionId - Collection identifier
     * @param {Float32Array} queryVector - Query embedding
     * @param {number} k - Number of results to return
     * @param {string|null} shardId - Optional shard ID
     * @returns {Array<{docId: string, score: number}>}
     */
    async search(collectionId, queryVector, k = 10, shardId = null) {
        const key = this.getCollectionKey(collectionId, shardId);
        const collection = this.collections.get(key);

        if (!collection) {
            console.warn(`[VectorEngine] Collection ${key} not found`);
            return [];
        }

        console.log(`[VectorEngine] Searching ${collection.vectors.length} vectors in ${key}`);

        // Compute cosine similarity for all vectors
        const scores = collection.vectors.map((vec, idx) => ({
            docId: collection.docIds[idx],
            score: this.cosineSimilarity(queryVector, vec)
        }));

        // Sort by score descending and return top-k
        scores.sort((a, b) => b.score - a.score);
        const results = scores.slice(0, k);

        console.log(`[VectorEngine] Found ${results.length} results, top score: ${results[0]?.score.toFixed(4)}`);

        return results;
    }

    /**
     * Cosine similarity between two vectors
     * @param {Float32Array|Array} a - First vector
     * @param {Float32Array|Array} b - Second vector
     * @returns {number} Similarity score (0-1)
     */
    cosineSimilarity(a, b) {
        if (a.length !== b.length) {
            throw new Error(`Vector dimension mismatch: ${a.length} != ${b.length}`);
        }

        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);

        if (denominator === 0) {
            return 0;
        }

        return dotProduct / denominator;
    }

    /**
     * Get collection key (handles sharding)
     */
    getCollectionKey(collectionId, shardId) {
        return shardId ? `${collectionId}:${shardId}` : collectionId;
    }

    /**
     * Get total number of vectors stored
     */
    getTotalVectors() {
        let total = 0;
        for (const collection of this.collections.values()) {
            total += collection.vectors.length;
        }
        return total;
    }

    /**
     * Get approximate bytes used
     */
    getBytesUsed() {
        const totalVectors = this.getTotalVectors();
        return totalVectors * this.embeddingDim * 4; // 4 bytes per float32
    }

    /**
     * Save a collection to IndexedDB
     */
    async saveCollection(key) {
        if (!this.db) return;

        const collection = this.collections.get(key);
        if (!collection) return;

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['collections'], 'readwrite');
            const store = transaction.objectStore('collections');

            // Convert Float32Arrays to regular arrays for storage
            const data = {
                id: key,
                collectionId: collection.collectionId,
                shardId: collection.shardId,
                vectors: collection.vectors.map(v => Array.from(v)),
                docIds: collection.docIds,
                metadata: collection.metadata,
                savedAt: new Date().toISOString()
            };

            const request = store.put(data);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Load all collections from IndexedDB
     */
    async loadAll() {
        if (!this.db) return;

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['collections'], 'readonly');
            const store = transaction.objectStore('collections');
            const request = store.getAll();

            request.onsuccess = () => {
                const collections = request.result;

                console.log(`[VectorEngine] Loading ${collections.length} collections from IndexedDB`);

                for (const data of collections) {
                    // Convert arrays back to Float32Arrays
                    const collection = {
                        collectionId: data.collectionId,
                        shardId: data.shardId,
                        vectors: data.vectors.map(v => new Float32Array(v)),
                        docIds: data.docIds,
                        metadata: data.metadata || []
                    };

                    this.collections.set(data.id, collection);

                    console.log(`[VectorEngine] Loaded collection: ${data.id} (${collection.vectors.length} vectors)`);
                }

                resolve();
            };

            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Save all collections
     */
    async saveAll() {
        const promises = [];
        for (const key of this.collections.keys()) {
            promises.push(this.saveCollection(key));
        }
        await Promise.all(promises);
        console.log(`[VectorEngine] Saved ${promises.length} collections`);
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            collections: this.collections.size,
            total_vectors: this.getTotalVectors(),
            bytes_used: this.getBytesUsed(),
            bytes_available: this.maxRAM - this.getBytesUsed(),
            usage_percentage: ((this.getBytesUsed() / this.maxRAM) * 100).toFixed(2)
        };
    }

    /**
     * Clear all data
     */
    async clearAll() {
        console.log('[VectorEngine] Clearing all data...');
        this.collections.clear();

        if (this.db) {
            return new Promise((resolve, reject) => {
                const transaction = this.db.transaction(['collections'], 'readwrite');
                const store = transaction.objectStore('collections');
                const request = store.clear();

                request.onsuccess = () => {
                    console.log('[VectorEngine] All data cleared');
                    resolve();
                };
                request.onerror = () => reject(request.error);
            });
        }
    }
}
