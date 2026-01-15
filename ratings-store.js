/**
 * NetRot Ratings Store
 * Content script session cache with event-driven updates.
 * Part of the Hybrid caching architecture (Layer 1).
 */

class RatingsStore {
    constructor() {
        this.cache = new Map();
        this.subscribers = new Map();
        this.pendingRequests = new Map();
    }

    /**
     * Subscribe to ratings updates for a specific key
     * @param {string} key - Cache key (normalized title or imdbId)
     * @param {Function} callback - Called with data on updates
     * @returns {Function} Unsubscribe function
     */
    subscribe(key, callback) {
        if (!this.subscribers.has(key)) {
            this.subscribers.set(key, new Set());
        }
        this.subscribers.get(key).add(callback);

        // Return current value immediately if available
        if (this.cache.has(key)) {
            callback(this.cache.get(key));
        }

        // Return unsubscribe function
        return () => this.subscribers.get(key)?.delete(callback);
    }

    /**
     * Get ratings data, checking cache first then fetching if needed
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year
     * @returns {Promise<Object|null>} Ratings data or null
     */
    async get(title, year = null) {
        const key = this.getKey(title, year);
        const altKey = this.getKey(title); // Year-less key for broader matching

        // Check exact key first
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }

        // Check alternate (year-less) key
        if (year && this.cache.has(altKey)) {
            const existing = this.cache.get(altKey);
            // If we now have year and data is partial, consider enrichment
            if (existing.completeness === 'partial') {
                return this.fetchWithEnrichment(title, year, existing, key);
            }
            return existing;
        }

