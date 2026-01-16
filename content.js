/**
 * NetRot Content Script
 * Injects IMDb, Rotten Tomatoes, and Metacritic ratings into Netflix UI.
 * Uses RatingsStore for unified caching and event-driven updates.
 */

(function () {
    'use strict';

    const NETROT_MARKER = 'netrot-injected';
    const NETROT_SUBSCRIBED = 'netrot-subscribed';
    let observer = null;
    let userSettings = {
        showImdb: true,
        showRotten: true,
        showMetacritic: true
    };

    // Track active subscriptions for cleanup
    const activeSubscriptions = new WeakMap();

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    function init() {
        console.log('[NetRot] Initializing content script with RatingsStore...');

        // Initial settings sync
        syncSettings();

        // Watch for dynamic content loading (infinite scroll, modal opens)
        observer = new MutationObserver(debounce(scanAndInject, 500));
        observer.observe(document.body, { childList: true, subtree: true });

        // Initial scan
        scanAndInject();

        console.log('[NetRot] Content script initialized.');
    }

    // =========================================================================
    // MAIN SCANNER
    // =========================================================================
    function scanAndInject() {
        scanBrowseCards();
        scanDetailModals();
        scanHoverCards();
    }

    function scanBrowseCards() {
        // Use only the most specific selector to avoid nested duplicates
        // .title-card-container is inside .slider-item, so only target the inner one
        const selectors = [
            '.title-card-container',
            '.boxart-round'
        ];

        const cards = document.querySelectorAll(selectors.join(', '));
        cards.forEach(card => {
            if (card.hasAttribute(NETROT_SUBSCRIBED)) return;

            // Skip if a parent element already has a badge (handles any remaining nesting)
            if (card.closest('[netrot-subscribed="true"]')) return;

            const title = extractTitle(card);
            const videoId = Utils.extractNetflixId(card);
            const year = extractYearFromElement(card);

            if (title) {
                card.setAttribute(NETROT_SUBSCRIBED, 'true');
                injectWithSubscription(card, videoId, title, year, 'card');
            }
        });
    }

    function scanDetailModals() {
        // IMPORTANT: Only use .previewModal--container - NOT .detail-modal
        // .detail-modal class appears on many nested elements within the modal
        const modals = document.querySelectorAll('.previewModal--container, [data-uia="preview-modal-container"]');

        modals.forEach(modal => {
            // Skip if this modal is nested inside another modal (shouldn't happen, but be safe)
            if (modal.closest('[netrot-subscribed="true"]')) return;

            // Skip if already has ANY netrot ratings anywhere inside
            if (modal.querySelector('.netrot-detail-ratings, .netrot-hover-ratings')) return;
            if (modal.hasAttribute(NETROT_SUBSCRIBED)) return;

            const title = extractTitleFromModal(modal);
            const year = extractYearFromModal(modal);
            const videoId = Utils.extractNetflixId(modal);

            if (title) {
                modal.setAttribute(NETROT_SUBSCRIBED, 'true');
                injectWithSubscription(modal, videoId, title, year, 'detail');
            }
        });
    }

    function scanHoverCards() {
        const selectors = [
            '.mini-modal',
            '.bob-card',
            '.previewModal--wrapper',
            '.jawBoneContainer',
            '.bob-container'
        ];

        const cards = document.querySelectorAll(selectors.join(', '));

        cards.forEach(card => {
            if (card.hasAttribute(NETROT_SUBSCRIBED)) return;

            // Skip if already has ANY netrot ratings
            if (card.querySelector('.netrot-hover-ratings, .netrot-detail-ratings')) return;

            // Skip if this is inside OR is a detail modal container (handled by scanDetailModals)
            const detailSelectors = '.previewModal--container, [data-uia="preview-modal-container"]';
            if (card.matches(detailSelectors) || card.closest(detailSelectors)) return;

            const title = extractTitleFromModal(card);
            const videoId = Utils.extractNetflixId(card);
            const year = extractYearFromElement(card);

            if (title) {
                card.setAttribute(NETROT_SUBSCRIBED, 'true');
                injectWithSubscription(card, videoId, title, year, 'hover');
            }
        });
    }

    // =========================================================================
    // SUBSCRIPTION-BASED INJECTION
    // =========================================================================

    /**
     * Inject ratings UI with subscription to store updates
     * @param {Element} element - Target element
     * @param {string|null} videoId - Netflix Video ID
     * @param {string} title - Movie/show title
     * @param {string|null} year - Release year
     * @param {string} type - 'card', 'hover', or 'detail'
     */
    function injectWithSubscription(element, videoId, title, year, type) {
        // GLOBAL GUARD: Check if element already has any rating container
        if (element.querySelector('.netrot-card-badge, .netrot-hover-ratings, .netrot-detail-ratings')) {
            return;
        }

        // Create placeholder container
        const container = createContainer(type);
        if (!container) return;

        // Position and attach container
        const attached = attachContainer(element, container, type);
        if (!attached) return;  // Failed to attach, don't subscribe

        // Get cache key for subscription
        const key = ratingsStore.getKey(videoId, title, year);

        // Subscribe to updates
        const unsubscribe = ratingsStore.subscribe(key, (data) => {
            updateContainer(container, data, type);
        });

        // Store unsubscribe function for cleanup
        activeSubscriptions.set(element, unsubscribe);

        // Trigger fetch (will use cache if available)
        // Refresh strategy: Refresh for 'detail' and 'hover' views to ensure freshness
        const shouldRefresh = type === 'detail' || type === 'hover';
        ratingsStore.get(videoId, title, year, shouldRefresh);
    }

    /**
     * Create container element based on type
     */
    function createContainer(type) {
        const container = document.createElement('div');

        switch (type) {
            case 'card':
                container.className = 'netrot-card-badge netrot-loading';
                break;
            case 'hover':
                container.className = 'netrot-hover-ratings netrot-loading';
                break;
            case 'detail':
                container.className = 'netrot-detail-ratings netrot-loading';
                break;
            default:
                return null;
        }

        // Add loading skeleton
        container.innerHTML = '<span class="netrot-skeleton"></span>';
        return container;
    }

    /**
     * Attach container to appropriate location in element
     * @returns {boolean} true if attached successfully, false if duplicate or failed
     */
    function attachContainer(element, container, type) {
        // Universal duplicate check - no ratings container of ANY type should exist
        if (element.querySelector('.netrot-card-badge, .netrot-hover-ratings, .netrot-detail-ratings')) {
            container.remove();
            return false;
        }

        switch (type) {
            case 'card':
                // Ensure parent is relative for absolute positioning
                if (getComputedStyle(element).position === 'static') {
                    element.style.position = 'relative';
                }
                element.appendChild(container);
                return true;

            case 'hover':
                const metaArea = element.querySelector('.previewModal--tags, .previewModal--metadatAndControls-container, .evidence-list');
                if (metaArea && metaArea.parentNode) {
                    metaArea.parentNode.insertBefore(container, metaArea.nextSibling);
                    return true;
                } else {
                    const infoSection = element.querySelector('.previewModal--info, .bob-overview');
                    if (infoSection) {
                        infoSection.appendChild(container);
                        return true;
                    }
                }
                container.remove();
                return false;

            case 'detail':
                const synopsis = element.querySelector('.previewModal--text, .synopsis, .previewModal--synopsis');
                if (synopsis && synopsis.parentNode) {
                    synopsis.parentNode.insertBefore(container, synopsis);
                    return true;
                } else {
                    const buttonRow = element.querySelector('.previewModal--metadatAndControls, .buttonControls');
                    if (buttonRow) {
                        buttonRow.parentNode.insertBefore(container, buttonRow.nextSibling);
                        return true;
                    } else {
                        element.appendChild(container);
                        return true;
                    }
                }

            default:
                container.remove();
                return false;
        }
    }

    /**
     * Update container with ratings data (reactive update)
     */
    function updateContainer(container, data, type) {
        if (!container || !container.isConnected) return;

        // Use requestAnimationFrame for smooth updates
        requestAnimationFrame(() => {
            container.classList.remove('netrot-loading');
            container.classList.add('netrot-loaded');

            if (!shouldShow(data)) {
                container.style.display = 'none';
                return;
            }

            container.style.display = '';

            switch (type) {
                case 'card':
                    container.innerHTML = buildBadgeHtml(data);
                    break;
                case 'hover':
                    container.innerHTML = buildHoverRatingsHtml(data);
                    break;
                case 'detail':
                    container.innerHTML = buildDetailCardsHtml(data);
                    break;
            }
        });
    }

    // =========================================================================
    // DATA EXTRACTION
    // =========================================================================
    function extractTitle(element) {
        // Priority 1: Netflix's internal title data attribute
        const titleEl = element.querySelector('[data-uia="title-text"], .title-text');
        if (titleEl) return cleanTitle(titleEl.textContent);

        // Priority 2: aria-label (common on cards)
        const ariaEl = element.querySelector('[aria-label], a[aria-label]');
        if (ariaEl) return cleanTitle(ariaEl.getAttribute('aria-label'));

        // Priority 3: Image alt text
        const img = element.querySelector('img');
        if (img && img.alt) return cleanTitle(img.alt);

        // Priority 4: Fallback text elements
        const textEl = element.querySelector('.fallback-text, .title-title, .boxart-title');
        if (textEl) return cleanTitle(textEl.textContent);

        return null;
    }

    function extractTitleFromModal(modal) {
        // Priority 1: Boxart image in detail modal (most reliable for detail view)
        // Try multiple selector variations to ensure we catch it
        const boxartSelectors = [
            '.previewModal--boxart img',
            '.previewModal--poster img',
            '[class*="boxart"] img',
            '.ptrack-content img.boxart-image',
            'img.previewModal--boxart',
            'img[class*="boxart"]'
        ];

        for (const selector of boxartSelectors) {
            const boxart = modal.querySelector(selector);
            if (boxart && boxart.alt && boxart.alt.trim()) {
                console.log('[NetRot] Found title from boxart:', boxart.alt);
                return cleanTitle(boxart.alt);
            }
        }

        // Priority 2: Title treatment logo
        const logo = modal.querySelector('.previewModal--player-titleTreatment-logo, img.logo');
        if (logo && logo.alt) return cleanTitle(logo.alt);

        // Priority 3: Section header
        const header = modal.querySelector('.previewModal--section-header, h3, [data-uia="preview-modal-title"]');
        if (header) return cleanTitle(header.textContent);

        // Priority 4: Fallback to generic title extraction
        return extractTitle(modal);
    }

    /**
     * Extract year from any element (modal, card, hover)
     * Searches for year patterns in metadata areas
     */
    function extractYearFromElement(element) {
        // Try specific year elements first
        const yearEl = element.querySelector('.year, .duration, [data-uia="year"], .videoMetadata--year');
        if (yearEl && /^\d{4}$/.test(yearEl.textContent.trim())) {
            return yearEl.textContent.trim();
        }

        // Search in metadata area
        const metaArea = element.querySelector('.previewModal--metadatAndControls, .meta, .evidence-list, .supplementalMessage');
        if (metaArea) {
            const match = metaArea.innerText.match(/\b(19|20)\d{2}\b/);
            if (match) return match[0];
        }

        // Last resort: search entire element (limited depth)
        const match = element.innerText?.substring(0, 500).match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : null;
    }

    // Alias for backward compatibility
    const extractYearFromModal = extractYearFromElement;

    function cleanTitle(title) {
        if (!title) return null;
        return title
            .replace(/Netflix/i, '')
            .replace(/^Watch\s+/i, '')
            // Don't split on colon - keeps full series titles like "Stranger Things: Season 4"
            .trim();
    }

    // =========================================================================
    // UI HELPERS
    // =========================================================================
    function shouldShow(data) {
        // Show if at least one rating source is enabled
        // Data with error status still shows N/A values
        return userSettings.showImdb || userSettings.showRotten || userSettings.showMetacritic;
    }

    /**
     * Get rating value from normalized data structure
     */
    function getRating(data, source) {
        // Try new normalized structure first
        if (data.ratings) {
            switch (source) {
                case 'imdb':
                    return data.ratings.imdb?.score || null;
                case 'rt':
                    return data.ratings.rottenTomatoes?.score || null;
                case 'meta':
                    return data.ratings.metacritic?.score || null;
            }
        }

        // Fall back to legacy structure
        switch (source) {
            case 'imdb':
                return data.imdbRating !== 'N/A' ? data.imdbRating : null;
            case 'rt':
                const rt = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
                return rt?.Value || null;
            case 'meta':
                return data.metascore !== 'N/A' ? data.metascore : null;
        }

        return null;
    }

    // =========================================================================
    // HTML BUILDERS
    // =========================================================================
    function buildBadgeHtml(data) {
        let items = [];

        if (userSettings.showImdb) {
            const score = getRating(data, 'imdb');
            if (score) {
                items.push(`<span class="netrot-badge-item netrot-imdb"><span class="netrot-badge-icon">★</span><span class="netrot-badge-score">${score}</span><span class="netrot-badge-label">IMDb</span></span>`);
            }
        }

        if (userSettings.showRotten) {
            const score = getRating(data, 'rt');
            if (score) {
                items.push(`<span class="netrot-badge-item netrot-rt"><span class="netrot-badge-icon">🍅</span><span class="netrot-badge-score">${score}</span><span class="netrot-badge-label">RT</span></span>`);
            }
        }

        if (userSettings.showMetacritic) {
            const score = getRating(data, 'meta');
            if (score) {
                items.push(`<span class="netrot-badge-item netrot-meta"><span class="netrot-badge-icon">M</span><span class="netrot-badge-score">${score}</span><span class="netrot-badge-label">Meta</span></span>`);
            }
        }

        // If no ratings available, show a subtle indicator
        if (items.length === 0) {
            return '<span class="netrot-badge-item netrot-no-data"><span class="netrot-badge-score">—</span></span>';
        }

        return items.join('');
    }

    function buildHoverRatingsHtml(data) {
        let items = [];

        if (userSettings.showImdb) {
            const score = getRating(data, 'imdb');
            if (score) {
                items.push(`<span class="netrot-hover-item netrot-imdb">★ ${score} <small>IMDb</small></span>`);
            }
        }
        if (userSettings.showRotten) {
            const score = getRating(data, 'rt');
            if (score) {
                items.push(`<span class="netrot-hover-item netrot-rt">🍅 ${score} <small>RT</small></span>`);
            }
        }
        if (userSettings.showMetacritic) {
            const score = getRating(data, 'meta');
            if (score) {
                items.push(`<span class="netrot-hover-item netrot-meta">M ${score} <small>Meta</small></span>`);
            }
        }

        // If no ratings, show minimal indicator
        if (items.length === 0) {
            items.push('<span class="netrot-hover-item netrot-no-data">No ratings</span>');
        }

        return `<div class="netrot-hover-row">${items.join('')}</div>`;
    }

    function buildDetailCardsHtml(data) {
        let cards = [];

        if (userSettings.showImdb) {
            const score = getRating(data, 'imdb');
            if (score) {
                cards.push(createCard('IMDb', score, '★', 'netrot-imdb-card'));
            }
        }

        if (userSettings.showRotten) {
            const score = getRating(data, 'rt');
            if (score) {
                cards.push(createCard('Rotten Tomatoes', score, '🍅', 'netrot-rt-card'));
            }
        }

        if (userSettings.showMetacritic) {
            const score = getRating(data, 'meta');
            if (score) {
                cards.push(createCard('Metacritic', score, 'M', 'netrot-meta-card'));
            }
        }

        // Show message if no ratings available
        if (cards.length === 0) {
            cards.push('<div class="netrot-no-ratings">No ratings available</div>');
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

    // =========================================================================
    // UTILITIES
    // =========================================================================
    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    function syncSettings() {
        chrome.storage.local.get(['showImdb', 'showRotten', 'showMetacritic'], (items) => {
            if (items) {
                userSettings = { ...userSettings, ...items };
            }
        });
    }

    // Listen for settings changes
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            syncSettings();
            // Re-scan to apply new settings
            scanAndInject();
        }
    });

    // =========================================================================
    // CLEANUP (for SPA navigation)
    // =========================================================================
    function cleanup() {
        // Clean up subscriptions when elements are removed
        const cleanupObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.removedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const unsubscribe = activeSubscriptions.get(node);
                        if (unsubscribe) {
                            unsubscribe();
                            activeSubscriptions.delete(node);
                        }
                    }
                });
            });
        });

        cleanupObserver.observe(document.body, { childList: true, subtree: true });
    }

    // =========================================================================
    // START
    // =========================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init();
            cleanup();
        });
    } else {
        init();
        cleanup();
    }

})();
