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

    async get(videoId, title, year) {
        // 1. Try to find a valid key to lookup
        const keys = this.getSearchKeys(videoId, title, year);

        // Helper to check and resolve pointer
        const resolve = async (key, source) => {
            let value = source === 'memory' ? this.memoryCache.get(key) : (await chrome.storage.local.get(this.STORAGE_PREFIX + key))[this.STORAGE_PREFIX + key];

            if (!value) return null;

            // Check if it is a pointer (string)
            if (typeof value === 'string' && value.startsWith('netrot_')) {
                log(`Resolved pointer "${key}" -> "${value}"`);
                // Follow pointer (recurse once)
                const targetKey = value;
                // Check memory first for target
                if (this.memoryCache.has(targetKey)) {
                    const target = this.memoryCache.get(targetKey);
                    if (this.isValid(target)) return { data: target.data, source: 'memory_linked' };
                }
                // Check storage
                const storedTarget = await chrome.storage.local.get(this.STORAGE_PREFIX + targetKey);
                const targetEntry = storedTarget[this.STORAGE_PREFIX + targetKey];

                if (targetEntry && this.isValid(targetEntry)) {
                    // Cache the target in memory for speed
                    this.memoryCache.set(targetKey, targetEntry);
                    return { data: targetEntry.data, source: 'storage_linked' };
                }
                return null; // Pointer dead end
            }

            // Not a pointer, normal entry
            if (this.isValid(value)) {
                return { data: value.data, source };
            }

            return null;
        }

        // 2. Check Memory
        for (const key of keys) {
            if (this.memoryCache.has(key)) {
                const result = await resolve(key, 'memory');
                if (result) {
                    log(`Memory hit for "${key}"`);
                    return result;
                } else {
                    this.memoryCache.delete(key);
                }
            }
        }

        // 3. Check Storage
        const storageKeys = keys.map(k => this.STORAGE_PREFIX + k);
        try {
            const stored = await chrome.storage.local.get(storageKeys);

            for (const key of keys) {
                const storageKey = this.STORAGE_PREFIX + key;
                if (stored[storageKey]) {
                    let val = stored[storageKey];

                    // Pointer check
                    if (typeof val === 'string' && val.startsWith('netrot_')) {
                        log(`Storage found pointer "${key}" -> "${val}"`);
                        const targetKey = this.STORAGE_PREFIX + val;
                        const targetRes = await chrome.storage.local.get(targetKey);
                        const targetVal = targetRes[targetKey];

                        if (targetVal && this.isValid(targetVal)) {
                            this.memoryCache.set(val, targetVal); // Cache absolute target
                            this.memoryCache.set(key, val); // Cache pointer
                            return { data: targetVal.data, source: 'storage' };
                        }
                    } else if (this.isValid(val)) {
                        log(`Storage hit for "${key}"`);
                        this.memoryCache.set(key, val);
                        return { data: val.data, source: 'storage' };
                    }
                }
            }
        } catch (e) {
            logError('Storage read error:', e);
        }

        return null;
    }

    async set(videoId, title, year, data) {
        if (videoId && !data.netflixId) {
            data.netflixId = videoId;
        }

        // Define the Master Key
        // If we have a videoId, that IS the master key.
        // If not, we fall back to Title_Year as master (legacy mode).
        let masterKey = null;
        if (videoId) {
            masterKey = `netrot_${videoId}`;
        } else {
            masterKey = this.getPrimaryKey(null, title, year);
        }

        const ttl = this.getTTL(data);
        const entry = {
            data,
            timestamp: Date.now(),
            ttl,
            completeness: year ? 'full' : 'partial'
        };

        const storageUpdates = {};

        // 1. Store Master Record
        this.memoryCache.set(masterKey, entry);
        storageUpdates[this.STORAGE_PREFIX + masterKey] = entry;

        // 2. Create Pointers for Secondary Keys
        // Only if we are using ID-based master key.
        const secondaryKeys = [];

        // Title Keys
        if (title) {
            const normalized = this.normalizeTitle(title);
            secondaryKeys.push(normalized);
            if (year) {
                secondaryKeys.push(`${normalized}_${year.substring(0, 4)}`);
            }
        }

        // IMDb Key
        if (data.imdbId) {
            secondaryKeys.push(data.imdbId);
        }

        // Process Secondary Keys
        for (const secKey of secondaryKeys) {
            if (secKey === masterKey) continue; // Don't point to self

            if (videoId) {
                // If we have a master ID, make these POINTERS
                this.memoryCache.set(secKey, masterKey);
                storageUpdates[this.STORAGE_PREFIX + secKey] = masterKey;
            } else {
                // Legacy mode: No ID, so we must copy (duplication)
                this.memoryCache.set(secKey, entry);
                storageUpdates[this.STORAGE_PREFIX + secKey] = entry;
            }
        }

        try {
            await chrome.storage.local.set(storageUpdates);
            log(`Saved for ${masterKey} (+${Object.keys(storageUpdates).length - 1} pointers)`);
        } catch (e) {
            logError('Storage write error:', e);
        }
    }

    // ... pending request methods ...
    hasPendingRequest(key) { return this.pendingRequests.has(key); }
    getPendingRequest(key) { return this.pendingRequests.get(key) || null; }
    setPendingRequest(key, promise) { this.pendingRequests.set(key, promise); }
    deletePendingRequest(key) { this.pendingRequests.delete(key); }


    getSearchKeys(videoId, title, year) {
        const keys = [];

        if (videoId) {
            keys.push(`netrot_${videoId}`);
        }

        if (title) {
            const normalized = this.normalizeTitle(title);
            keys.push(normalized);
            if (year) {
                keys.unshift(`${normalized}_${year.substring(0, 4)}`);
            }
        }

        return keys;
    }

    getPrimaryKey(videoId, title, year) {
        if (videoId) return `netrot_${videoId}`;
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
        if (!entry) return false;
        // If entry is a pointer string, it's valid structurally
        if (typeof entry === 'string') return true;

        if (!entry.timestamp) return false;
        const ttl = entry.ttl || this.TTL.SUCCESS_FULL;
        return (Date.now() - entry.timestamp) < ttl;
    }

    async getStats() {
        // ... (existing implementation)
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
    console.log('[NetRot] Extension installed/updated.');
});

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'FETCH_RATINGS' || request.type === 'FETCH_Ratings') {
        handleFetchRatings(request, sendResponse);
        return true;
    }
    // ... cache stats ...
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
 * Handle ratings fetch request with cache-first strategy
 */
