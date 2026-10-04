// Switch environments here, without changing update logic. Production is not enabled.
const UPDATE_BASE_URL = 'http://127.0.0.1:8091';
const PRODUCTION_UPDATE_BASE_URL = 'https://updates.n11x.dev';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isLoopback(url) {
  return ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
}

function validateBaseUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url)))) {
    throw new Error('Updates require an HTTPS origin or a local loopback HTTP origin.');
  }
  return url.origin;
}

module.exports = { UPDATE_BASE_URL, PRODUCTION_UPDATE_BASE_URL, UPDATE_CHECK_INTERVAL_MS, isLoopback, validateBaseUrl };
