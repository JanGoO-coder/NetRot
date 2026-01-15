document.addEventListener('DOMContentLoaded', () => {
    restoreOptions();
    loadCacheStats();
});

document.getElementById('saveBtn').addEventListener('click', saveOptions);
document.getElementById('clearCache').addEventListener('click', clearCache);

function saveOptions() {
    const apiKey = document.getElementById('apiKey').value;
    const showImdb = document.getElementById('showImdb').checked;
    const showRotten = document.getElementById('showRotten').checked;
    const showMetacritic = document.getElementById('showMetacritic').checked;
    const debugMode = document.getElementById('debugMode').checked;

    chrome.storage.local.set({
        omdbApiKey: apiKey,
        showImdb: showImdb,
        showRotten: showRotten,
        showMetacritic: showMetacritic,
        debugMode: debugMode
    }, () => {
        showStatus('Options saved.');
    });
}

function restoreOptions() {
    chrome.storage.local.get({
        omdbApiKey: '',
        showImdb: true,
        showRotten: true,
        showMetacritic: true,
        debugMode: false
    }, (items) => {
        document.getElementById('apiKey').value = items.omdbApiKey;
        document.getElementById('showImdb').checked = items.showImdb;
        document.getElementById('showRotten').checked = items.showRotten;
        document.getElementById('showMetacritic').checked = items.showMetacritic;
        document.getElementById('debugMode').checked = items.debugMode;
    });
}

function loadCacheStats() {
    chrome.runtime.sendMessage({ type: 'GET_CACHE_STATS' }, (response) => {
        if (chrome.runtime.lastError) {
            console.error('Error getting cache stats:', chrome.runtime.lastError);
            return;
        }

        if (response && response.success && response.stats) {
            document.getElementById('memoryCount').textContent = response.stats.memorySize || 0;
            document.getElementById('storageCount').textContent = response.stats.storageSize || 0;
            document.getElementById('pendingCount').textContent = response.stats.pendingRequests || 0;
        }
    });
}

function clearCache() {
    chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }, (response) => {
        if (chrome.runtime.lastError) {
            showStatus('Error clearing cache.');
            return;
        }

        if (response && response.success) {
            showStatus(`Cleared ${response.clearedCount} cached items.`);
            loadCacheStats(); // Refresh stats
        } else {
            showStatus('Failed to clear cache.');
        }
    });
}

function showStatus(message) {
    const status = document.getElementById('status');
    status.textContent = message;
    setTimeout(() => {
        status.textContent = '';
    }, 3000);
}
