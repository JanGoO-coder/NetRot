/**
 * Background Service Worker
 * Handles API calls to OMDb and caching strategies.
 */

// NOTE: Using a public demo key for 'The' searches often works, but users should provide their own.
// We will rely on user settings for the key.
const DEFAULT_API_KEY = '';

chrome.runtime.onInstalled.addListener(() => {
    console.log('[NetRot] Extension installed/updated.');
});

// Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'FETCH_Ratings') {
        fetchRatingsWithCache(request.title, request.year, sendResponse);
        return true; // Keep channel open for async response
    }
});

/**
 * Orchestrates Cache Check -> API Fetch -> Cache Save
 */
async function fetchRatingsWithCache(title, year, sendResponse) {
    try {
        const cleanTitle = normalizeTitle(title);
        const cacheKey = `rating_${cleanTitle}_${year || 'NA'}`;

        // 1. Check Local Storage
        const storage = await chrome.storage.local.get([cacheKey, 'omdbApiKey']);
        const cachedEntry = storage[cacheKey];
        const apiKey = storage.omdbApiKey || DEFAULT_API_KEY;

        // Check if cache is valid (7 days)
        if (cachedEntry && isCacheValid(cachedEntry.timestamp)) {
            console.log(`[NetRot] Cache hit for "${title}"`);
            sendResponse({ success: true, data: cachedEntry.data, source: 'cache' });
            return;
        }

        if (!apiKey) {
            sendResponse({ success: false, error: 'NO_API_KEY' });
            return;
        }

        // 2. Fetch from API
        // Simple rate limiting: minimal delay if needed, but OMDb is usually generous to individuals.
        // We will just fetch directly here.
        const data = await fetchFromOmdb(cleanTitle, year, apiKey);

        if (data && data.Response === 'True') {
            const unifiedData = normalizeOmdbResponse(data);

            // 3. Save to Cache
            await chrome.storage.local.set({
                [cacheKey]: {
                    timestamp: Date.now(),
                    data: unifiedData
                }
            });

            sendResponse({ success: true, data: unifiedData, source: 'api' });
        } else {
            // Cache the failure too? Maybe for a shorter time to avoid re-fetching bad titles often?
            // For now, let's just return error.
            sendResponse({ success: false, error: data?.Error || 'Unknown Error' });
        }

    } catch (error) {
        console.error('[NetRot] Background error:', error);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Call OMDb API
 */
async function fetchFromOmdb(title, year, apiKey) {
    let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}&tomatoes=true`;
    if (year) {
        // Netflix year ranges like "2015-2019", we just take the start year
        const y = year.substring(0, 4);
        url += `&y=${y}`;
    }

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.error('[NetRot] OMDb Fetch failed:', e);
        return null;
    }
}

/**
 * Normalize Data Model
 */
function normalizeOmdbResponse(data) {
    return {
        title: data.Title,
        year: data.Year,
        imdbRating: data.imdbRating,
        imdbVotes: data.imdbVotes,
        metascore: data.Metascore !== 'N/A' ? data.Metascore : null,
        Ratings: data.Ratings || [], // Keep original array for flexible UI logic
        fetchedAt: Date.now()
    };
}

/**
 * Helpers
 */
function normalizeTitle(title) {
    return title.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

function isCacheValid(timestamp) {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    return (Date.now() - timestamp) < SEVEN_DAYS;
}
