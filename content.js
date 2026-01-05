/**
 * NetRot Content Script - v7
 * Injects IMDb and Rotten Tomatoes ratings into Netflix UI.
 */

(function () {
    'use strict';

    const NETROT_MARKER = 'netrot-injected';
    let observer = null;

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    function init() {
        console.log('[NetRot] Initializing content script v7...');

        observer = new MutationObserver(debounce(scanAndInject, 300));
        observer.observe(document.body, { childList: true, subtree: true });

        scanAndInject();
        console.log('[NetRot] Observer started.');
    }

    // =========================================================================
    // MAIN SCAN FUNCTION
    // =========================================================================
    function scanAndInject() {
        scanMovieCards();
        scanDetailViews();
    }

    // =========================================================================
    // MOVIE CARDS (Browse thumbnails - Top-Left Badge)
    // =========================================================================
    function scanMovieCards() {
        const cardSelectors = [
            '.slider-item',
            '.title-card-container',
            '.boxart-round',
            '[data-list-context] .title-card',
        ];

        const cards = document.querySelectorAll(cardSelectors.join(', '));

        cards.forEach(card => {
            if (card.hasAttribute(NETROT_MARKER)) return;

            const title = extractTitleFromCard(card);
            if (!title) return;

            card.setAttribute(NETROT_MARKER, 'true');
            fetchRatings(title, (data) => {
                if (data) injectCardBadge(card, data);
            });
        });
    }

    // =========================================================================
    // DETAIL VIEWS (Full modal when clicking)
    // =========================================================================
    function scanDetailViews() {
        const modalSelectors = [
            '.previewModal--container',
            '.jawBoneContainer',
            '.jawBone',
            '.detail-modal',
            '[data-uia="preview-modal-container"]',
        ];

        const modals = document.querySelectorAll(modalSelectors.join(', '));

        modals.forEach(modal => {
            if (modal.hasAttribute(NETROT_MARKER)) return;

            const title = extractTitleFromModal(modal);
            if (!title) return;

            console.log('[NetRot] Found detail modal for:', title);
            modal.setAttribute(NETROT_MARKER, 'true');

            fetchRatings(title, (data) => {
                if (data) injectDetailRatings(modal, data);
            });
        });
    }

    // =========================================================================
    // TITLE EXTRACTION
    // =========================================================================
    function extractTitleFromCard(card) {
        const img = card.querySelector('img');
        if (img && img.alt) return cleanTitle(img.alt);

        const ariaEl = card.querySelector('[aria-label]') || card.closest('[aria-label]');
        if (ariaEl) return cleanTitle(ariaEl.getAttribute('aria-label'));

        const fallback = card.querySelector('.fallback-text');
        if (fallback && fallback.textContent) return cleanTitle(fallback.textContent);

        return null;
    }

    function extractTitleFromModal(modal) {
        const logo = modal.querySelector('.previewModal--player-titleTreatment-logo, img.logo');
        if (logo && logo.alt) return cleanTitle(logo.alt);

        const titleText = modal.querySelector('.previewModal--section-header, h3, .title-title');
        if (titleText && titleText.textContent) return cleanTitle(titleText.textContent);

        if (modal.getAttribute('aria-label')) return cleanTitle(modal.getAttribute('aria-label'));

        const anyImg = modal.querySelector('img[alt]');
        if (anyImg && anyImg.alt) return cleanTitle(anyImg.alt);

        return null;
    }

    function cleanTitle(title) {
        if (!title) return null;
        return title.trim().replace(/\s+/g, ' ').split(':')[0].trim();
    }

    // =========================================================================
    // API FETCH
    // =========================================================================
    function fetchRatings(title, callback) {
        console.log('[NetRot] Fetching ratings for:', title);
        try {
            chrome.runtime.sendMessage({ type: 'FETCH_Ratings', title: title }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn('[NetRot] Extension context issue:', chrome.runtime.lastError.message);
                    callback(null);
                    return;
                }
                if (response && response.success && response.data) {
                    console.log('[NetRot] Got ratings:', response.data);
                    callback(response.data);
                } else {
                    console.log('[NetRot] No ratings found:', response?.error);
                    callback(null);
                }
            });
        } catch (e) {
            console.warn('[NetRot] Message send failed:', e.message);
            callback(null);
        }
    }

    // =========================================================================
    // UI INJECTION - CARD BADGE (Top-Left on Browse Cards)
    // =========================================================================
    function injectCardBadge(card, data) {
        const html = buildBadgeHtml(data);
        if (!html) return;

        const badge = document.createElement('div');
        badge.className = 'netrot-card-badge';
        badge.innerHTML = html;

        const style = getComputedStyle(card);
        if (style.position === 'static') {
            card.style.position = 'relative';
        }

        card.appendChild(badge);
    }

    // =========================================================================
    // UI INJECTION - DETAIL MODAL RATINGS (Above Description)
    // =========================================================================
    function injectDetailRatings(modal, data) {
        const html = buildDetailRatingsHtml(data);
        if (!html) return;

        const container = document.createElement('div');
        container.className = 'netrot-detail-ratings';
        container.innerHTML = html;

        const descriptionSelectors = [
            '.previewModal--text',
            '.synopsis',
            '.previewModal--synopsis',
        ];

        let targetElement = null;
        for (const selector of descriptionSelectors) {
            targetElement = modal.querySelector(selector);
            if (targetElement) break;
        }

        if (targetElement && targetElement.parentNode) {
            targetElement.parentNode.insertBefore(container, targetElement);
            console.log('[NetRot] Injected ratings above description.');
        } else {
            const infoSection = modal.querySelector('.previewModal--info');
            if (infoSection) {
                infoSection.insertBefore(container, infoSection.firstChild);
            }
        }
    }

    // =========================================================================
    // HTML BUILDERS
    // =========================================================================
    function buildBadgeHtml(data) {
        let parts = [];

        if (data.imdbRating && data.imdbRating !== 'N/A') {
            parts.push(`<span class="netrot-imdb">★ ${data.imdbRating}</span>`);
        }

        const rt = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
        if (rt) {
            parts.push(`<span class="netrot-rt">🍅 ${rt.Value}</span>`);
        }

        return parts.length > 0 ? parts.join('') : null;
    }

    function buildDetailRatingsHtml(data) {
        let cards = [];

        if (data.imdbRating && data.imdbRating !== 'N/A') {
            cards.push(`
                <div class="netrot-rating-card netrot-imdb-card">
                    <div class="netrot-card-icon">★</div>
                    <div class="netrot-card-content">
                        <div class="netrot-card-score">${data.imdbRating}</div>
                        <div class="netrot-card-source">IMDb</div>
                    </div>
                </div>
            `);
        }

        const rt = data.Ratings?.find(r => r.Source === 'Rotten Tomatoes');
        if (rt) {
            cards.push(`
                <div class="netrot-rating-card netrot-rt-card">
                    <div class="netrot-card-icon">🍅</div>
                    <div class="netrot-card-content">
                        <div class="netrot-card-score">${rt.Value}</div>
                        <div class="netrot-card-source">Rotten Tomatoes</div>
                    </div>
                </div>
            `);
        }

        if (cards.length === 0) return null;

        // Wrap cards in a flex row container
        return `<div class="netrot-ratings-row">${cards.join('')}</div>`;
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

    // =========================================================================
    // START
    // =========================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
