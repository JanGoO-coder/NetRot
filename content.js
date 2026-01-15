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
        const selectors = [
            '.slider-item',
            '.title-card-container',
            '.boxart-round'
        ];

        const cards = document.querySelectorAll(selectors.join(', '));
        cards.forEach(card => {
            if (card.hasAttribute(NETROT_SUBSCRIBED)) return;

            const title = extractTitle(card);
            if (title) {
                card.setAttribute(NETROT_SUBSCRIBED, 'true');
                injectWithSubscription(card, title, null, 'card');
            }
        });
    }

    function scanDetailModals() {
        const modals = document.querySelectorAll('.previewModal--container, .detail-modal, [data-uia="preview-modal-container"]');

        modals.forEach(modal => {
            const container = modal.querySelector('.previewModal--detailsMetadata');
            if (container && container.hasAttribute(NETROT_SUBSCRIBED)) return;

            const title = extractTitleFromModal(modal);
            const year = extractYearFromModal(modal);

            if (title) {
                if (container) container.setAttribute(NETROT_SUBSCRIBED, 'true');
                injectWithSubscription(modal, title, year, 'detail');
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

            const title = extractTitleFromModal(card);
            if (title) {
                card.setAttribute(NETROT_SUBSCRIBED, 'true');
                injectWithSubscription(card, title, null, 'hover');
            }
        });
    }

    // =========================================================================
    // SUBSCRIPTION-BASED INJECTION
    // =========================================================================

    /**
     * Inject ratings UI with subscription to store updates
     * @param {Element} element - Target element
     * @param {string} title - Movie/show title
     * @param {string|null} year - Release year
     * @param {string} type - 'card', 'hover', or 'detail'
     */
    function injectWithSubscription(element, title, year, type) {
        // Create placeholder container
        const container = createContainer(type);
        if (!container) return;

        // Position and attach container
        attachContainer(element, container, type);

        // Get cache key for subscription
        const key = ratingsStore.getKey(title, year);

        // Subscribe to updates
        const unsubscribe = ratingsStore.subscribe(key, (data) => {
            updateContainer(container, data, type);
        });

        // Store unsubscribe function for cleanup
        activeSubscriptions.set(element, unsubscribe);

        // Trigger fetch (will use cache if available)
        ratingsStore.get(title, year);
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
     */
    function attachContainer(element, container, type) {
        switch (type) {
            case 'card':
                // Ensure parent is relative for absolute positioning
                if (getComputedStyle(element).position === 'static') {
                    element.style.position = 'relative';
                }
                element.appendChild(container);
                break;

            case 'hover':
                const metaArea = element.querySelector('.previewModal--tags, .previewModal--metadatAndControls-container, .evidence-list');
                if (metaArea && metaArea.parentNode) {
                    metaArea.parentNode.insertBefore(container, metaArea.nextSibling);
                } else {
                    const infoSection = element.querySelector('.previewModal--info, .bob-overview');
                    if (infoSection) {
                        infoSection.appendChild(container);
                    }
                }
                break;

            case 'detail':
                // Guard against duplicates
                if (element.querySelector('.netrot-detail-ratings')) {
                    container.remove();
                    return;
                }

                const synopsis = element.querySelector('.previewModal--text, .synopsis, .previewModal--synopsis');
                if (synopsis && synopsis.parentNode) {
                    synopsis.parentNode.insertBefore(container, synopsis);
                } else {
                    const buttonRow = element.querySelector('.previewModal--metadatAndControls, .buttonControls');
                    if (buttonRow) {
                        buttonRow.parentNode.insertBefore(container, buttonRow.nextSibling);
                    } else {
                        element.appendChild(container);
                    }
                }
                break;
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
        const ariaEl = element.querySelector('[aria-label], a[aria-label]');
        if (ariaEl) return cleanTitle(ariaEl.getAttribute('aria-label'));

        const img = element.querySelector('img');
        if (img && img.alt) return cleanTitle(img.alt);

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
        const yearEl = modal.querySelector('.year, .duration');
        if (yearEl && /^\d{4}$/.test(yearEl.textContent)) {
            return yearEl.textContent;
        }
        const metaText = modal.innerText;
        const match = metaText.match(/\b(19|20)\d{2}\b/);
        return match ? match[0] : null;
    }

    function cleanTitle(title) {
        if (!title) return null;
        return title
            .replace(/Netflix/i, '')
            .split(':')[0]
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
            const score = getRating(data, 'imdb') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-badge-item netrot-imdb${naClass}"><span class="netrot-badge-icon">★</span><span class="netrot-badge-score">${score}</span><span class="netrot-badge-label">IMDb</span></span>`);
        }

        if (userSettings.showRotten) {
            const score = getRating(data, 'rt') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-badge-item netrot-rt${naClass}"><span class="netrot-badge-icon">🍅</span><span class="netrot-badge-score">${score}</span><span class="netrot-badge-label">RT</span></span>`);
        }

        if (userSettings.showMetacritic) {
            const score = getRating(data, 'meta') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-badge-item netrot-meta${naClass}"><span class="netrot-badge-icon">M</span><span class="netrot-badge-score">${score}</span><span class="netrot-badge-label">Meta</span></span>`);
        }

        return items.join('');
    }

    function buildHoverRatingsHtml(data) {
        let items = [];

        if (userSettings.showImdb) {
            const score = getRating(data, 'imdb') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-hover-item netrot-imdb${naClass}">★ ${score} <small>IMDb</small></span>`);
        }
        if (userSettings.showRotten) {
            const score = getRating(data, 'rt') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-hover-item netrot-rt${naClass}">🍅 ${score} <small>RT</small></span>`);
        }
        if (userSettings.showMetacritic) {
            const score = getRating(data, 'meta') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na' : '';
            items.push(`<span class="netrot-hover-item netrot-meta${naClass}">M ${score} <small>Meta</small></span>`);
        }

        return `<div class="netrot-hover-row">${items.join('')}</div>`;
    }

    function buildDetailCardsHtml(data) {
        let cards = [];

        if (userSettings.showImdb) {
            const score = getRating(data, 'imdb') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na-card' : '';
            cards.push(createCard('IMDb', score, '★', 'netrot-imdb-card' + naClass));
        }

        if (userSettings.showRotten) {
            const score = getRating(data, 'rt') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na-card' : '';
            cards.push(createCard('Rotten Tomatoes', score, '🍅', 'netrot-rt-card' + naClass));
        }

        if (userSettings.showMetacritic) {
            const score = getRating(data, 'meta') || 'N/A';
            const naClass = score === 'N/A' ? ' netrot-na-card' : '';
            cards.push(createCard('Metacritic', score, 'M', 'netrot-meta-card' + naClass));
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
