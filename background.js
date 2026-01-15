/**
 * NetRot Background Service Worker
 * Handles API calls to OMDb with multi-layer caching.
 * Part of the Hybrid caching architecture (orchestration layer).
 */

// ============================================================================
// DEBUG LOGGING
// ============================================================================

let debugMode = false;

// Load debug mode setting
chrome.storage.local.get(['debugMode'], (result) => {
    debugMode = result.debugMode || false;
});

// Listen for changes to debug mode
chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.debugMode) {
        debugMode = changes.debugMode.newValue;
        log('Debug mode:', debugMode ? 'ON' : 'OFF');
    }
});

/**
 * Conditional logging - only logs when debugMode is enabled
 */
function log(...args) {
    if (debugMode) {
        console.log('[NetRot]', ...args);
    }
}

/**
 * Always log errors regardless of debug mode
 */
function logError(...args) {
    console.error('[NetRot]', ...args);
}

// Import cache manager (bundled inline for service worker compatibility)
// Note: In production, you might use importScripts or a bundler

// ============================================================================
// CACHE MANAGER (Inlined for Service Worker)
// ============================================================================

class CacheManager {
    constructor() {
        this.memoryCache = new Map();
        this.pendingRequests = new Map();
        this.STORAGE_PREFIX = 'rating_';

        this.TTL = {
            SUCCESS_FULL: 7 * 24 * 60 * 60 * 1000,
            SUCCESS_PARTIAL: 24 * 60 * 60 * 1000,
            NOT_FOUND: 24 * 60 * 60 * 1000,
            ERROR: 60 * 60 * 1000
        };
    }

    async get(title, year) {
        const keys = this.getSearchKeys(title, year);

        for (const key of keys) {
            if (this.memoryCache.has(key)) {
                const entry = this.memoryCache.get(key);
                if (this.isValid(entry)) {
                    log(`Memory cache hit for "${title}"`);
                    return { data: entry.data, source: 'memory' };
                } else {
                    this.memoryCache.delete(key);
                }
            }
        }

        const storageKeys = keys.map(k => this.STORAGE_PREFIX + k);
        try {
            const stored = await chrome.storage.local.get(storageKeys);

            for (const key of storageKeys) {
                if (stored[key] && this.isValid(stored[key])) {
                    log(`Storage cache hit for "${title}"`);
                    const cacheKey = key.replace(this.STORAGE_PREFIX, '');
                    this.memoryCache.set(cacheKey, stored[key]);
                    return { data: stored[key].data, source: 'storage' };
                }
            }
        } catch (e) {
            logError('Storage read error:', e);
        }

        return null;
    }

    async set(title, year, data) {
        const key = this.getPrimaryKey(title, year);
        const ttl = this.getTTL(data);

        const entry = {
            data,
            timestamp: Date.now(),
            ttl,
            completeness: year ? 'full' : 'partial'
        };

        this.memoryCache.set(key, entry);

        try {
            const storageUpdates = {
                [this.STORAGE_PREFIX + key]: entry
            };

            if (data.imdbId) {
                this.memoryCache.set(data.imdbId, entry);
                storageUpdates[this.STORAGE_PREFIX + data.imdbId] = entry;
            }

            if (data.normalizedTitle && data.normalizedTitle !== key) {
                this.memoryCache.set(data.normalizedTitle, entry);
                storageUpdates[this.STORAGE_PREFIX + data.normalizedTitle] = entry;
            }

            await chrome.storage.local.set(storageUpdates);
        } catch (e) {
            logError('Storage write error:', e);
        }
    }

    hasPendingRequest(key) {
        return this.pendingRequests.has(key);
    }

    getPendingRequest(key) {
        return this.pendingRequests.get(key) || null;
    }

    setPendingRequest(key, promise) {
        this.pendingRequests.set(key, promise);
    }

    deletePendingRequest(key) {
        this.pendingRequests.delete(key);
    }

    getSearchKeys(title, year) {
        const normalized = this.normalizeTitle(title);
        const keys = [normalized];
        if (year) {
            keys.unshift(`${normalized}_${year.substring(0, 4)}`);
        }
        return keys;
    }

    getPrimaryKey(title, year) {
        const normalized = this.normalizeTitle(title);
        return year ? `${normalized}_${year.substring(0, 4)}` : normalized;
    }

    normalizeTitle(title) {
        return title.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    }

    getTTL(data) {
        if (data.status === 'error') return this.TTL.ERROR;
        if (data.status === 'not_found') return this.TTL.NOT_FOUND;
        if (data.completeness === 'full') return this.TTL.SUCCESS_FULL;
        return this.TTL.SUCCESS_PARTIAL;
    }

    isValid(entry) {
        if (!entry || !entry.timestamp) return false;
        const ttl = entry.ttl || this.TTL.SUCCESS_FULL;
        return (Date.now() - entry.timestamp) < ttl;
    }

