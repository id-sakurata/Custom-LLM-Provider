"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timestamp = timestamp;
exports.calculateDelay = calculateDelay;
exports.isRetryableHttpError = isRetryableHttpError;
exports.jitterDelay = jitterDelay;
function timestamp() {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
}
function calculateDelay(attempt, config) {
    switch (config.retryBackoff) {
        case 'fixed':
            return config.retryDelay;
        case 'linear':
            return config.retryDelay * (attempt + 1);
        case 'exponential':
            return config.retryDelay * Math.pow(2, attempt);
        default:
            return config.retryDelay;
    }
}
function isRetryableHttpError(err, retryOnStatus) {
    const msg = err.message;
    for (const status of retryOnStatus) {
        if (msg.includes(`HTTP ${status}`) || msg.includes(`status ${status}`)) {
            return true;
        }
    }
    if (msg.includes('timed out') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')) {
        return true;
    }
    if (msg.includes('Empty response')) {
        return true;
    }
    return false;
}
function jitterDelay(baseDelay) {
    return baseDelay + Math.random() * 1000;
}
