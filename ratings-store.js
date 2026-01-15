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
    /**
     * Get ratings data, checking cache first then fetching if needed
     * @param {string|null} videoId - Netflix Video ID (preferred)
     * @param {string} title - Movie/show title
     * @param {string|null} year - Optional release year
     * @param {boolean} checkFreshness - If true, triggers a background refresh even if cached
     * @returns {Promise<Object|null>} Ratings data or null
     */
    async get(videoId, title, year = null, checkFreshness = false) {
        const key = this.getKey(videoId, title, year);

        // precise hit
        if (this.cache.has(key)) {
            const cached = this.cache.get(key);

            // If checking freshness, we generally want to trigger the background fetch
            // But we can still return the cached value immediately.
            // Our fetch() method implementation handles "pendingRequests", 
            // so calling fetch() again might dedup if one is already flight.

            if (checkFreshness) {
                // Trigger background refresh (fire and forget from UI perspective, but update cache)
                this.fetch(videoId, title, year, key, true);
            }

            return cached;
        }

        // If we have videoId, we rely on that. 
        // If we only have title/year (fallback), we might try yearless matching.
        if (!videoId && year) {
            const altKey = this.getKey(null, title);
            if (this.cache.has(altKey)) {
                const existing = this.cache.get(altKey);

                if (checkFreshness) {
                    this.fetchWithEnrichment(null, title, year, existing, this.getKey(null, title, year));
                } else if (existing.completeness === 'partial') {
                    return this.fetchWithEnrichment(null, title, year, existing, this.getKey(null, title, year));
                }
                return existing;
            }
        }

        // Not in cache, fetch
        return this.fetch(videoId, title, year, key, checkFreshness);
    }

    /**
     * Fetch ratings from background script
     */
    async fetch(videoId, title, year, key, checkFreshness = false) {
        // Deduplicate
        if (this.pendingRequests.has(key)) {
            return this.pendingRequests.get(key);
        }

        const promise = new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'FETCH_RATINGS',
                videoId,
                title,
                year,
                checkFreshness
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
     * Fetch with enrichment (Legacy support mostly)
     */
    async fetchWithEnrichment(videoId, title, year, existing, key) {
        // ... similar logic, mostly relevant if we are enriching a title-based partial record
        // For ID-based records, we likely won't have "partial" in the same way, or the background handles it.
        // Keeping it for compatibility if we ever fall back to title-based.

        if (this.pendingRequests.has(key)) {
            return this.pendingRequests.get(key);
        }

        const promise = new Promise((resolve) => {
            chrome.runtime.sendMessage({
                type: 'FETCH_RATINGS',
                videoId, // pass it if we have it
                title,
                year,
                enrichExisting: true
            }, (response) => {
                this.pendingRequests.delete(key);
                if (chrome.runtime.lastError || !response?.success) {
                    resolve(existing);
                    return;
                }
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
     */
    set(key, data) {
        this.cache.set(key, data);

        // Store by videoId if available in data
        if (data.netflixId) {
            const idKey = `netrot_${data.netflixId}`;
            if (idKey !== key) this.cache.set(idKey, data);
        }

        // Store by IMDb ID
        if (data.imdbId) {
            this.cache.set(data.imdbId, data);
        }

        // Normalized title
        if (data.normalizedTitle) {
            this.cache.set(data.normalizedTitle, data);
        }

        this.notify(key, data);
    }

    /**
     * Generate cache key
     * Priority: VideoID -> Title+Year -> Title
     */
    getKey(videoId, title, year = null) {
        if (videoId) {
            return `netrot_${videoId}`;
        }
        const normalized = this.normalizeTitle(title);
        return year ? `${normalized}_${year.substring(0, 4)}` : normalized;
    }

    /**
     * Notify subscribers
     */
    notify(key, data) {
        const keysToNotify = new Set([key]);

        if (data.netflixId) keysToNotify.add(`netrot_${data.netflixId}`);
        if (data.imdbId) keysToNotify.add(data.imdbId);
        if (data.normalizedTitle) keysToNotify.add(data.normalizedTitle);

        keysToNotify.forEach(k => {
            this.subscribers.get(k)?.forEach(cb => {
                try { cb(data); } catch (e) { console.error(e); }
            });
        });
    }

    // ... (rest of methods: mergeData, getValidValue, normalizeTitle, has, clear, getStats)
    // mergeData might needs updates if we add netflixId to data structure, but it uses spread ...fresh, so it should catch it.

    mergeData(existing, fresh) {
        return {
            ...existing,
            ...fresh,
            netflixId: fresh.netflixId || existing.netflixId, // Ensure ID is preserved
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

    // ... rest of class logic ...
    getValidValue(newVal, existingVal) {
        if (newVal && newVal !== 'N/A') return newVal;
        if (existingVal && existingVal !== 'N/A') return existingVal;
        return null;
    }

    normalizeTitle(title) {
        return title.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    }

    has(videoId, title, year = null) {
        const key = this.getKey(videoId, title, year);
        return this.cache.has(key);
    }

    clear() {
        this.cache.clear();
        this.pendingRequests.clear();
    }

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
