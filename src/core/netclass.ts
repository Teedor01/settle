export type NetClass =
  | 'cloud_inference'
  | 'app_check'
  | 'recaptcha'
  | 'installations'
  | 'telemetry'
  | 'local_asset'
  | 'unclassified_google'
  | 'unclassified';

const INFERENCE_HOSTS = new Set([
  'firebasevertexai.googleapis.com',
  'firebaseml.googleapis.com',
  'generativelanguage.googleapis.com',
]);
const INFERENCE_PATH = /:(?:stream)?generatecontent\b|:counttokens\b|:embedcontent\b|:predict\b/i;

const TELEMETRY_HOSTS = [
  /^firebaselogging[\w-]*\.googleapis\.com$/,
  /^firebaseremoteconfig\.googleapis\.com$/,
  /^firebase\.googleapis\.com$/,
  /^www\.google-analytics\.com$/,
  /^analytics\.google\.com$/,
  /^region\d*\.google-analytics\.com$/,
];

export function classifyUrl(url: string, pageOrigin?: string): NetClass {
  let u: URL;
  try {
    u = new URL(url, pageOrigin ?? 'http://localhost');
  } catch {
    return 'unclassified';
  }
  const host = u.hostname.toLowerCase();
  if (INFERENCE_HOSTS.has(host) || host.endsWith('aiplatform.googleapis.com') || INFERENCE_PATH.test(u.pathname)) {
    return 'cloud_inference';
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return 'local_asset';
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') return 'unclassified';
  if (pageOrigin) {
    const page = new URL(pageOrigin);
    if (u.origin === page.origin || ((u.protocol === 'ws:' || u.protocol === 'wss:') && u.host === page.host)) return 'local_asset';
  }
  if (host === 'firebaseappcheck.googleapis.com' || host === 'content-firebaseappcheck.googleapis.com') return 'app_check';
  if (host === 'recaptchaenterprise.googleapis.com' || ((host === 'www.google.com' || host === 'www.gstatic.com') && u.pathname.includes('/recaptcha'))) {
    return 'recaptcha';
  }
  if (host === 'firebaseinstallations.googleapis.com') return 'installations';
  if (TELEMETRY_HOSTS.some((re) => re.test(host)) || (host === 'play.google.com' && u.pathname.startsWith('/log'))) return 'telemetry';
  if (host.endsWith('googleapis.com') || host.endsWith('gstatic.com') || host.endsWith('google.com') || host.includes('firebase')) {
    return 'unclassified_google';
  }
  return 'unclassified';
}

export function redactUrl(url: string): string {
  try {
    const u = new URL(url, 'http://localhost');
    const base = `${u.origin}${u.pathname}`;
    return url.startsWith('http') || url.startsWith('//') ? base : u.pathname;
  } catch {
    return url.split('?')[0]?.split('#')[0] ?? url;
  }
}

export function findLeaks(text: string, needles: string[]): string[] {
  if (!text) return [];
  const hay = [text.toLowerCase()];
  try {
    hay.push(decodeURIComponent(text.replace(/\+/g, ' ')).toLowerCase());
  } catch {
    /* not URL-encoded */
  }
  const found = new Set<string>();
  for (const n of needles) {
    if (n.length < 4) continue;
    const needle = n.toLowerCase();
    if (hay.some((h) => h.includes(needle))) found.add(n);
  }
  return [...found];
}
