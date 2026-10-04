'use strict';
/**
 * Minimal AWS Signature V4 for S3-compatible storage (Backblaze B2), no dependencies.
 *   signRequest()  -> headers for an Authorization-header signed request
 *   presignUrl()   -> a time-limited GET url (query-string signed)
 * Verified against the examples in AWS's SigV4 documentation (see test/sigv4.test.js).
 */
const crypto = require('crypto');

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split('/').map(enc).join('/');

function amzDate(d = new Date()) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
}

function signingKey(secret, date8, region, service) {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date8), region), service), 'aws4_request');
}

function canonicalQuery(query) {
  return Object.keys(query || {})
    .sort()
    .map((k) => `${enc(k)}=${enc(String(query[k]))}`)
    .join('&');
}

/**
 * @param {object} o  { method, host, path (unencoded, starts with /), query, headers, body (Buffer|string|''),
 *                      region, service='s3', accessKeyId, secretAccessKey, date? }
 * @returns {{ headers: object, url: string }}  headers to send (incl. Authorization), and the request path+query
 */
function signRequest(o) {
  const service = o.service || 's3';
  const now = o.date || new Date();
  const amz = amzDate(now);
  const date8 = amz.slice(0, 8);
  const payloadHash = o.payloadHash || sha256hex(o.body || '');

  const headers = { ...(o.headers || {}), host: o.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz };
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = String(headers[k]).trim().replace(/\s+/g, ' ');
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');

  const cpath = encPath(o.path);
  const cquery = canonicalQuery(o.query);
  const canonical = [o.method, cpath, cquery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const scope = `${date8}/${o.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(o.secretAccessKey, date8, o.region, service))
    .update(toSign)
    .digest('hex');

  const out = {};
  for (const k of Object.keys(headers)) out[k] = headers[k];
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, url: cpath + (cquery ? '?' + cquery : ''), canonical, toSign, signature };
}

/** Query-signed (pre-signed) URL. */
function presignUrl(o) {
  const service = o.service || 's3';
  const now = o.date || new Date();
  const amz = amzDate(now);
  const date8 = amz.slice(0, 8);
  const scope = `${date8}/${o.region}/${service}/aws4_request`;

  const query = {
    ...(o.query || {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${o.accessKeyId}/${scope}`,
    'X-Amz-Date': amz,
    'X-Amz-Expires': String(o.expires || 3600),
    'X-Amz-SignedHeaders': 'host',
  };
  const cpath = encPath(o.path);
  const cquery = canonicalQuery(query);
  const canonical = [o.method || 'GET', cpath, cquery, `host:${o.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256hex(canonical)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(o.secretAccessKey, date8, o.region, service))
    .update(toSign)
    .digest('hex');
  return `${o.scheme || 'https'}://${o.host}${cpath}?${cquery}&X-Amz-Signature=${signature}`;
}

module.exports = { signRequest, presignUrl, sha256hex, enc, encPath };
