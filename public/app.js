const numberFormat = new Intl.NumberFormat('th-TH');
const listElement = document.querySelector('#video-list');
const emptyState = document.querySelector('#empty-state');
const addForm = document.querySelector('#add-form');
const settingsForm = document.querySelector('#settings-form');
let videos = [];
let toastTimer;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'มีบางอย่างผิดพลาด');
  return body;
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function renderVideos() {
  const activeCount = videos.filter(video => video.active).length;
  const totalViews = videos.reduce((sum, video) => sum + (video.currentViews || 0), 0);
  const sentCount = videos.filter(video => video.alertSentAt).length;
  document.querySelector('#active-count').textContent = numberFormat.format(activeCount);
  document.querySelector('#views-total').textContent = numberFormat.format(totalViews);
  document.querySelector('#alerts-count').textContent = numberFormat.format(sentCount);
  document.querySelector('#list-count').textContent = String(videos.length).padStart(2, '0');
  emptyState.hidden = videos.length > 0;
  listElement.replaceChildren();

  for (const video of videos) {
    const progress = Math.min(100, Math.round(video.currentViews / video.targetViews * 100));
    const status = video.alertSentAt
      ? ['reached', 'ถึงเป้าหมายแล้ว']
      : video.active ? ['', 'กำลังติดตาม'] : ['paused', 'หยุดชั่วคราว'];
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><div class="video-cell"><span class="video-thumb">▶</span><div><span class="video-name"></span><a class="video-url" target="_blank" rel="noreferrer"></a>${video.lastError ? '<span class="video-url error"></span>' : ''}</div></div></td>
      <td><span class="count">${numberFormat.format(video.currentViews || 0)}</span></td>
      <td><span class="target-count">${numberFormat.format(video.targetViews)}</span></td>
      <td class="progress-cell"><div class="progress-line"><span style="width:${progress}%"></span></div><div class="progress-percent">${progress}%</div></td>
      <td><span class="status-pill ${status[0]}">${status[1]}</span></td>
      <td><div class="row-actions"><button class="icon-button toggle-button" type="button" aria-label="${video.active ? 'หยุด' : 'เริ่ม'}ติดตาม" title="${video.active ? 'หยุดติดตามชั่วคราว' : 'เริ่มติดตาม'}">${video.active ? 'Ⅱ' : '▶'}</button><button class="icon-button delete-button" type="button" aria-label="ลบรายการ" title="ลบรายการ">×</button></div></td>`;
    row.querySelector('.video-name').textContent = video.title || 'วิดีโอ TikTok';
    const link = row.querySelector('.video-url');
    link.href = video.url;
    link.textContent = new URL(video.url).pathname;
    if (video.lastError) {
      const error = row.querySelector('.error');
      error.textContent = video.lastError;
      error.style.color = '#bd604f';
    }
    row.querySelector('.toggle-button').addEventListener('click', async () => {
      try {
        await api(`/api/videos/${video.id}`, { method: 'PATCH', body: JSON.stringify({ active: !video.active }) });
        await loadVideos();
      } catch (error) { showToast(error.message); }
    });
    row.querySelector('.delete-button').addEventListener('click', async () => {
      try {
        await api(`/api/videos/${video.id}`, { method: 'DELETE' });
        await loadVideos();
        showToast('ลบรายการแล้ว');
      } catch (error) { showToast(error.message); }
    });
    listElement.append(row);
  }
}

async function loadVideos() {
  videos = await api('/api/videos');
  renderVideos();
  document.querySelector('#last-refresh').textContent = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
}

async function loadSettings() {
  const status = await api('/api/status');
  const pollSeconds = status.pollIntervalSeconds;
  const pollFrequency = pollSeconds % 60 === 0 ? `${pollSeconds / 60} นาที` : `${pollSeconds} วินาที`;
  document.querySelector('#poll-interval-label').textContent = `ตรวจยอดทุก ${pollFrequency}`;
  const dot = document.querySelector('#connection-dot');
  dot.classList.toggle('ready', status.settings.hasOAuthToken);
  dot.classList.toggle('offline', !status.settings.hasOAuthToken);
  document.querySelector('#connection-label').textContent = status.settings.hasOAuthToken
    ? `เชื่อมต่อ ${status.settings.connectedEmail}`
    : 'เชื่อมต่อ Google เพื่อเริ่มใช้งาน';
  document.querySelector('#connect-google').textContent = status.settings.hasOAuthToken ? 'ขอสิทธิ์ Google ใหม่' : 'เชื่อมต่อ Google';
  document.querySelector('#reset-google').hidden = !status.settings.hasOAuthToken;
  document.querySelector('#recipient-label').textContent = `ALERTS → ${status.recipient}`;
  if (status.settings.clientId) settingsForm.elements.clientId.value = status.settings.clientId;
  document.querySelector('#client-secret-hint').textContent = status.settings.hasClientSecret
    ? 'บันทึก Client Secret แล้ว · เว้นว่างเพื่อใช้ค่าเดิม'
    : 'สร้าง Web application credentials';
}

addForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = addForm.querySelector('button[type="submit"]');
  const message = document.querySelector('#form-message');
  button.disabled = true;
  button.querySelector('span').textContent = 'กำลังตรวจสอบลิงก์';
  message.textContent = '';
  try {
    const formData = new FormData(addForm);
    await api('/api/videos', { method: 'POST', body: JSON.stringify({ url: formData.get('url'), targetViews: formData.get('targetViews') }) });
    addForm.reset();
    await loadVideos();
    if (videos.some(video => video.currentViews >= video.targetViews && !video.alertSentAt)) {
      showToast('เพิ่มรายการแล้ว ระบบจะส่งอีเมลเมื่อเชื่อมต่อ Gmail แล้ว');
    } else showToast('เริ่มติดตามวิดีโอแล้ว');
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'เริ่มติดตาม';
  }
});

const modal = document.querySelector('#settings-modal');
function openSettings() { modal.hidden = false; }
document.querySelector('#settings-open').addEventListener('click', openSettings);
document.querySelector('#settings-shortcut').addEventListener('click', openSettings);
document.querySelector('#settings-close').addEventListener('click', () => { modal.hidden = true; });
modal.addEventListener('click', event => { if (event.target === modal) modal.hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') modal.hidden = true; });

settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#settings-message');
  const submit = settingsForm.querySelector('.save-button');
  submit.disabled = true;
  message.textContent = '';
  try {
    const data = Object.fromEntries(new FormData(settingsForm));
    const settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(data) });
    settingsForm.elements.clientSecret.value = '';
    document.querySelector('#client-secret-hint').textContent = 'บันทึก Client Secret แล้ว · เว้นว่างเพื่อใช้ค่าเดิม';
    await loadSettings();
    message.textContent = settings.hasOAuthToken ? '' : 'บันทึกแล้ว กด “เชื่อมต่อ Google” เพื่ออนุญาตการส่งอีเมล';
    showToast('บันทึกค่า OAuth แล้ว');
  } catch (error) { message.textContent = error.message; }
  finally { submit.disabled = false; }
});

document.querySelector('#connect-google').addEventListener('click', async event => {
  const button = event.currentTarget;
  const message = document.querySelector('#settings-message');
  button.disabled = true;
  message.textContent = '';
  try {
    const result = await api('/api/settings/oauth/start', { method: 'POST' });
    window.location.assign(result.authorizationUrl);
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});

document.querySelector('#reset-google').addEventListener('click', async event => {
  const button = event.currentTarget;
  const message = document.querySelector('#settings-message');
  button.disabled = true;
  message.textContent = 'กำลังถอนสิทธิ์เดิมจาก Google...';
  try {
    await api('/api/settings/oauth/reset', { method: 'POST' });
    await loadSettings();
    message.textContent = 'ถอนสิทธิ์เดิมแล้ว กด “เชื่อมต่อ Google” เพื่ออนุญาต gmail.send ใหม่';
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector('#test-email').addEventListener('click', async () => {
  const message = document.querySelector('#settings-message');
  message.style.color = '#778071';
  message.textContent = 'กำลังตรวจสอบ OAuth2 และส่งอีเมลทดสอบ...';
  try {
    const result = await api('/api/settings/test', { method: 'POST' });
    message.textContent = result.message;
    showToast(result.message);
  } catch (error) { message.textContent = error.message; }
  finally { message.style.color = ''; }
});

document.querySelector('#refresh-button').addEventListener('click', async () => {
  try { await loadVideos(); showToast('อัปเดตรายการแล้ว'); }
  catch (error) { showToast(error.message); }
});

await Promise.all([loadVideos(), loadSettings()]);
const oauthResult = new URLSearchParams(location.search);
if (oauthResult.has('oauth')) {
  if (oauthResult.get('oauth') === 'connected') {
    await loadSettings();
    showToast('เชื่อมต่อ Gmail สำเร็จ');
  } else {
    const reasons = {
      wrong_google_account: 'เลือกบัญชี Google apisityambangyang@gmail.com เพื่อให้ตรงกับผู้รับแจ้งเตือน',
      google_account_unverified: 'บัญชี Google ยังไม่ได้ยืนยันอีเมล',
      gmail_scope_missing: 'สิทธิ์ gmail.send ไม่ได้ถูกอนุญาต ตรวจ Data Access แล้วเชื่อม Google ใหม่',
      authorization_denied: 'ยังไม่ได้อนุญาตสิทธิ์ Gmail',
      invalid_state: 'ลิงก์อนุญาตหมดอายุ กรุณาเริ่มเชื่อมต่อใหม่',
      authorization_failed: 'เชื่อมต่อ Google ไม่สำเร็จ ตรวจค่า OAuth client และ Redirect URI'
    };
    showToast(reasons[oauthResult.get('reason')] || 'เชื่อมต่อ Google ไม่สำเร็จ');
  }
  history.replaceState({}, document.title, location.pathname);
}
setInterval(() => void Promise.all([loadVideos(), loadSettings()]).catch(() => {}), 30000);