    async getStats() {
        let storageCount = 0;
        try {
            const allItems = await chrome.storage.local.get(null);
            storageCount = Object.keys(allItems)
                .filter(key => key.startsWith(this.STORAGE_PREFIX)).length;
        } catch (e) { }

        return {
            memorySize: this.memoryCache.size,
            storageSize: storageCount,
            pendingRequests: this.pendingRequests.size
        };
    }
}

class RateLimiter {
    constructor(maxRequests = 10, windowMs = 1000) {
        this.tokens = maxRequests;
        this.maxTokens = maxRequests;
        this.windowMs = windowMs;
        this.lastRefill = Date.now();
    }

    async acquire() {
        this.refillTokens();

        if (this.tokens > 0) {
            this.tokens--;
            return true;
        }

        const waitTime = this.windowMs - (Date.now() - this.lastRefill);
        await new Promise(resolve => setTimeout(resolve, Math.max(waitTime, 100)));
        return this.acquire();
    }

    refillTokens() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;

        if (elapsed >= this.windowMs) {
            this.tokens = this.maxTokens;
            this.lastRefill = now;
        }
    }
}

// ============================================================================
// SINGLETON INSTANCES
// ============================================================================

const cacheManager = new CacheManager();
const rateLimiter = new RateLimiter(10, 1000);

// ============================================================================
// EXTENSION LIFECYCLE
// ============================================================================

chrome.runtime.onInstalled.addListener(() => {
    console.log('[NetRot] Extension installed/updated.');  // Always log on install
});

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Handle both old message type (FETCH_Ratings) and new (FETCH_RATINGS)
    if (request.type === 'FETCH_RATINGS' || request.type === 'FETCH_Ratings') {
        handleFetchRatings(request, sendResponse);
        return true; // Keep channel open for async response
    }

    if (request.type === 'GET_CACHE_STATS') {
        handleGetCacheStats(sendResponse);
        return true;
    }

    if (request.type === 'CLEAR_CACHE') {
        handleClearCache(sendResponse);
        return true;
    }
});

// ============================================================================
// REQUEST HANDLERS
// ============================================================================

/**
 * Handle ratings fetch request with cache-first strategy and incremental enrichment
 */
