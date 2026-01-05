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