/**
 * Handle ratings fetch request with cache-first strategy
 */
async function handleFetchRatings(request, sendResponse) {
    const { videoId, title, year, enrichExisting, checkFreshness } = request;

    try {
        const normalizedTitle = title ? cacheManager.normalizeTitle(title) : null;
        const requestKey = cacheManager.getPrimaryKey(videoId, title, year);

        // Check for pending request (deduplication)
        if (cacheManager.hasPendingRequest(requestKey)) {
            log(`Deduplicating request for "${title || videoId}"`);
            const result = await cacheManager.getPendingRequest(requestKey);
            sendResponse(result);
            return;
        }

        // Check cache first
        const cached = await cacheManager.get(videoId, title, year);

        if (cached) {
            const cachedData = cached.data;

            // Check if we should enrich partial data (only applies if we have year now but didn't before)
            // Or if we now have videoId but data doesn't?
            const shouldEnrich = year &&
                cachedData.completeness === 'partial' &&
                cachedData.status === 'success';

            // Freshness Check implementation:
            // If checkFreshness is true, we want to trigger a re-fetch even if we have data.
            // But we return the Cached data IMMEDIATELY to the UI so it doesn't wait (Stale-While-Revalidate).
            // However, since we are inside a message handler, we can't easily return twice.
            // So the strategy is:
            // 1. If we have data, return it immediately (sendResponse).
            // 2. Spawn a background fetch WITHOUT awaiting it for the response.
            // 3. When background fetch completes, it updates storage. 
            // 4. Storage change listener (in ratings-store) will pick up the change and update UI.

            if (!shouldEnrich && !enrichExisting) {
                // Migrate: Ensure we link this videoId to the data if it was found via Title mapping
                if (videoId && !cachedData.netflixId) {
                    log(`Linking existing data for "${title}" to ID ${videoId}`);
                    cachedData.netflixId = videoId;
                    await cacheManager.set(videoId, title, year, cachedData);
                }

                // Return valid cached data immediately
                sendResponse({
                    success: cachedData.status !== 'error' && cachedData.status !== 'not_found',
                    data: cachedData,
                    source: cached.source
                });

                // Trigger background refresh if requested
                if (checkFreshness) {
                    log(`[Freshness] Triggering background refresh for "${title}"...`);
                    // We don't await this, we just let it run
                    performFetch(videoId, title, year, normalizedTitle, cached, requestKey).catch(e => logError('Background refresh error', e));
                }

                return;
            }
            // Proceed to enrich...
        }

        // ... Get API Key ...
        const storage = await chrome.storage.local.get(['omdbApiKey']);
        const apiKey = storage.omdbApiKey;

        if (!apiKey) {
            if (cached && cached.data && cached.data.status === 'success') {
                sendResponse({ success: true, data: cached.data, source: cached.source });
                return;
            }
            sendResponse({ success: false, error: 'NO_API_KEY' });
            return;
        }

        // ... Fetch Promise ...
        const fetchPromise = performFetch(videoId, title, year, normalizedTitle, cached, requestKey, apiKey);

        cacheManager.setPendingRequest(requestKey, fetchPromise);
        sendResponse(await fetchPromise);

    } catch (error) {
        logError('Background error:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Core fetch logic extracted for reuse
 */
async function performFetch(videoId, title, year, normalizedTitle, cached, requestKey, apiKey = null) {
    try {
        if (!apiKey) {
            const storage = await chrome.storage.local.get(['omdbApiKey']);
            apiKey = storage.omdbApiKey;
            if (!apiKey) throw new Error("NO_API_KEY");
        }

        // Rate limit
        await rateLimiter.acquire();

        // Fetch from API (OMDb needs title, cannot search by netflix ID)
        if (!title) {
            throw new Error("Cannot fetch without title");
        }

        const apiData = await fetchFromOmdb(title, year, apiKey);

        if (apiData && apiData.Response === 'True') {
            let normalizedData = normalizeOmdbResponse(apiData, normalizedTitle, year);

            // Add netflixId
            if (videoId) normalizedData.netflixId = videoId;

            // Merge if needed
            if (cached && cached.data && cached.data.status === 'success') {
                normalizedData = mergeRatingsData(cached.data, normalizedData);
            }

            await cacheManager.set(videoId, title, year, normalizedData);

            return { success: true, data: normalizedData, source: 'api' };
        } else {
            // If API fails but we had cached data that was "stale", keep using it?
            // Usually OMDb failure means not found or error.

            if (cached && cached.data && cached.data.status === 'success') {
                // If this was a refresh, we just failed to update, no big deal.
                return { success: true, data: cached.data, source: cached.source };
            }

            const errorData = {
                status: 'not_found',
                error: apiData?.Error || 'Movie not found',
                normalizedTitle,
                netflixId: videoId,
                fetchedAt: Date.now()
            };
            await cacheManager.set(videoId, title, year, errorData);

            return { success: false, error: apiData?.Error || 'Movie not found' };
        }
    } catch (error) {
        logError('API fetch error:', error);
        if (cached && cached.data && cached.data.status === 'success') {
            return { success: true, data: cached.data, source: cached.source };
        }
        return { success: false, error: error.message };
    } finally {
        cacheManager.deletePendingRequest(requestKey);
    }
}

/**
 * Merge existing cached data with fresh API data
 */
function mergeRatingsData(existing, fresh) {
    const getValidValue = (newVal, oldVal) => {
        if (newVal && newVal !== 'N/A') return newVal;
        if (oldVal && oldVal !== 'N/A') return oldVal;
        return null;
    };

    return {
        // Identity
        imdbId: fresh.imdbId || existing.imdbId,
        netflixId: fresh.netflixId || existing.netflixId,
        title: fresh.title || existing.title,
        normalizedTitle: fresh.normalizedTitle || existing.normalizedTitle,
        year: fresh.year || existing.year,

        // Ratings
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

        // Metadata
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
 * Fetch data from OMDb API with fallback search
 */
async function fetchFromOmdb(title, year, apiKey) {
    // Step 1: Try exact match first
    let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}&tomatoes=true`;

    if (year) {
        const y = year.substring(0, 4);
        url += `&y=${y}`;
    }

    try {
        log(`[API] Fetching exact match: ${url.replace(apiKey, 'HIDDEN_KEY')}`);
        const res = await fetch(url);

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const json = await res.json();
        log(`[API] Response:`, json);

        // If exact match found, return it
        if (json.Response === 'True') {
            return json;
        }

        // Step 2: Exact match failed - try fuzzy search
        log(`[API] Exact match failed for "${title}", trying search fallback...`);
        return await searchOmdbFallback(title, year, apiKey);

    } catch (e) {
        logError('OMDb fetch failed:', e);
        throw e;
    }
}

/**
 * Fallback search when exact match fails
 * Uses OMDb search API to find candidates, then fetches best match
 */
async function searchOmdbFallback(title, year, apiKey) {
    try {
        // Clean title for search - remove some common suffixes
        const searchTitle = title
            .replace(/\s*\(.*?\)\s*/g, '')  // Remove parentheticals
            .replace(/\s*-\s*Season\s*\d+/i, '')  // Remove Season suffixes
            .replace(/\s*:\s*Season\s*\d+/i, '')
            .trim();

        let searchUrl = `https://www.omdbapi.com/?s=${encodeURIComponent(searchTitle)}&apikey=${apiKey}`;
        if (year) {
            searchUrl += `&y=${year.substring(0, 4)}`;
        }

        log(`[API] Search fallback: ${searchUrl.replace(apiKey, 'HIDDEN_KEY')}`);
        const searchRes = await fetch(searchUrl);
        const searchJson = await searchRes.json();

        if (searchJson.Response !== 'True' || !searchJson.Search?.length) {
            log(`[API] Search returned no results`);
            return { Response: 'False', Error: 'Movie not found' };
        }

        // Find best match from search results
        const bestMatch = findBestMatch(title, searchJson.Search);

        if (!bestMatch) {
            return { Response: 'False', Error: 'No suitable match found' };
        }

        log(`[API] Best match found: "${bestMatch.Title}" (${bestMatch.imdbID})`);

        // Step 3: Fetch full details for best match using IMDb ID
        const detailUrl = `https://www.omdbapi.com/?i=${bestMatch.imdbID}&apikey=${apiKey}&tomatoes=true`;
        log(`[API] Fetching details: ${detailUrl.replace(apiKey, 'HIDDEN_KEY')}`);

        const detailRes = await fetch(detailUrl);
        return await detailRes.json();

    } catch (e) {
        logError('Search fallback error:', e);
        return { Response: 'False', Error: e.message };
    }
}

/**
 * Find best match from search results using simple similarity scoring
 */
function findBestMatch(originalTitle, searchResults) {
    const normalizedOriginal = originalTitle.toLowerCase().trim();

    let bestMatch = null;
    let bestScore = 0;

    for (const result of searchResults) {
        const resultTitle = result.Title.toLowerCase().trim();

        // Calculate similarity score
        let score = 0;

        // Exact match (case-insensitive)
        if (resultTitle === normalizedOriginal) {
            score = 100;
        }
        // Starts with original title
        else if (resultTitle.startsWith(normalizedOriginal)) {
            score = 80;
        }
        // Original starts with result (result is shorter)
        else if (normalizedOriginal.startsWith(resultTitle)) {
            score = 70;
        }
        // Contains original title
        else if (resultTitle.includes(normalizedOriginal)) {
            score = 60;
        }
        // Original contains result title
        else if (normalizedOriginal.includes(resultTitle)) {
            score = 50;
        }
        // Partial word match
        else {
            const originalWords = normalizedOriginal.split(/\s+/);
            const resultWords = resultTitle.split(/\s+/);
            const matchingWords = originalWords.filter(w => resultWords.includes(w));
            score = (matchingWords.length / originalWords.length) * 40;
        }

        // Prefer movies over series if scores are close
        if (result.Type === 'movie' && score > 0) {
            score += 5;
        }

        if (score > bestScore) {
            bestScore = score;
            bestMatch = result;
        }
    }

    // Only return if we have a reasonable match (score >= 40)
    return bestScore >= 40 ? bestMatch : null;
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
