import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { FetchedModel, ModelsResponse, RetryConfig } from './types';

// Shared agents for persistent connections (Keep-Alive)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

/**
 * Makes a single HTTP request to fetch models.
 */
function fetchModelsOnce(
  modelsUrl: string,
  apiKey: string
): Promise<FetchedModel[]> {
  return new Promise((resolve, reject) => {
    const url = new URL(modelsUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed: ModelsResponse = JSON.parse(data);
            if (parsed && Array.isArray(parsed.data)) {
              resolve(parsed.data);
            } else {
              reject(new Error(`Unexpected response format from ${modelsUrl}`));
            }
          } catch (e) {
            reject(new Error(`Failed to parse models response: ${e}`));
          }
        } else {
          reject(
            new Error(
              `HTTP ${res.statusCode} from ${modelsUrl}: ${data.slice(0, 200)}`
            )
          );
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
function isModelsFetchRetryable(err: Error, retryOnStatus: number[]): boolean {
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
export async function fetchModelsFromEndpoint(
  modelsUrl: string,
  apiKey: string,
  retryConfig?: RetryConfig
): Promise<FetchedModel[]> {
  const config = retryConfig ?? { maxRetries: 0, retryDelay: 1000, retryBackoff: 'exponential', retryOnStatus: [429, 500, 502, 503, 504] };
  const maxRetries = config.maxRetries;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchModelsOnce(modelsUrl, apiKey);
    } catch (err) {
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
