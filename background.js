/**
 * Background Service Worker
 * Handles API calls to OMDB and caching.
 */

// Default API Key (Ideally this should be user configurable or hosted)
// For this demo, using a placeholder. User will need to provide one or we use a public one.
// IMPORTANT: OMDB requires an API key. I will use a placeholder here.
const DEFAULT_OMDB_API_KEY = "dummy_key"; // User must replace this or we implement a settings flow.

chrome.runtime.onInstalled.addListener(() => {
    console.log('NetRot extension installed');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'FETCH_Ratings') {
        handleFetchRatings(request.title, request.year, sendResponse);
        return true; // Will respond asynchronously
    }
});

/**
 * Fetch ratings from OMDB API
 * @param {string} title 
 * @param {string} year 
 * @param {Function} sendResponse 
 */
async function handleFetchRatings(title, year, sendResponse) {
    try {
        // Check Cache first
        const cacheKey = `rating_${title}_${year || 'NA'}`;
        const cachedData = await chrome.storage.local.get(cacheKey);

        if (cachedData[cacheKey]) {
            // Check for expiry (e.g., 7 days)
            const cacheEntry = cachedData[cacheKey];
            const now = Date.now();
            if (now - cacheEntry.timestamp < 7 * 24 * 60 * 60 * 1000) {
                sendResponse({ success: true, data: cacheEntry.data, source: 'cache' });
                return;
            }
        }

        // Determine API Key
        const settings = await chrome.storage.local.get('omdbApiKey');
        const apiKey = settings.omdbApiKey || DEFAULT_OMDB_API_KEY;

        if (apiKey === 'dummy_key') {
            // We can't fetch without a key. 
            // Real implementation would either fallback to another source or error out.
            // For development purpose, we'll return a mock error if no key is set, 
            // asking usage to set it in Popup.
            sendResponse({ success: false, error: 'API Key missing' });
            return;
        }

        let url = `https://www.omdbapi.com/?t=${encodeURIComponent(title)}&apikey=${apiKey}&tomatoes=true`;
        if (year) url += `&y=${year}`;

        const response = await fetch(url);
        const data = await response.json();

        if (data.Response === 'True') {
            const result = {
                imdbRating: data.imdbRating,
                imdbVotes: data.imdbVotes,
                Ratings: data.Ratings, // Contains RT score if available
                Year: data.Year,
                Title: data.Title
            };

            // Cache the result
            await chrome.storage.local.set({
                [cacheKey]: {
                    timestamp: Date.now(),
                    data: result
                }
            });

            sendResponse({ success: true, data: result, source: 'api' });
        } else {
            sendResponse({ success: false, error: data.Error });
        }

    } catch (error) {
        console.error('Fetch error:', error);
        sendResponse({ success: false, error: error.message });
    }
}
