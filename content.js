/**
 * NetRot Content Script
 * Injects IMDb, Rotten Tomatoes, and Metacritic ratings into Netflix UI.
 */

(function () {
    'use strict';

    const NETROT_MARKER = 'netrot-injected';
    let observer = null;
    let userSettings = {
        showImdb: true,
        showRotten: true,
        showMetacritic: true
    };

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    function init() {
        console.log('[NetRot] Initializing content script...');

        // Initial settings sync
        syncSettings();

        // Watch for dynamic content loading (infinite scroll, modal opens)
        observer = new MutationObserver(debounce(scanAndInject, 500));
        observer.observe(document.body, { childList: true, subtree: true });

        scanAndInject();
    }

    // =========================================================================
    // MAIN SCANNER
    // =========================================================================
    function scanAndInject() {
        scanBrowseCards();
        scanDetailModals();
        scanHoverCards(); // "JawBone" mini-previews
    }

    function scanBrowseCards() {
        // Selectors for various thumbnail types
        const selectors = [
            '.slider-item',
            '.title-card-container',
            '.boxart-round'
        ];

        const cards = document.querySelectorAll(selectors.join(', '));
        cards.forEach(card => {
            if (card.hasAttribute(NETROT_MARKER)) return;

            const title = extractTitle(card);
            if (title) {
                card.setAttribute(NETROT_MARKER, 'true');
                // Pass null for year in browse view as it's hard to extract reliability without opening
                fetchRatings(title, null, (data) => injectCardBadge(card, data));
            }
        });
    }

    function scanDetailModals() {
        // The full screen or large overlay
        const modals = document.querySelectorAll('.previewModal--container, .detail-modal, [data-uia="preview-modal-container"]');

        modals.forEach(modal => {
            // Check if we already injected into the specific details container
            const container = modal.querySelector('.previewModal--detailsMetadata');
            if (container && container.hasAttribute(NETROT_MARKER)) return;

            const title = extractTitleFromModal(modal);
            const year = extractYearFromModal(modal);

            if (title) {
                if (container) container.setAttribute(NETROT_MARKER, 'true');
                fetchRatings(title, year, (data) => injectDetailRatings(modal, data));
            }
        });
    }

    function scanHoverCards() {
        // The expanding card when hovering a thumbnail (mini-modal)
        // Netflix uses various class names; try multiple selectors
        const selectors = [
            '.mini-modal',
            '.bob-card',
            '.previewModal--wrapper',
            '.jawBoneContainer',
            '.bob-container'
        ];

        const cards = document.querySelectorAll(selectors.join(', '));

        cards.forEach(card => {
            if (card.hasAttribute(NETROT_MARKER)) return;

            const title = extractTitleFromModal(card);
            if (title) {
                card.setAttribute(NETROT_MARKER, 'true');
                fetchRatings(title, null, (data) => injectHoverCardRatings(card, data));
            }
        });
    }

    // =========================================================================
    // DATA EXTRACTION
    // =========================================================================
    function extractTitle(element) {
        // 1. Aria Label (often best)
        const ariaEl = element.querySelector('[aria-label], a[aria-label]');
        if (ariaEl) return cleanTitle(ariaEl.getAttribute('aria-label'));

        // 2. Image Alt
        const img = element.querySelector('img');
        if (img && img.alt) return cleanTitle(img.alt);

        // 3. Text fallback
        const textEl = element.querySelector('.fallback-text, .title-title');
        if (textEl) return cleanTitle(textEl.textContent);

        return null;
    }

    function extractTitleFromModal(modal) {
        const logo = modal.querySelector('.previewModal--player-titleTreatment-logo, img.logo');
        if (logo && logo.alt) return cleanTitle(logo.alt);

        const header = modal.querySelector('.previewModal--section-header, h3');
        if (header) return cleanTitle(header.textContent);

        return extractTitle(modal);
    }

    function extractYearFromModal(modal) {
        // Look for the year span usually found in metadata
        // Structure often: <span class="year">2022</span>
        const yearEl = modal.querySelector('.year, .duration');
        if (yearEl && /^\d{4}$/.test(yearEl.textContent)) {
            return yearEl.textContent;
        }
        // Fallback: try to find any 4-digit number in metadata text
        const metaText = modal.innerText;
        const match = metaText.match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : null;
    }

    function cleanTitle(title) {
        if (!title) return null;
        return title
            .replace(/Netflix/i, '')
            .split(':')[0] // Removes subtitles like "Stranger Things: Season 4" -> "Stranger Things"
            .trim();
    }

    // =========================================================================
    // API INTERACTION
    // =========================================================================
    function fetchRatings(title, year, callback) {
        chrome.runtime.sendMessage({
            type: 'FETCH_Ratings',
            title: title,
            year: year
        }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response && response.success) {
                callback(response.data);
            }
        });
    }

    // =========================================================================
    // UI INJECTION
    // =========================================================================
    function injectCardBadge(card, data) {
        if (!shouldShow(data)) return;

        const badge = document.createElement('div');
        badge.className = 'netrot-card-badge';
        badge.innerHTML = buildBadgeHtml(data);

        // Ensure parent is relative for absolute positioning of badge
        if (getComputedStyle(card).position === 'static') {
            card.style.position = 'relative';
        }
        card.appendChild(badge);
    }

    function injectDetailRatings(modal, data) {
        if (!shouldShow(data)) return;

        // GUARD: Prevent duplicate injection
        if (modal.querySelector('.netrot-detail-ratings')) {
            console.log('[NetRot] Ratings already present, skipping injection.');
            return;
        }

        const container = document.createElement('div');
        container.className = 'netrot-detail-ratings';
        container.innerHTML = buildDetailCardsHtml(data);

        // Insert above the synopsis/text
        const synopsis = modal.querySelector('.previewModal--text, .synopsis, .previewModal--synopsis');
        if (synopsis && synopsis.parentNode) {
            synopsis.parentNode.insertBefore(container, synopsis);
        } else {
            // Fallback: insert after button row
            const buttonRow = modal.querySelector('.previewModal--metadatAndControls, .buttonControls');
            if (buttonRow) {
                buttonRow.parentNode.insertBefore(container, buttonRow.nextSibling);
            } else {
                modal.appendChild(container);
            }
        }
    }

    function injectHoverCardRatings(card, data) {
        if (!shouldShow(data)) return;

        // GUARD: Prevent duplicate injection
        if (card.querySelector('.netrot-hover-ratings')) return;

        const container = document.createElement('div');
        container.className = 'netrot-hover-ratings';
        container.innerHTML = buildHoverRatingsHtml(data);

        // Try to insert near the genre tags or metadata area
        const metaArea = card.querySelector('.previewModal--tags, .previewModal--metadatAndControls-container, .evidence-list');
        if (metaArea && metaArea.parentNode) {
            metaArea.parentNode.insertBefore(container, metaArea.nextSibling);
        } else {
            // Fallback: append at the end of info section
            const infoSection = card.querySelector('.previewModal--info, .bob-overview');
            if (infoSection) {
                infoSection.appendChild(container);
            }
        }
    }

    function shouldShow(data) {
        // Option A: Always show badges if at least one rating source is enabled
        // The actual N/A fallback is handled in the HTML builders
        return userSettings.showImdb || userSettings.showRotten || userSettings.showMetacritic;
    }

    // =========================================================================
    // HTML BUILDERS
    // =========================================================================
    function buildBadgeHtml(data) {
        let items = [];

        // IMDb - always show if enabled
        if (userSettings.showImdb) {
            const imdbScore = (data.imdbRating && data.imdbRating !== 'N/A') ? data.imdbRating : 'N/A';
            const naClass = imdbScore === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-badge-item netrot-imdb${naClass}"><span class="netrot-badge-icon">★</span><span class="netrot-badge-score">${imdbScore}</span><span class="netrot-badge-label">IMDb</span></span>`);
        }

        // Rotten Tomatoes - always show if enabled
        if (userSettings.showRotten) {
            const rt = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
            const rtScore = rt ? rt.Value : 'N/A';
            const naClass = rtScore === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-badge-item netrot-rt${naClass}"><span class="netrot-badge-icon">🍅</span><span class="netrot-badge-score">${rtScore}</span><span class="netrot-badge-label">RT</span></span>`);
        }

        // Metacritic - always show if enabled
        if (userSettings.showMetacritic) {
            const metaScore = (data.metascore && data.metascore !== 'N/A') ? data.metascore : 'N/A';
            const naClass = metaScore === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-badge-item netrot-meta${naClass}"><span class="netrot-badge-icon">M</span><span class="netrot-badge-score">${metaScore}</span><span class="netrot-badge-label">Meta</span></span>`);
        }

        return items.join('');
    }

    function buildHoverRatingsHtml(data) {
        // Compact horizontal strip for hover cards - always show all three
        let items = [];

        if (userSettings.showImdb) {
            const imdbScore = (data.imdbRating && data.imdbRating !== 'N/A') ? data.imdbRating : 'N/A';
            const naClass = imdbScore === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-hover-item netrot-imdb${naClass}">★ ${imdbScore} <small>IMDb</small></span>`);
        }
        if (userSettings.showRotten) {
            const rt = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
            const rtScore = rt ? rt.Value : 'N/A';
            const naClass = rtScore === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-hover-item netrot-rt${naClass}">🍅 ${rtScore} <small>RT</small></span>`);
        }
        if (userSettings.showMetacritic) {
            const metaScore = (data.metascore && data.metascore !== 'N/A') ? data.metascore : 'N/A';
            const naClass = metaScore === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-hover-item netrot-meta${naClass}">M ${metaScore} <small>Meta</small></span>`);
        }
        return `<div class="netrot-hover-row">${items.join('')}</div>`;
    }

    function buildDetailCardsHtml(data) {
        let cards = [];

        // IMDb - always show if enabled
        if (userSettings.showImdb) {
            const imdbScore = (data.imdbRating && data.imdbRating !== 'N/A') ? data.imdbRating : 'N/A';
            const naClass = imdbScore === 'N/A' ? ' netrot-na-card' : '';
            cards.push(createCard('IMDb', imdbScore, '★', 'netrot-imdb-card' + naClass));
        }

        // Rotten Tomatoes - always show if enabled
        if (userSettings.showRotten) {
            const rt = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
            const rtScore = rt ? rt.Value : 'N/A';
            const naClass = rtScore === 'N/A' ? ' netrot-na-card' : '';
            cards.push(createCard('Rotten Tomatoes', rtScore, '🍅', 'netrot-rt-card' + naClass));
        }

        // Metacritic - always show if enabled
        if (userSettings.showMetacritic) {
            const metaScore = (data.metascore && data.metascore !== 'N/A') ? data.metascore : 'N/A';
            const naClass = metaScore === 'N/A' ? ' netrot-na-card' : '';
            cards.push(createCard('Metacritic', metaScore, 'M', 'netrot-meta-card' + naClass));
        }

        return `<div class="netrot-ratings-row">${cards.join('')}</div>`;
    }

    function createCard(source, score, icon, className) {
        return `
            <div class="netrot-rating-card ${className}">
                <div class="netrot-card-icon">${icon}</div>
                <div class="netrot-card-content">
                    <div class="netrot-card-score">${score}</div>
                    <div class="netrot-card-source">${source}</div>
                </div>
            </div>
        `;
    }

    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    function syncSettings() {
        chrome.storage.local.get(['showImdb', 'showRotten', 'showMetacritic'], (items) => {
            // Only update keys that exist in items
            if (items) {
                userSettings = { ...userSettings, ...items };
            }
        });
    }

    // Listen for changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            syncSettings();
        }
    });

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
