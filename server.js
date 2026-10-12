import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = path.join(root, 'data');
const storePath = path.join(dataDirectory, 'store.json');
const recipient = 'apisityambangyang@gmail.com';
const app = express();
const port = Number(process.env.PORT) || 3000;
export function resolvePollIntervalSeconds(value = process.env.POLL_INTERVAL_SECONDS) {
  return Math.max(30, Number(value) || 30);
}
const pollIntervalMs = resolvePollIntervalSeconds() * 1000;
 
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(root, 'public')));

let store = { videos: [], settings: {} };
let isPolling = false;
const pendingOAuthStates = new Map();
const oauthRedirectUri = `http://localhost:${port}/auth/google/callback`;

export function parseViewCount(html) {
  const match = html.match(/["']?(?:playCount|play_count)["']?\s*:\s*["']?([\d,]+)/i);
  if (!match) throw new Error('TikTok ไม่เปิดเผยยอดวิวของวิดีโอนี้');
  return Number(match[1].replaceAll(',', ''));
}

export function normalizeVideoUrl(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('กรุณาใส่ลิงก์ TikTok ที่ถูกต้อง');
  }

  if (!['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'].includes(url.hostname.toLowerCase())) {
    throw new Error('ลิงก์ต้องมาจาก tiktok.com');
  }

  return url.toString();
}

export function canonicalVideoUrl(inputUrl, resolvedUrl) {
  const videoPath = new URL(resolvedUrl).pathname.match(/\/@[^/]+\/video\/\d+/i)?.[0]
    || new URL(inputUrl).pathname.match(/\/@[^/]+\/video\/\d+/i)?.[0];
  if (!videoPath) throw new Error('ลิงก์นี้ไม่มีรหัสวิดีโอ TikTok ที่รองรับ');
  return new URL(videoPath, 'https://www.tiktok.com').toString();
}

async function saveStore() {
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), 'utf8');
}

async function loadStore() {
  try {
    store = JSON.parse(await fs.readFile(storePath, 'utf8'));
    store.videos ??= [];
    store.settings ??= {};
    const obsoleteKeys = ['host', 'port', 'user', 'password', 'apiKey', 'from'];
    if (obsoleteKeys.some(key => Object.hasOwn(store.settings, key))) {
      const { clientId, clientSecret, refreshToken, connectedEmail } = store.settings;
      store.settings = { clientId, clientSecret, refreshToken, connectedEmail };
      await saveStore();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveStore();
  }
}

function publicSettings(settings = store.settings) {
  return {
    clientId: settings.clientId || '',
    hasClientSecret: Boolean(settings.clientSecret),
    hasOAuthToken: Boolean(settings.refreshToken),
    connectedEmail: settings.connectedEmail || '',
    recipient
  };
}

async function fetchVideoDetails(inputUrl) {
  const response = await fetch(inputUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`TikTok ตอบกลับ ${response.status}`);

  const html = await response.text();
  const count = parseViewCount(html);

  return {
    count,
    url: canonicalVideoUrl(inputUrl, response.url),
    title: html.match(/<title>(.*?)<\/title>/is)?.[1]?.replace(/\s*\|\s*TikTok\s*$/i, '').trim() || 'วิดีโอ TikTok'
  };
}

export function createGoogleAuthorizationUrl({ clientId, state, redirectUri }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email https://www.googleapis.com/auth/gmail.send',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    login_hint: recipient
  }).toString();
  return url.toString();
}

export function createRawGmailMessage({ from, to, subject, text }) {
  const encodedBody = Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
  const mimeMessage = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodedBody
  ].join('\r\n');
  return Buffer.from(mimeMessage, 'utf8').toString('base64url');
}

export async function revokeGoogleAuthorization(refreshToken, fetchImpl = fetch) {
  if (!refreshToken) return;
  const response = await fetchImpl('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken })
  });
  if (!response.ok && response.status !== 400) throw new Error(`Google ปฏิเสธการถอน token (${response.status})`);
}

export async function getGoogleAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl = fetch) {
  if (!clientId || !clientSecret || !refreshToken) throw new Error('เชื่อมต่อบัญชี Google OAuth2 ก่อนส่งอีเมล');
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const result = await response.json();
  if (!response.ok || !result.access_token) {
    throw new Error(result.error_description || result.error || 'Google OAuth2 ไม่สามารถต่ออายุ access token ได้');
  }
  return result.access_token;
}

