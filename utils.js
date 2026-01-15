/**
 * NetRot Utilities
 * Helper functions for DOM manipulation, debouncing, and formatting.
 */

const Utils = {
    /**
     * Debounce function to limit rate of execution
     * @param {Function} func - The function to debounce
     * @param {number} wait - The delay in milliseconds
     * @returns {Function} - The debounced function
     */
    debounce: (func, wait) => {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    },

    /**
     * Normalize movie title for better search results
     * Removes special characters and Netflix specific text
     * @param {string} title - Raw title string
     * @returns {string} - Cleaned title
     */
    cleanTitle: (title) => {
        if (!title) return '';
        return title.trim().replace(/\s+/g, ' ');
    },

    /**
     * Extract Netflix Video ID from DOM element
     * Looks for links containing /watch/12345 or /title/12345
     * @param {Element} element - Context element (card, modal, etc.)
     * @returns {string|null} - Netflix Video ID or null
     */
    extractNetflixId: (element) => {
        // 1. Check element itself if it's a link
        if (element.tagName === 'A' && element.href) {
            const id = Utils.parseIdFromUrl(element.href);
            if (id) return id;
        }

        // 2. Search for link with specific classes/attributes first (optimization)
        const priorityLinks = element.querySelectorAll('a[href*="/watch/"], a[href*="/title/"]');
        for (const link of priorityLinks) {
            const id = Utils.parseIdFromUrl(link.href);
            if (id) return id;
        }

        // 3. Fallback: Search parent if we might be inside a link (up to 3 levels)
        let parent = element.parentElement;
        let levels = 0;
        while (parent && levels < 3) {
            if (parent.tagName === 'A' && parent.href) {
                const id = Utils.parseIdFromUrl(parent.href);
                if (id) return id;
            }
            parent = parent.parentElement;
            levels++;
        }

        return null;
    },

    /**
     * Helper to parse ID from URL
     */
    parseIdFromUrl: (url) => {
        try {
            const match = url.match(/\/(watch|title)\/(\d+)/);
            return match ? match[2] : null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Safe log function
     * @param {...any} args 
     */
    log: (...args) => {
        console.log('[NetRot]', ...args);
    },

    /**
     * Safe error log function
     * @param {...any} args 
     */
    error: (...args) => {
        console.error('[NetRot]', ...args);
    }
};
