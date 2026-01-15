/**
 * NetRot Cache Manager
 * Background script cache management with multi-layer architecture.
 * Part of the Hybrid caching architecture (Layers 2 & 3).
 */

class CacheManager {
    constructor() {
        this.memoryCache = new Map();
        this.pendingRequests = new Map();
        this.STORAGE_PREFIX = 'rating_';

        // TTL Configuration (in milliseconds)
        this.TTL = {
            SUCCESS_FULL: 7 * 24 * 60 * 60 * 1000,    // 7 days for complete data
            SUCCESS_PARTIAL: 24 * 60 * 60 * 1000,     // 1 day for partial data
            NOT_FOUND: 24 * 60 * 60 * 1000,           // 1 day for not found
            ERROR: 60 * 60 * 1000                      // 1 hour for errors
        };
    }

    /**
     * Get ratings from cache (memory -> storage -> null)
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year
     * @returns {Promise<{data: Object, source: string}|null>} Cached data or null
     */
    async get(title, year) {
        const keys = this.getSearchKeys(title, year);

        // Layer 2: Check memory cache first (all possible keys)
        for (const key of keys) {
            if (this.memoryCache.has(key)) {
                const entry = this.memoryCache.get(key);
                if (this.isValid(entry)) {
                    console.log(`[NetRot] Memory cache hit for "${title}"`);
                    return { data: entry.data, source: 'memory' };
                } else {
                    // Expired, remove from memory
                    this.memoryCache.delete(key);
                }
            }
        }

        // Layer 3: Check storage
        const storageKeys = keys.map(k => this.STORAGE_PREFIX + k);
        try {
            const stored = await chrome.storage.local.get(storageKeys);

            for (const key of storageKeys) {
                if (stored[key] && this.isValid(stored[key])) {
                    console.log(`[NetRot] Storage cache hit for "${title}"`);
                    // Promote to memory cache
                    const cacheKey = key.replace(this.STORAGE_PREFIX, '');
                    this.memoryCache.set(cacheKey, stored[key]);
                    return { data: stored[key].data, source: 'storage' };
                }
            }
        } catch (e) {
            console.error('[NetRot] Storage read error:', e);
        }

        return null;
    }

    /**
     * Store ratings in both memory and storage
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year
     * @param {Object} data - Ratings data to cache
     */
    async set(title, year, data) {
        const key = this.getPrimaryKey(title, year);
        const ttl = this.getTTL(data);

        const entry = {
            data,
            timestamp: Date.now(),
            ttl,
            completeness: year ? 'full' : 'partial'
        };

        // Set in memory (Layer 2)
        this.memoryCache.set(key, entry);

        // Set in storage (Layer 3)
        try {
            await chrome.storage.local.set({
                [this.STORAGE_PREFIX + key]: entry
            });

            // Also create alias by IMDb ID if available
            if (data.imdbId) {
                this.memoryCache.set(data.imdbId, entry);
                await chrome.storage.local.set({
                    [this.STORAGE_PREFIX + data.imdbId]: entry
                });
            }

            // Create alias by normalized title (without year) for broader matching
            if (data.normalizedTitle && data.normalizedTitle !== key) {
                this.memoryCache.set(data.normalizedTitle, entry);
                await chrome.storage.local.set({
                    [this.STORAGE_PREFIX + data.normalizedTitle]: entry
                });
            }
        } catch (e) {
            console.error('[NetRot] Storage write error:', e);
        }
    }

    /**
     * Check if a request is already pending
     * @param {string} key - Request key
     * @returns {boolean} Whether request is pending
     */
    hasPendingRequest(key) {
        return this.pendingRequests.has(key);
    }

    /**
     * Get pending request promise
     * @param {string} key - Request key
     * @returns {Promise|null} Pending promise or null
     */
    getPendingRequest(key) {
        return this.pendingRequests.get(key) || null;
    }

    /**
     * Register a pending request
     * @param {string} key - Request key
     * @param {Promise} promise - Request promise
     */
    setPendingRequest(key, promise) {
        this.pendingRequests.set(key, promise);
    }