export async function sendGmailMessage({ clientId, clientSecret, refreshToken, from, to, subject, text }, fetchImpl = fetch) {
  const accessToken = await getGoogleAccessToken({ clientId, clientSecret, refreshToken }, fetchImpl);
  const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: createRawGmailMessage({ from, to, subject, text }) })
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).error?.message || ''; } catch {}
    if (response.status === 403 && /insufficient authentication scopes/i.test(detail)) {
      throw new Error('Google token ไม่มีสิทธิ์ gmail.send กรุณาเพิ่ม scope ใน Google Cloud แล้วกด “รีเซ็ตสิทธิ์ Google” และเชื่อมบัญชีใหม่');
    }
    throw new Error(`Gmail API (${response.status}): ${detail || 'ส่งอีเมลไม่สำเร็จ ตรวจสิทธิ์ Gmail API'}`);
  }
}

async function sendThresholdAlert(video) {
  await sendGmailMessage({
    ...store.settings,
    from: store.settings.connectedEmail,
    to: recipient,
    subject: `TikTok ถึงเป้าหมายแล้ว: ${video.title}`,
    text: [
      'วิดีโอ TikTok ถึงยอดวิวที่ตั้งไว้แล้ว',
      `วิดีโอ: ${video.title}`,
      `ยอดปัจจุบัน: ${video.currentViews.toLocaleString('th-TH')} วิว`,
      `เป้าหมาย: ${video.targetViews.toLocaleString('th-TH')} วิว`,
      `ลิงก์: ${video.url}`
    ].join('\n')
  });
}

async function pollVideos() {
  if (isPolling) return;
  isPolling = true;
  try {
    for (const video of store.videos.filter(item => item.active && !item.alertSentAt)) {
      try {
        const details = await fetchVideoDetails(video.url);
        video.currentViews = details.count;
        video.title = details.title;
        video.lastCheckedAt = new Date().toISOString();
        video.lastError = '';
        if (video.currentViews >= video.targetViews) {
          await sendThresholdAlert(video);
          video.alertSentAt = new Date().toISOString();
          video.active = false;
        }
      } catch (error) {
        video.lastCheckedAt = new Date().toISOString();
        video.lastError = error.message;
      }
      await saveStore();
    }
  } finally {
    isPolling = false;
  }
}

app.get('/api/status', (_request, response) => {
  response.json({ recipient, pollIntervalSeconds: pollIntervalMs / 1000, settings: publicSettings() });
});

app.put('/api/settings', async (request, response) => {
  const clientId = String(request.body.clientId || store.settings.clientId || '').trim();
  const clientSecret = String(request.body.clientSecret || store.settings.clientSecret || '').trim();
  if (!clientId || !clientSecret) return response.status(400).json({ error: 'กรอก Google OAuth Client ID และ Client Secret ให้ครบ' });
  const credentialsChanged = clientId !== store.settings.clientId || clientSecret !== store.settings.clientSecret;
  store.settings = {
    clientId,
    clientSecret,
    refreshToken: credentialsChanged ? '' : store.settings.refreshToken || '',
    connectedEmail: credentialsChanged ? '' : store.settings.connectedEmail || ''
  };
  await saveStore();
  return response.json(publicSettings());
});

app.post('/api/settings/oauth/start', (_request, response) => {
  const { clientId } = store.settings;
  if (!clientId || !store.settings.clientSecret) {
    return response.status(400).json({ error: 'บันทึก Google OAuth Client ID และ Client Secret ก่อน' });
  }
  for (const [state, expiresAt] of pendingOAuthStates) {
    if (expiresAt < Date.now()) pendingOAuthStates.delete(state);
  }
  const state = crypto.randomBytes(32).toString('hex');
  pendingOAuthStates.set(state, Date.now() + 5 * 60 * 1000);
  return response.json({ authorizationUrl: createGoogleAuthorizationUrl({ clientId, state, redirectUri: oauthRedirectUri }) });
});

app.post('/api/settings/oauth/reset', async (_request, response) => {
  try {
    await revokeGoogleAuthorization(store.settings.refreshToken);
    store.settings.refreshToken = '';
    store.settings.connectedEmail = '';
    await saveStore();
    return response.json({ settings: publicSettings() });
  } catch (error) {
    return response.status(502).json({ error: error.message });
  }
});

