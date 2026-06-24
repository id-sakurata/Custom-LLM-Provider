import { RetryConfig } from './types';

export function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function calculateDelay(attempt: number, config: RetryConfig): number {
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

export function isRetryableHttpError(err: Error, retryOnStatus: number[]): boolean {
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

export function jitterDelay(baseDelay: number): number {
  return baseDelay + Math.random() * 1000;
}