        // Not in cache, need to fetch
        return this.fetch(title, year, key);
    }

    /**
     * Fetch ratings from background script with request deduplication
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year  
     * @param {string} key - Cache key
     * @returns {Promise<Object|null>} Ratings data or null
     */
    async fetch(title, year, key) {
        // Deduplicate concurrent requests for the same key
        if (this.pendingRequests.has(key)) {
            return this.pendingRequests.get(key);
        }

        const promise = new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'FETCH_RATINGS',
                title,
                year
            }, (response) => {
                this.pendingRequests.delete(key);

                if (chrome.runtime.lastError) {
                    console.error('[NetRot] Message error:', chrome.runtime.lastError);
                    resolve(null);
                    return;
                }

                if (response?.success) {
                    this.set(key, response.data);
                    resolve(response.data);
                } else {
                    // Store error state to prevent repeated failed requests
                    const errorData = {
                        status: 'error',
                        error: response?.error || 'Unknown error',
                        fetchedAt: Date.now()
                    };
                    this.set(key, errorData);
                    resolve(errorData);
                }
            });
        });

        this.pendingRequests.set(key, promise);
        return promise;
    }

    /**
     * Fetch with enrichment for partial data
     * @param {string} title - Movie/show title
     * @param {string} year - Release year
     * @param {Object} existing - Existing partial data
     * @param {string} key - New cache key with year
     * @returns {Promise<Object>} Enriched or existing data
     */
    async fetchWithEnrichment(title, year, existing, key) {
        // Check if pending enrichment request exists
        if (this.pendingRequests.has(key)) {
            return this.pendingRequests.get(key);
        }

        const promise = new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'FETCH_RATINGS',
                title,
                year,
                enrichExisting: true
            }, (response) => {
                this.pendingRequests.delete(key);

                if (chrome.runtime.lastError || !response?.success) {
                    // Keep existing data on failure
                    resolve(existing);
                    return;
                }

                // Merge data, preferring fresh values
                const enriched = this.mergeData(existing, response.data);
                this.set(key, enriched);
                resolve(enriched);
            });
        });

        this.pendingRequests.set(key, promise);
        return promise;
    }

    /**
     * Set data in cache and notify subscribers
     * @param {string} key - Cache key
     * @param {Object} data - Ratings data
     */
    set(key, data) {
        this.cache.set(key, data);

        // Also set by IMDb ID if available for cross-referencing
        if (data.imdbId) {
            this.cache.set(data.imdbId, data);
        }

        // Also set by normalized title (without year) for broader matching
        if (data.normalizedTitle && key !== data.normalizedTitle) {
            this.cache.set(data.normalizedTitle, data);
        }

        // Notify all subscribers
        this.notify(key, data);
    }

    /**
     * Notify subscribers of data update
     * @param {string} key - Primary cache key
     * @param {Object} data - Updated data
     */
    notify(key, data) {
        // Notify primary key subscribers
        this.subscribers.get(key)?.forEach(cb => {
            try {
                cb(data);
            } catch (e) {
                console.error('[NetRot] Subscriber callback error:', e);
            }
        });

        // Also notify IMDb ID subscribers
        if (data.imdbId && data.imdbId !== key) {
            this.subscribers.get(data.imdbId)?.forEach(cb => {
                try {
                    cb(data);
                } catch (e) {
                    console.error('[NetRot] Subscriber callback error:', e);
                }
            });
        }

        // Notify normalized title subscribers
        if (data.normalizedTitle && data.normalizedTitle !== key) {
            this.subscribers.get(data.normalizedTitle)?.forEach(cb => {
                try {
                    cb(data);
                } catch (e) {
                    console.error('[NetRot] Subscriber callback error:', e);
                }
            });
        }
    }

    /**
     * Merge existing partial data with fresh data
     * @param {Object} existing - Existing data
     * @param {Object} fresh - Newly fetched data
     * @returns {Object} Merged data
     */
    mergeData(existing, fresh) {
        return {
            ...existing,
            ...fresh,
            imdbId: fresh.imdbId || existing.imdbId,
            year: fresh.year || existing.year,
            ratings: {
                imdb: {
                    score: this.getValidValue(fresh.ratings?.imdb?.score, existing.ratings?.imdb?.score),
                    votes: fresh.ratings?.imdb?.votes || existing.ratings?.imdb?.votes
                },
                rottenTomatoes: {
                    score: this.getValidValue(fresh.ratings?.rottenTomatoes?.score, existing.ratings?.rottenTomatoes?.score)
                },
                metacritic: {
                    score: this.getValidValue(fresh.ratings?.metacritic?.score, existing.ratings?.metacritic?.score)
                }
            },
            completeness: 'full',
            fetchedAt: Date.now()
        };
    }

    /**
     * Get valid (non-N/A) value, preferring new over existing
     * @param {string} newVal - New value
     * @param {string} existingVal - Existing value
     * @returns {string|null} Valid value or null
     */
    getValidValue(newVal, existingVal) {
        if (newVal && newVal !== 'N/A') return newVal;
        if (existingVal && existingVal !== 'N/A') return existingVal;
        return null;
    }

    /**
     * Generate cache key from title and optional year
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year
     * @returns {string} Cache key
     */
    getKey(title, year = null) {
        const normalized = this.normalizeTitle(title);
        return year ? `${normalized}_${year.substring(0, 4)}` : normalized;
    }

    /**
     * Normalize title for consistent cache keys
     * @param {string} title - Raw title
     * @returns {string} Normalized title
     */
    normalizeTitle(title) {
        return title.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    }

    /**
     * Check if we have data for a title (any completeness level)
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year
     * @returns {boolean} Whether data exists
     */
    has(title, year = null) {
        const key = this.getKey(title, year);
        if (this.cache.has(key)) return true;
        if (year) return this.cache.has(this.getKey(title));
        return false;
    }

    /**
     * Clear all cached data (for testing/debugging)
     */
    clear() {
        this.cache.clear();
        this.pendingRequests.clear();
        // Keep subscribers - they may still want updates
    }

    /**
     * Get cache statistics for debugging
     * @returns {Object} Cache stats
     */
    getStats() {
        return {
            cacheSize: this.cache.size,
            pendingRequests: this.pendingRequests.size,
            subscriberCount: Array.from(this.subscribers.values())
                .reduce((sum, set) => sum + set.size, 0)
        };
    }
}

// Export singleton instance
const ratingsStore = new RatingsStore();
