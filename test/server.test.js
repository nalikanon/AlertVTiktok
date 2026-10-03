import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalVideoUrl,
  createGoogleAuthorizationUrl,
  createRawGmailMessage,
  normalizeVideoUrl,
  parseViewCount,
  revokeGoogleAuthorization,
  resolvePollIntervalSeconds,
  sendGmailMessage
} from '../server.js';

test('extracts TikTok view counts from public video data', () => {
  assert.equal(parseViewCount('<script>{"playCount":1234567}</script>'), 1234567);
  assert.equal(parseViewCount('<script>{"play_count":"12,345"}</script>'), 12345);
});

test('rejects pages without a public view count', () => {
  assert.throws(() => parseViewCount('<html>video unavailable</html>'), /ไม่เปิดเผยยอดวิว/);
});

test('defaults view polling to 30 seconds and accepts second-based overrides', () => {
  assert.equal(resolvePollIntervalSeconds(undefined), 30);
  assert.equal(resolvePollIntervalSeconds('300'), 300);
  assert.equal(resolvePollIntervalSeconds('10'), 30);
});

test('accepts TikTok video and short-link hosts', () => {
  assert.equal(normalizeVideoUrl('https://vm.tiktok.com/abc/'), 'https://vm.tiktok.com/abc/');
  assert.match(normalizeVideoUrl('https://www.tiktok.com/@creator/video/123'), /@creator\/video\/123/);
});

test('rejects links outside TikTok', () => {
  assert.throws(() => normalizeVideoUrl('https://example.com/video/123'), /tiktok.com/);
  assert.throws(() => normalizeVideoUrl('not a URL'), /ลิงก์ TikTok/);
});

test('canonicalizes short-link redirects to the real video URL', () => {
  assert.equal(
    canonicalVideoUrl('https://vm.tiktok.com/abc/', 'https://www.tiktok.com/@creator/video/123?lang=en'),
    'https://www.tiktok.com/@creator/video/123'
  );
  assert.throws(() => canonicalVideoUrl('https://vm.tiktok.com/abc/', 'https://www.tiktok.com/'), /ไม่มีรหัสวิดีโอ/);
});

test('creates a Google OAuth URL with Gmail send permission and CSRF state', () => {
  const url = new URL(createGoogleAuthorizationUrl({
    clientId: 'client-id',
    state: 'random-state',
    redirectUri: 'http://localhost:3000/auth/google/callback'
  }));
  assert.equal(url.hostname, 'accounts.google.com');
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /gmail\.send/);
});

test('encodes Gmail API messages as base64url MIME', () => {
  const raw = createRawGmailMessage({
    from: 'apisityambangyang@gmail.com',
    to: 'apisityambangyang@gmail.com',
    subject: 'ถึงเป้าหมายแล้ว',
    text: 'ยอดวิวถึงเป้า'
  });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /From: apisityambangyang@gmail\.com/);
  assert.match(decoded, /To: apisityambangyang@gmail\.com/);
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/);
  assert.match(decoded, /Content-Transfer-Encoding: base64/);
  assert.ok(decoded.includes(Buffer.from('ยอดวิวถึงเป้า').toString('base64')));
});

test('refreshes a Google OAuth token and sends through the Gmail API', async () => {
  const requests = [];
  await sendGmailMessage({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    from: 'apisityambangyang@gmail.com',
    to: 'apisityambangyang@gmail.com',
    subject: 'Test',
    text: 'Body'
  }, async (url, options) => {
    requests.push({ url, options });
    return requests.length === 1 ? {
      ok: true,
      json: async () => ({ access_token: 'access-token' })
    } : { ok: true };
  });

  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(requests[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(requests[1].options.headers.authorization, 'Bearer access-token');
  assert.ok(JSON.parse(requests[1].options.body).raw);
});

test('reports Google OAuth token errors without contacting Google', async () => {
  await assert.rejects(
    sendGmailMessage({ clientId: 'id', clientSecret: 'secret', refreshToken: 'revoked' }, async () => ({
      ok: false,
      json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    })),
    /Token has been expired or revoked/
  );
});

test('revokes the old Google refresh token before a fresh authorization', async () => {
  let request;
  await revokeGoogleAuthorization('old-refresh-token', async (url, options) => {
    request = { url, options };
    return { ok: true };
  });
  assert.equal(request.url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(new URLSearchParams(request.options.body).get('token'), 'old-refresh-token');
});

test('explains how to fix Gmail insufficient-scope errors', async () => {
  await assert.rejects(
    sendGmailMessage({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'token',
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test',
      text: 'Body'
    }, async (_url, options) => {
      if (options.body instanceof URLSearchParams) return { ok: true, json: async () => ({ access_token: 'access' }) };
      return {
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Request had insufficient authentication scopes.' } })
      };
    }),
    /รีเซ็ตสิทธิ์ Google/
  );
});