    /**
     * Remove a pending request
     * @param {string} key - Request key
     */
    deletePendingRequest(key) {
        this.pendingRequests.delete(key);
    }

    /**
     * Generate all possible search keys for a title
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year
     * @returns {string[]} Array of cache keys to check
     */
    getSearchKeys(title, year) {
        const normalized = this.normalizeTitle(title);
        const keys = [normalized]; // Always check year-less key

        if (year) {
            // Prefer year-specific key (insert at beginning)
            keys.unshift(`${normalized}_${year.substring(0, 4)}`);
        }

        return keys;
    }

    /**
     * Generate primary cache key
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year
     * @returns {string} Primary cache key
     */
    getPrimaryKey(title, year) {
        const normalized = this.normalizeTitle(title);
        return year ? `${normalized}_${year.substring(0, 4)}` : normalized;
    }

    /**
     * Normalize title for cache key generation
     * @param {string} title - Raw title
     * @returns {string} Normalized title
     */
    normalizeTitle(title) {
        return title.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    }

    /**
     * Get appropriate TTL based on response status
     * @param {Object} data - Response data
     * @returns {number} TTL in milliseconds
     */
    getTTL(data) {
        if (data.status === 'error') {
            return this.TTL.ERROR;
        }
        if (data.status === 'not_found') {
            return this.TTL.NOT_FOUND;
        }
        if (data.completeness === 'full') {
            return this.TTL.SUCCESS_FULL;
        }
        return this.TTL.SUCCESS_PARTIAL;
    }

    /**
     * Check if cache entry is still valid
     * @param {Object} entry - Cache entry
     * @returns {boolean} Whether entry is valid
     */
    isValid(entry) {
        if (!entry || !entry.timestamp) return false;
        const ttl = entry.ttl || this.TTL.SUCCESS_FULL;
        return (Date.now() - entry.timestamp) < ttl;
    }

    /**
     * Clear all caches
     */
    async clear() {
        this.memoryCache.clear();
        this.pendingRequests.clear();

        // Clear storage entries with our prefix
        try {
            const allItems = await chrome.storage.local.get(null);
            const keysToRemove = Object.keys(allItems)
                .filter(key => key.startsWith(this.STORAGE_PREFIX));
            await chrome.storage.local.remove(keysToRemove);
        } catch (e) {
            console.error('[NetRot] Cache clear error:', e);
        }
    }

    /**
     * Get cache statistics
     * @returns {Promise<Object>} Cache statistics
     */
    async getStats() {
        let storageCount = 0;
        try {
            const allItems = await chrome.storage.local.get(null);
            storageCount = Object.keys(allItems)
                .filter(key => key.startsWith(this.STORAGE_PREFIX)).length;
        } catch (e) {
            console.error('[NetRot] Stats error:', e);
        }

        return {
            memorySize: this.memoryCache.size,
            storageSize: storageCount,
            pendingRequests: this.pendingRequests.size
        };
    }
}

/**
 * Rate Limiter - Token bucket algorithm
 * Prevents overwhelming the OMDb API
 */
class RateLimiter {
    constructor(maxRequests = 10, windowMs = 1000) {
        this.tokens = maxRequests;
        this.maxTokens = maxRequests;
        this.windowMs = windowMs;
        this.lastRefill = Date.now();
        this.queue = [];
        this.processing = false;
    }

    /**
     * Acquire a token to make a request
     * @returns {Promise<boolean>} Resolves when token acquired
     */
    async acquire() {
        this.refillTokens();

        if (this.tokens > 0) {
            this.tokens--;
            return true;
        }

        // Wait for next refill
        const waitTime = this.windowMs - (Date.now() - this.lastRefill);
        await new Promise(resolve => setTimeout(resolve, Math.max(waitTime, 100)));
        return this.acquire();
    }

    /**
     * Refill tokens based on elapsed time
     */
    refillTokens() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;

        if (elapsed >= this.windowMs) {
            this.tokens = this.maxTokens;
            this.lastRefill = now;
        }
    }
}


// Singleton instances
const cacheManager = new CacheManager();
const rateLimiter = new RateLimiter(10, 1000); // 10 requests per second max
