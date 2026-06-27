"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchModelsFromEndpoint = fetchModelsFromEndpoint;
const https = __importStar(require("https"));
const http = __importStar(require("http"));
const net = __importStar(require("net"));
const url_1 = require("url");
// Shared agents for persistent connections (Keep-Alive)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });
/**
 * Makes a single HTTP request to fetch models.
 */
function fetchModelsOnce(modelsUrl, apiKey, proxyUrl) {
    return new Promise((resolve, reject) => {
        const url = new url_1.URL(modelsUrl);
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const options = {
            method: 'GET',
            agent: isHttps ? httpsAgent : httpAgent,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
        };
        if (proxyUrl) {
            const proxy = new url_1.URL(proxyUrl);
            options.hostname = proxy.hostname;
            options.port = proxy.port || '8080';
            if (isHttps) {
                options.agent = undefined;
                options.createConnection = (_o, oncreate) => {
                    const proxyPort = String(options.port ?? '8080');
                    const proxyHost = String(options.hostname ?? 'localhost');
                    const proxySocket = net.connect(Number(proxyPort), proxyHost, () => {
                        proxySocket.write(`CONNECT ${url.hostname}:${url.port || '443'} HTTP/1.1\r\n` +
                            `Host: ${url.hostname}:${url.port || '443'}\r\n\r\n`);
                    });
                    proxySocket.once('data', (data) => {
                        if (data.toString().startsWith('HTTP/1.1 200')) {
                            oncreate(null, proxySocket);
                        }
                        else {
                            oncreate(new Error(`Proxy CONNECT failed: ${data.toString().slice(0, 100)}`), null);
                        }
                    });
                    proxySocket.on('error', (err) => oncreate(err, null));
                    return proxySocket;
                };
                options.path = url.pathname + url.search;
            }
            else {
                options.path = modelsUrl;
            }
        }
        else {
            options.hostname = url.hostname;
            options.port = url.port || (isHttps ? 443 : 80);
            options.path = url.pathname + url.search;
        }
        const req = lib.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed && Array.isArray(parsed.data)) {
                            resolve(parsed.data);
                        }
                        else {
                            reject(new Error(`Unexpected response format from ${modelsUrl}`));
                        }
                    }
                    catch (e) {
                        reject(new Error(`Failed to parse models response: ${e}`));
                    }
                }
                else {
                    reject(new Error(`HTTP ${res.statusCode} from ${modelsUrl}: ${data.slice(0, 200)}`));
                }
            });
        });
        req.on('error', (err) => {
            reject(new Error(`Network error fetching models: ${err.message}`));
        });
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error(`Timeout fetching models from ${modelsUrl}`));
        });
        req.end();
    });
}
/**
 * Determines if a fetch error is eligible for retry.
 * Skips 401/403 (auth failures) and non-retryable HTTP codes.
 */
function isModelsFetchRetryable(err, retryOnStatus) {
    const msg = err.message;
    if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) {
        return false;
    }
    for (const status of retryOnStatus) {
        if (msg.includes(`HTTP ${status}`)) {
            return true;
        }
    }
    if (msg.includes('timed out') || msg.includes('Network error') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')) {
        return true;
    }
    return false;
}
/**
 * Fetches the list of available models from an OpenAI-compatible /v1/models endpoint.
 * Supports automatic retry on configurable HTTP status codes and network errors.
 * @param modelsUrl The full URL to the models endpoint.
 * @param apiKey Optional API Key for authentication.
 * @param retryConfig Optional retry configuration (uses defaults if omitted).
 * @returns A promise that resolves to an array of fetched models.
 */
async function fetchModelsFromEndpoint(modelsUrl, apiKey, retryConfig, proxyUrl) {
    const config = retryConfig ?? { maxRetries: 0, retryDelay: 1000, retryBackoff: 'exponential', retryOnStatus: [429, 500, 502, 503, 504] };
    const maxRetries = config.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fetchModelsOnce(modelsUrl, apiKey, proxyUrl);
        }
        catch (err) {
            if (attempt >= maxRetries || !(err instanceof Error) || !isModelsFetchRetryable(err, config.retryOnStatus)) {
                throw err;
            }
            const delay = config.retryBackoff === 'fixed'
                ? config.retryDelay
                : config.retryBackoff === 'linear'
                    ? config.retryDelay * (attempt + 1)
                    : config.retryDelay * Math.pow(2, attempt);
            console.warn(`[retryHandler] Fetch models attempt ${attempt + 1}/${maxRetries} failed: ${err.message}. Retrying in ${delay}ms...`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw new Error('Exhausted all retry attempts');
}