async function handleFetchRatings(request, sendResponse) {
    const { title, year, enrichExisting } = request;

    try {
        const normalizedTitle = normalizeTitle(title);
        const requestKey = cacheManager.getPrimaryKey(title, year);

        // Check for pending request (deduplication)
        if (cacheManager.hasPendingRequest(requestKey)) {
            log(`Deduplicating request for "${title}"`);
            const result = await cacheManager.getPendingRequest(requestKey);
            sendResponse(result);
            return;
        }

        // Check cache first
        const cached = await cacheManager.get(title, year);

        if (cached) {
            const cachedData = cached.data;

            // Check if we should enrich partial data
            // Enrich if: we have a year now, but cached data was fetched without year
            const shouldEnrich = year &&
                cachedData.completeness === 'partial' &&
                cachedData.status === 'success';

            if (!shouldEnrich && !enrichExisting) {
                sendResponse({
                    success: cachedData.status !== 'error' && cachedData.status !== 'not_found',
                    data: cachedData,
                    source: cached.source
                });
                return;
            }

            // Proceed to enrich if needed
            if (shouldEnrich) {
                log(`Enriching partial data for "${title}" with year ${year}`);
            }
        }

        // Get API key
        const storage = await chrome.storage.local.get(['omdbApiKey']);
        const apiKey = storage.omdbApiKey;

        if (!apiKey) {
            // If no API key but we have cached data, return it anyway
            if (cached && cached.data && cached.data.status === 'success') {
                sendResponse({
                    success: true,
                    data: cached.data,
                    source: cached.source
                });
                return;
            }
            sendResponse({ success: false, error: 'NO_API_KEY' });
            return;
        }

        // Create promise for request deduplication
        const fetchPromise = (async () => {
            try {
                // Rate limit
                await rateLimiter.acquire();

                // Fetch from API
                const apiData = await fetchFromOmdb(title, year, apiKey);

                if (apiData && apiData.Response === 'True') {
                    let normalizedData = normalizeOmdbResponse(apiData, normalizedTitle, year);

                    // If we have existing cached data, merge to preserve any data we might not get new
                    if (cached && cached.data && cached.data.status === 'success') {
                        normalizedData = mergeRatingsData(cached.data, normalizedData);
                    }

                    // Store in cache
                    await cacheManager.set(title, year, normalizedData);

                    return {
                        success: true,
                        data: normalizedData,
                        source: 'api'
                    };
                } else {
                    // If we have cached data, return that instead of error
                    if (cached && cached.data && cached.data.status === 'success') {
                        return {
                            success: true,
                            data: cached.data,
                            source: cached.source
                        };
                    }

                    // Cache the failure with shorter TTL
                    const errorData = {
                        status: 'not_found',
                        error: apiData?.Error || 'Movie not found',
                        normalizedTitle,
                        fetchedAt: Date.now()
                    };
                    await cacheManager.set(title, year, errorData);

                    return {
                        success: false,
                        error: apiData?.Error || 'Movie not found'
                    };
                }
            } catch (error) {
                logError('API fetch error:', error);

                // If we have cached data, return that on error
                if (cached && cached.data && cached.data.status === 'success') {
                    return {
                        success: true,
                        data: cached.data,
                        source: cached.source
                    };
                }

                return {
                    success: false,
                    error: error.message
                };
            } finally {
                cacheManager.deletePendingRequest(requestKey);
            }
        })();

        // Register pending request
        cacheManager.setPendingRequest(requestKey, fetchPromise);

        // Wait for result
        const result = await fetchPromise;
        sendResponse(result);

    } catch (error) {
        logError('Background error:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Merge existing cached data with fresh API data
 * Prefers fresh data but preserves existing values if fresh is null/N/A
 */
function mergeRatingsData(existing, fresh) {
    const getValidValue = (newVal, oldVal) => {
        if (newVal && newVal !== 'N/A') return newVal;
        if (oldVal && oldVal !== 'N/A') return oldVal;
        return null;
    };

    return {
        // Identity - prefer fresh
        imdbId: fresh.imdbId || existing.imdbId,
        title: fresh.title || existing.title,
        normalizedTitle: fresh.normalizedTitle || existing.normalizedTitle,
        year: fresh.year || existing.year,

        // Ratings - merge with preference for fresh valid values
        ratings: {
            imdb: {
                score: getValidValue(fresh.ratings?.imdb?.score, existing.ratings?.imdb?.score),
                votes: getValidValue(fresh.ratings?.imdb?.votes, existing.ratings?.imdb?.votes)
            },
            rottenTomatoes: {
                score: getValidValue(fresh.ratings?.rottenTomatoes?.score, existing.ratings?.rottenTomatoes?.score)
            },
            metacritic: {
                score: getValidValue(fresh.ratings?.metacritic?.score, existing.ratings?.metacritic?.score)
            }
        },

        // Legacy fields
        imdbRating: getValidValue(fresh.imdbRating, existing.imdbRating),
        imdbVotes: getValidValue(fresh.imdbVotes, existing.imdbVotes),
        metascore: getValidValue(fresh.metascore, existing.metascore),
        Ratings: fresh.Ratings?.length > 0 ? fresh.Ratings : existing.Ratings,

        // Metadata - update to show enrichment
        status: 'success',
        completeness: fresh.completeness === 'full' || existing.completeness === 'full' ? 'full' : 'partial',
        fetchedAt: Date.now(),
        enrichedAt: existing.fetchedAt ? Date.now() : undefined
    };
}

/**
 * Handle cache stats request
 */
async function handleGetCacheStats(sendResponse) {
    try {
        const stats = await cacheManager.getStats();
        sendResponse({ success: true, stats });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Handle cache clear request
 */
async function handleClearCache(sendResponse) {
    try {
        const allItems = await chrome.storage.local.get(null);
        const keysToRemove = Object.keys(allItems)
            .filter(key => key.startsWith('rating_'));
        await chrome.storage.local.remove(keysToRemove);

        // Clear memory cache too
        cacheManager.memoryCache.clear();
        cacheManager.pendingRequests.clear();

        sendResponse({ success: true, clearedCount: keysToRemove.length });
    } catch (error) {
        sendResponse({ success: false, error: error.message });
    }
}

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Fetch data from OMDb API
 */
async function fetchFromOmdb(title, year, apiKey) {
    let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}&tomatoes=true`;

    if (year) {
        const y = year.substring(0, 4);
        url += `&y=${y}`;
    }

    try {
        log(`Fetching from OMDb: "${title}" (${year || 'no year'})`);
        const res = await fetch(url);

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        return await res.json();
    } catch (e) {
        logError('OMDb fetch failed:', e);
        throw e;
    }
}

/**
 * Normalize OMDb response to unified data model
 */
function normalizeOmdbResponse(data, normalizedTitle, year) {
    // Extract ratings from the Ratings array
    const rtRating = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
    const mcRating = data.Ratings?.find(r => r.Source === 'Metacritic');

    return {
        // Identity
        imdbId: data.imdbID,
        title: data.Title,
        normalizedTitle: normalizedTitle,
        year: data.Year,

        // Ratings (normalized structure)
        ratings: {
            imdb: {
                score: data.imdbRating !== 'N/A' ? data.imdbRating : null,
                votes: data.imdbVotes !== 'N/A' ? data.imdbVotes : null
            },
            rottenTomatoes: {
                score: rtRating?.Value || null
            },
            metacritic: {
                score: data.Metascore !== 'N/A' ? data.Metascore : null
            }
        },

        // Legacy fields for backward compatibility
        imdbRating: data.imdbRating,
        imdbVotes: data.imdbVotes,
        metascore: data.Metascore !== 'N/A' ? data.Metascore : null,
        Ratings: data.Ratings || [],

        // Metadata
        status: 'success',
        completeness: year ? 'full' : 'partial',
        fetchedAt: Date.now()
    };
}

/**
 * Normalize title for cache key generation
 */
function normalizeTitle(title) {
    return title.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}
