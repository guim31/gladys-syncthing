// -----------------------------------------------------------------------------
// The one function that talks to the network: an HTTP(S) request on node:http
// / node:https. Not on fetch: fetch cannot accept the self-signed certificate
// of one server only (Syncthing generates one when its interface is switched
// to HTTPS), node:https can, per request.
//
// The client takes this function as a parameter: the tests replace it with an
// in-memory Syncthing (test/helpers/fakeSyncthing.js).
// (Adapted from guim31/gladys-uptime-kuma.)
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';

// The configuration of a Syncthing with hundreds of folders and devices stays
// well under a megabyte; a batch of events too.
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * @param {string} url absolute URL
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @param {boolean} [options.insecure] accept a certificate that does not verify (HTTPS only)
 * @param {number} [options.timeoutMs] idle time after which the request fails
 * @param {AbortSignal} [options.signal] cancels the request (a pending long poll)
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
 */
export function httpRequest(
  url,
  { method = 'GET', headers = {}, body, insecure = false, timeoutMs = 10_000, signal } = {},
) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const request = (isHttps ? https : http).request(
      target,
      {
        method,
        headers:
          body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
        signal,
        ...(isHttps ? { rejectUnauthorized: !insecure } : {}),
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            request.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('timeout', () => {
      const error = new Error(`Timed out after ${timeoutMs} ms`);
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    });
    request.on('error', (err) => reject(err.name === 'AbortError' ? abortError() : err));
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export function abortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}
