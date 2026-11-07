// Only the local UI and the owner's GitHub Pages origin may control this service.
// The service continues to listen exclusively on loopback.
export const pagesOrigin = process.env.PAGES_ORIGIN || 'https://moyuhama.github.io';
export function allowRequest(req, res) {
  const host = req.headers.host || '';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.replace(/:\d+$/, ''))) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}` && origin !== pagesOrigin) return false;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // For browsers that still use Private Network Access preflights.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  return true;
}
