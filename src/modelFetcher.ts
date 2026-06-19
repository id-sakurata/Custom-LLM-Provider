import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { FetchedModel, ModelsResponse } from './types';

// Shared agents for persistent connections (Keep-Alive)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

/**
 * Fetches the list of available models from an OpenAI-compatible /v1/models endpoint.
 * @param modelsUrl The full URL to the models endpoint.
 * @param apiKey Optional API Key for authentication.
 * @returns A promise that resolves to an array of fetched models.
 */
export async function fetchModelsFromEndpoint(
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