app.get('/auth/google/callback', async (request, response) => {
  const { code, state, error } = request.query;
  const expiresAt = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  if (!code || !state || !expiresAt || expiresAt < Date.now()) return response.redirect('/?oauth=error&reason=invalid_state');
  if (error) return response.redirect('/?oauth=error&reason=authorization_denied');

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: store.settings.clientId,
        client_secret: store.settings.clientSecret,
        code,
        redirect_uri: oauthRedirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.refresh_token) throw new Error('token_exchange_failed');
    if (tokens.scope && !tokens.scope.split(' ').includes('https://www.googleapis.com/auth/gmail.send')) {
      throw new Error('gmail_scope_missing');
    }

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.email_verified) throw new Error('google_account_unverified');
    if (profile.email.toLowerCase() !== recipient.toLowerCase()) throw new Error('wrong_google_account');

    store.settings.refreshToken = tokens.refresh_token;
    store.settings.connectedEmail = profile.email;
    await saveStore();
    return response.redirect('/?oauth=connected');
  } catch (callbackError) {
    const reason = ['wrong_google_account', 'google_account_unverified', 'gmail_scope_missing'].includes(callbackError.message)
      ? callbackError.message
      : 'authorization_failed';
    return response.redirect(`/?oauth=error&reason=${reason}`);
  }
});

app.get('/api/videos', (_request, response) => response.json(store.videos));

app.post('/api/videos', async (request, response) => {
  try {
    const url = normalizeVideoUrl(String(request.body.url || ''));
    const targetViews = Number(request.body.targetViews);
    if (!Number.isSafeInteger(targetViews) || targetViews < 1) {
      return response.status(400).json({ error: 'ยอดเป้าหมายต้องเป็นจำนวนเต็มที่มากกว่า 0' });
    }
    const details = await fetchVideoDetails(url);
    const video = {
      id: crypto.randomUUID(),
      url: details.url,
      title: details.title,
      targetViews,
      currentViews: details.count,
      active: true,
      alertSentAt: '',
      lastCheckedAt: new Date().toISOString(),
      lastError: ''
    };
    store.videos.unshift(video);
    await saveStore();
    if (video.currentViews >= video.targetViews) void pollVideos();
    return response.status(201).json(video);
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

app.patch('/api/videos/:id', async (request, response) => {
  const video = store.videos.find(item => item.id === request.params.id);
  if (!video) return response.status(404).json({ error: 'ไม่พบวิดีโอนี้' });
  if (typeof request.body.active === 'boolean') video.active = request.body.active;
  if (request.body.targetViews !== undefined) {
    const targetViews = Number(request.body.targetViews);
    if (!Number.isSafeInteger(targetViews) || targetViews < 1) {
      return response.status(400).json({ error: 'ยอดเป้าหมายต้องเป็นจำนวนเต็มที่มากกว่า 0' });
    }
    video.targetViews = targetViews;
    video.alertSentAt = '';
  }
  await saveStore();
  return response.json(video);
});

app.delete('/api/videos/:id', async (request, response) => {
  const existingCount = store.videos.length;
  store.videos = store.videos.filter(item => item.id !== request.params.id);
  if (store.videos.length === existingCount) return response.status(404).json({ error: 'ไม่พบวิดีโอนี้' });
  await saveStore();
  return response.status(204).end();
});

app.post('/api/settings/test', async (_request, response) => {
  try {
    await sendGmailMessage({
      ...store.settings,
      from: store.settings.connectedEmail,
      to: recipient,
      subject: 'ทดสอบการแจ้งเตือน TikTok View Alert',
      text: 'การตั้งค่าอีเมลแจ้งเตือนใช้งานได้แล้ว'
    });
    return response.json({ message: `ส่งอีเมลทดสอบไปยัง ${recipient} แล้ว` });
  } catch (error) {
    return response.status(400).json({ error: error.message });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await loadStore();
  app.listen(port, '127.0.0.1', () => {
    console.log(`TikTok View Alert พร้อมใช้งานที่ http://localhost:${port}`);
    console.log(`ตรวจสอบยอดทุก ${pollIntervalMs / 1000} วินาที`);
  });
  setInterval(() => void pollVideos(), pollIntervalMs).unref();
}