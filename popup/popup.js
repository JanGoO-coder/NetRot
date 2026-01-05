document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('saveBtn').addEventListener('click', saveOptions);
document.getElementById('clearCache').addEventListener('click', clearCache);

function saveOptions() {
    const apiKey = document.getElementById('apiKey').value;
    const showImdb = document.getElementById('showImdb').checked;
    const showRotten = document.getElementById('showRotten').checked;

    chrome.storage.local.set({
        omdbApiKey: apiKey,
        showImdb: showImdb,
        showRotten: showRotten
    }, () => {
        const status = document.getElementById('status');
        status.textContent = 'Options saved.';
        setTimeout(() => {
            status.textContent = '';
        }, 2000);
    });
}

function restoreOptions() {
    chrome.storage.local.get({
        omdbApiKey: '',
        showImdb: true,
        showRotten: true
    }, (items) => {
        document.getElementById('apiKey').value = items.omdbApiKey;
        document.getElementById('showImdb').checked = items.showImdb;
        document.getElementById('showRotten').checked = items.showRotten;
    });
}

function clearCache() {
    chrome.storage.local.get(null, (items) => {
        const keysToRemove = Object.keys(items).filter(key => key.startsWith('rating_'));
        chrome.storage.local.remove(keysToRemove, () => {
            const status = document.getElementById('status');
            status.textContent = 'Cache cleared.';
            setTimeout(() => { status.textContent = ''; }, 2000);
        });
    });
}
