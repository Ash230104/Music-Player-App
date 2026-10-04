'use strict';
/**
 * Google sign-in + read-only access to the signed-in user's YouTube playlists
 * (including private ones and "Liked videos").
 *
 * How it works
 *   - OAuth 2.0 "installed app" flow: the login page opens in the user's normal
 *     browser (Google blocks sign-in inside embedded windows such as Electron's),
 *     and Google redirects back to http://127.0.0.1:<port>/oauth/google/callback,
 *     which the app's own local server already listens on. PKCE + a random
 *     `state` protect the exchange.
 *   - Only the scope youtube.readonly is requested.
 *   - The refresh token is encrypted with Electron's safeStorage (OS keychain /
 *     DPAPI) before it touches disk. If the OS can't encrypt, the login is kept
 *     in memory only (you sign in again after a restart).
 *   - The renderer never sees any token; it only gets status + playlist lists.
 *   - Downloads themselves still go through yt-dlp without any login: this
 *     module is only used to LIST a private playlist (see downloader.js).
 *
 * You need an OAuth client (type "Desktop app") from Google Cloud Console with the
 * "YouTube Data API v3" enabled. Put its id/secret in google-client.bundled.json (shipped
 * with the app, so friends don't have to enter anything), or in Settings → Google account,
 * or in the env vars GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/youtube/v3';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const BUNDLED_FILE = path.join(__dirname, 'google-client.bundled.json');
const ID_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;

/** Read { clientId, clientSecret } from a JSON file; null if missing or still a placeholder. */
function readClientFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = String((j && j.clientId) || '').trim();
    const secret = String((j && j.clientSecret) || '').trim();
    if (ID_RE.test(id) && secret.length >= 8 && !/\s/.test(secret)) return { id, secret };
  } catch (_) { /* missing or unreadable */ }
  return null;
}
const MAX_PLAYLIST_ITEMS = 5000;

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Minimal https helper (no dependency on the Node/Electron version's fetch). */
function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { ...headers };
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers: h, timeout: 20000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
          resolve({ status: res.statusCode, json, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function describeApiError(r) {
  const raw = JSON.stringify(r.json || {});
  if (/accessNotConfigured|SERVICE_DISABLED/.test(raw)) {
    return fail('api', 'The YouTube Data API v3 is not enabled for your Google Cloud project. Enable it in Google Cloud Console, then try again.');
  }
  if (/quotaExceeded|rateLimitExceeded|dailyLimitExceeded/.test(raw)) {
    return fail('api', "Google's daily YouTube API quota is used up. Try again tomorrow.");
  }
  if (/playlistNotFound|playlistItemsNotAccessible|playlistForbidden/.test(raw) || r.status === 404) {
    return fail('api', "That playlist wasn't found in the signed-in Google account. A private playlist can only be read by the account that owns it.");
  }
  if (r.status === 403 || /insufficientPermissions|forbidden/.test(raw)) {
    return fail('api', 'Google did not allow access to YouTube. Sign out and sign in again, and tick the YouTube permission.');
  }
  return fail('api', `YouTube API error (${r.status}).`);
}

function createGoogleAuth({ userData, safeStorage = null, openExternal, redirectUri, log = () => {}, onSignedIn = () => {} }) {
  const clientFile = path.join(userData, 'google-client.json');
  const tokenFile = path.join(userData, 'google-token.bin');

  let client = loadClient();
  let refreshToken = null;
  let access = null; //   { token, expiresAt }
  let channel = null; //  { title, likesId }
  let pending = null; //  { state, verifier, timer }
  let refreshing = null;
  let lastError = '';
  let persisted = false;

  // ------------------------------------------------------------- storage --
  const canEncrypt = () => !!(safeStorage && safeStorage.isEncryptionAvailable());

  // Order of priority: environment variables, then what was saved from Settings on this
  // computer, then the client bundled with the app (google-client.bundled.json, next to this file).
  function loadClient() {
    const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    if (id && secret) return { id, secret };
    return readClientFile(clientFile) || readClientFile(BUNDLED_FILE);
  }

  function saveToken(rt) {
    if (!canEncrypt()) return false;
    try {
      fs.writeFileSync(tokenFile, safeStorage.encryptString(rt), { mode: 0o600 });
      return true;
    } catch (err) {
      log('Could not store Google login:', err.message);
      return false;
    }
  }

  function readToken() {
    if (!canEncrypt()) return null;
    try {
      return safeStorage.decryptString(fs.readFileSync(tokenFile));
    } catch (_) {
      return null;
    }
  }

  function clearLocal() {
    refreshToken = null;
    access = null;
    channel = null;
    persisted = false;
    try { fs.rmSync(tokenFile, { force: true }); } catch (_) { /* ignore */ }
  }

  refreshToken = readToken();
  persisted = !!refreshToken;

  // ---------------------------------------------------------------- login --
  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  async function beginLogin() {
    if (!client) throw fail('not_configured', 'Add your Google client ID and secret first.');
    cancelPending();
    lastError = '';
    const state = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const url = `${AUTH_URL}?${new URLSearchParams({
      client_id: client.id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline', // we want a refresh token
      prompt: 'select_account consent',
    })}`;
    pending = { state, verifier, timer: setTimeout(() => { pending = null; }, LOGIN_TIMEOUT_MS) };
    openExternal(url);
  }

  /** Called by the local server when Google redirects back. */
  async function handleCallback(params) {
    const p = pending;
    if (!p || params.get('state') !== p.state) {
      return { ok: false, message: 'This sign-in link is not valid any more. Start again from the app.' };
    }
    cancelPending();

    if (params.get('error')) {
      lastError = params.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : 'Google sign-in failed.';
      return { ok: false, message: lastError };
    }
    const code = params.get('code');
    if (!code) {
      lastError = 'Google did not send a sign-in code.';
      return { ok: false, message: lastError };
    }

    try {
      const r = await request(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: client.id,
          client_secret: client.secret,
          code,
          code_verifier: p.verifier,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });
      if (r.status !== 200 || !r.json || !r.json.access_token) {
        log('Google token exchange failed:', r.status, r.json && r.json.error);
        throw new Error('Google refused the sign-in. Check the client ID and secret.');
      }
      if (!String(r.json.scope || '').includes(SCOPE)) {
        throw new Error('The YouTube permission was not granted. Sign in again and tick it.');
      }
      if (!r.json.refresh_token) throw new Error('Google did not return a long-lived login. Try signing in again.');

      access = { token: r.json.access_token, expiresAt: Date.now() + (r.json.expires_in || 3600) * 1000 };
      refreshToken = r.json.refresh_token;
      persisted = saveToken(refreshToken);
      channel = null;
      lastError = '';
      try { await channelInfo(); } catch (_) { /* name is cosmetic */ }
      onSignedIn();
      return { ok: true, message: 'You are signed in. You can close this tab and go back to the app.' };
    } catch (err) {
      lastError = err.message;
      return { ok: false, message: err.message };
    }
  }

  async function signOut() {
    cancelPending();
    const rt = refreshToken;
    clearLocal();
    lastError = '';
    if (rt) {
      try {
        await request(REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: rt }).toString(),
        });
      } catch (_) { /* best effort; the local copy is already gone */ }
    }
  }

  // --------------------------------------------------------------- tokens --
  async function getAccessToken() {
    if (access && access.expiresAt - 60000 > Date.now()) return access.token;
    if (!refreshToken || !client) throw fail('not_signed_in', 'Sign in with Google first (Settings → Google account).');
    if (!refreshing) {
      refreshing = (async () => {
        const r = await request(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: client.id,
            client_secret: client.secret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
          }).toString(),
        });
        if (r.status === 400 && r.json && r.json.error === 'invalid_grant') {
          clearLocal();
          throw fail('not_signed_in', 'Your Google sign-in expired. Please sign in again.');
        }
        if (r.status !== 200 || !r.json || !r.json.access_token) {
          throw fail('api', 'Could not refresh the Google sign-in. Check your connection.');
        }
        access = { token: r.json.access_token, expiresAt: Date.now() + (r.json.expires_in || 3600) * 1000 };
        return access.token;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // ------------------------------------------------------------------ API --
  async function api(endpoint, params) {
    const qs = new URLSearchParams(params).toString();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getAccessToken();
      const r = await request(`${API}/${endpoint}?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (r.status === 401 && attempt === 0) { access = null; continue; }
      if (r.status === 200 && r.json) return r.json;
      throw describeApiError(r);
    }
    throw fail('api', 'YouTube API error.');
  }

  async function channelInfo() {
    if (channel) return channel;
    const j = await api('channels', { part: 'snippet,contentDetails', mine: 'true' });
    const it = (j.items || [])[0];
    channel = {
      title: (it && it.snippet && it.snippet.title) || 'Google account',
      likesId: (it && it.contentDetails && it.contentDetails.relatedPlaylists && it.contentDetails.relatedPlaylists.likes) || null,
    };
    return channel;
  }

  /** The user's own playlists (public + unlisted + private), plus "Liked videos". */
  async function listPlaylists() {
    const info = await channelInfo();
    const out = [];
    if (info.likesId) out.push({ id: info.likesId, title: 'Liked videos', privacy: 'private', count: null });
    let pageToken = '';
    do {
      const j = await api('playlists', {
        part: 'snippet,contentDetails,status', mine: 'true', maxResults: '50', ...(pageToken ? { pageToken } : {}),
      });
      for (const it of j.items || []) {
        out.push({
          id: it.id,
          title: (it.snippet && it.snippet.title) || 'Untitled',
          privacy: (it.status && it.status.privacyStatus) || '',
          count: it.contentDetails && typeof it.contentDetails.itemCount === 'number' ? it.contentDetails.itemCount : null,
        });
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken && out.length < 500);
    return out;
  }

  /**
   * One playlist, shaped like yt-dlp's `--flat-playlist -J` output so the downloader's
   * existing playlist loop can use it unchanged.
   */
  async function getPlaylist(listId) {
    if (listId === 'WL') {
      throw fail('api', "YouTube doesn't let apps read \"Watch later\". Add those videos to a normal playlist first.");
    }
    const info = await channelInfo();
    const id = listId === 'LL' ? info.likesId : listId;
    if (!id) throw fail('api', "Couldn't find your Liked videos playlist.");

    let title = id === info.likesId ? 'Liked videos' : 'YouTube Playlist';
    if (id !== info.likesId) {
      const p = await api('playlists', { part: 'snippet', id });
      const it = (p.items || [])[0];
      if (it && it.snippet && it.snippet.title) title = it.snippet.title;
    }

    const entries = [];
    let pageToken = '';
    do {
      const j = await api('playlistItems', {
        part: 'snippet', playlistId: id, maxResults: '50', ...(pageToken ? { pageToken } : {}),
      });
      for (const it of j.items || []) {
        const sn = it.snippet || {};
        const vid = sn.resourceId && sn.resourceId.videoId;
        // Removed / private videos are listed with these placeholder titles; nothing to download.
        if (!vid || sn.title === 'Private video' || sn.title === 'Deleted video') continue;
        entries.push({ id: vid, title: sn.title || vid, uploader: sn.videoOwnerChannelTitle || '' });
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken && entries.length < MAX_PLAYLIST_ITEMS);

    return { _type: 'playlist', id, title, entries };
  }

  // --------------------------------------------------------------- config --
  function setClient({ clientId, clientSecret } = {}) {
    const id = String(clientId || '').trim();
    const secret = String(clientSecret || '').trim();
    if (!ID_RE.test(id)) {
      throw new Error('That does not look like a Google client ID (it ends in .apps.googleusercontent.com).');
    }
    if (secret.length < 8 || /\s/.test(secret)) throw new Error('That does not look like a client secret.');
    fs.writeFileSync(clientFile, JSON.stringify({ clientId: id, clientSecret: secret }), { mode: 0o600 });
    if (!client || client.id !== id) clearLocal(); // tokens belong to the old client
    client = { id, secret };
    lastError = '';
  }

  async function status() {
    if (refreshToken && !channel) {
      try { await channelInfo(); } catch (err) { if (err.code !== 'not_signed_in') log('Google account lookup:', err.message); }
    }
    return {
      configured: !!client,
      signedIn: !!refreshToken,
      pending: !!pending,
      persisted,
      account: channel ? channel.title : null,
      error: lastError || null,
    };
  }

  return {
    beginLogin,
    handleCallback,
    signOut,
    setClient,
    status,
    listPlaylists,
    getPlaylist,
    isSignedIn: () => !!refreshToken,
  };
}

module.exports = { createGoogleAuth };
