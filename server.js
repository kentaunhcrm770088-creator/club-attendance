// 部活出席管理 Webアプリ版サーバー
// 依存ライブラリなし（Node.js 標準機能のみ）。データは data.json に保存。
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = __dirname;
const PUBLIC_FILES = new Set(['index.html', 'manifest.json', 'sw.js']);

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { members: [], practices: [], responses: [], allocations: {}, sessions: {} };
  }
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
let data = loadData();
data.changeRequests = data.changeRequests || [];
data.changeLog = data.changeLog || [];
data.settings = data.settings || { gymDistances: {}, gasPrices: {} };

// 体育館ごとの往復距離プリセット（km、つくば⇔体育館の往復）。
// 練習の場所文字列にプリセット名が含まれていれば、その距離を初期値として使う。
// 幹部が距離を保存した体育館については、保存した値が優先される。
const GYM_DISTANCE_PRESETS = { '北条': 25, '豊里': 17, '桜': 8, '洞峰': 9, 'カピオ': 5, '谷田部': 18, '石岡': 54, '千葉大': 178, '自治': 80, '横須賀': 72, 'ふれあい': 42, '白子': 206, 'アダスト': 110, 'たつのこ': 42 };

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
// 幹部パスワードは全幹部で共通の1つ。ハッシュは settings に保存する（個人パスワードは使わない）。
function officerPasswordIsSet() { return !!data.settings.officerPassHash; }
function verifyOfficerPassword(password) {
  if (!officerPasswordIsSet()) return false;
  return hashPassword(password || '', data.settings.officerSalt) === data.settings.officerPassHash;
}
function setOfficerPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  data.settings.officerSalt = salt;
  data.settings.officerPassHash = hashPassword(password, salt);
}
// 設定のうちクライアントに返してよい部分だけ（幹部パスワードのハッシュは返さない）
function publicSettings() {
  return { gymDistances: data.settings.gymDistances || {}, gasPrices: data.settings.gasPrices || {} };
}

// --- gogo.gs からのガソリン価格自動取得 ---
// 茨城県（pref=8）の価格推移ページには、チャート用JSONが
// x-init="createChart(..., JSON.parse('...'))" の形で埋め込まれている。
// mode=0 がレギュラー、mode=1 がハイオク。データセット「現金価格（茨城県平均）」の最新値を取る。
function fetchText(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Accept-Language': 'ja' } }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirects > 0) {
        resp.resume();
        fetchText(new URL(resp.headers.location, url).toString(), redirects - 1).then(resolve, reject);
        return;
      }
      if (resp.statusCode !== 200) { resp.resume(); reject(new Error('HTTP ' + resp.statusCode)); return; }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      resp.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
function extractGogoIbarakiPrice(html) {
  const key = "JSON.parse('";
  const i = html.indexOf(key);
  if (i < 0) return null;
  let j = i + key.length, raw = '';
  while (j < html.length) {
    const c = html[j];
    if (c === '\\') { raw += c + (html[j + 1] || ''); j += 2; continue; }
    if (c === "'") break;
    raw += c; j++;
  }
  let cfg;
  try {
    const decoded = raw.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
    cfg = JSON.parse(decoded);
  } catch { return null; }
  const labels = cfg && cfg.data && cfg.data.labels;
  const datasets = (cfg && cfg.data && cfg.data.datasets) || [];
  if (!Array.isArray(labels) || !labels.length) return null;
  const ds = datasets.find((d) => (d.label || '').includes('茨城県平均')) || datasets[0];
  if (!ds || !ds.data) return null;
  const lastLabel = labels[labels.length - 1];
  const v = ds.data[lastLabel];
  if (typeof v !== 'number') return null;
  return { price: v, date: lastLabel };
}
function newId() { return crypto.randomUUID(); }
function todayJST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req, max = 1e6) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
const tmpImages = new Map();
function authMember(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const mid = data.sessions[token];
  return data.members.find((m) => m.id === mid) || null;
}
function academicYear(d = new Date()) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(d);
  const [y, mo] = s.split('-').map(Number);
  return mo >= 4 ? y : y - 1;
}
function effectiveGrade(m) {
  if (!m.grade) return '';
  const base = m.gradeBase != null ? m.gradeBase : (parseInt(m.grade) || 0);
  if (!base) return m.grade;
  const gy = m.gradeYear != null ? m.gradeYear : academicYear();
  return Math.min(6, Math.max(1, base + (academicYear() - gy))) + '年';
}
function publicMember(m) { return { id: m.id, name: m.name, surname: m.surname || null, givenName: m.givenName || null, role: m.role, grade: effectiveGrade(m) }; }
function monthKeyJST(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit' }).format(new Date(iso));
}
function changesThisMonth(memberId) {
  const mk = monthKeyJST(new Date().toISOString());
  return data.changeLog.filter((c) => c.memberId === memberId && monthKeyJST(c.at) === mk).length;
}

// --- Web Push（通知） ---
const https = require('https');
data.pushSubs = data.pushSubs || {};
data.reminded = data.reminded || {};
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uDecode = (s) => Buffer.from(s, 'base64url');
function ensureVapid() {
  if (data.vapid && data.vapid.jwk) return data.vapid;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([0x04]), b64uDecode(jwk.x), b64uDecode(jwk.y)]);
  data.vapid = { pub: b64u(raw), jwk };
  saveData(data);
  return data.vapid;
}
function vapidJwt(audience) {
  const v = ensureVapid();
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:club@example.com' }));
  const key = crypto.createPrivateKey({ key: v.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64u(sig)}`;
}
function encryptPushPayload(uaPubB64, authB64, payloadStr) {
  const uaPub = b64uDecode(uaPubB64);
  const authSecret = b64uDecode(authB64);
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ephJwk = eph.publicKey.export({ format: 'jwk' });
  const asPub = Buffer.concat([Buffer.from([0x04]), b64uDecode(ephJwk.x), b64uDecode(ephJwk.y)]);
  const uaKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(uaPub.subarray(1, 33)), y: b64u(uaPub.subarray(33, 65)) }, format: 'jwk' });
  const secret = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: uaKey });
  const salt = crypto.randomBytes(16);
  const hmac = (key, d) => crypto.createHmac('sha256', key).update(d).digest();
  const ikm = hmac(hmac(authSecret, secret), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub, Buffer.from([0x01])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const plain = Buffer.concat([Buffer.from(payloadStr), Buffer.from([0x02])]);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
function sendOnePush(sub, payloadObj) {
  return new Promise((resolve) => {
    try {
      const endpoint = new URL(sub.endpoint);
      const body = encryptPushPayload(sub.keys.p256dh, sub.keys.auth, JSON.stringify(payloadObj));
      const jwt = vapidJwt(endpoint.origin);
      const req = https.request({
        method: 'POST', hostname: endpoint.hostname, path: endpoint.pathname + endpoint.search,
        headers: {
          'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm',
          'Content-Length': body.length, TTL: '86400',
          Authorization: `vapid t=${jwt}, k=${ensureVapid().pub}`,
        },
      }, (resp) => { resp.resume(); resp.on('end', () => resolve(resp.statusCode)); });
      req.on('error', () => resolve(0));
      req.end(body);
    } catch { resolve(0); }
  });
}
async function notifyMembers(memberIds, payload) {
  const targets = [...new Set(memberIds)];
  let changed = false;
  for (const mid of targets) {
    const subs = data.pushSubs[mid] || [];
    for (const sub of subs.slice()) {
      const code = await sendOnePush(sub, payload);
      if (code === 404 || code === 410) { subs.splice(subs.indexOf(sub), 1); changed = true; }
    }
    if (!subs.length && data.pushSubs[mid]) { delete data.pushSubs[mid]; changed = true; }
  }
  if (changed) saveData(data);
}
const allMemberIdsExcept = (id) => data.members.filter((m) => m.id !== id).map((m) => m.id);
const officerIdsExcept = (id) => data.members.filter((m) => m.role === 'officer' && m.id !== id).map((m) => m.id);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    // --- 認証 ---
    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      const { password, role, grade } = b;
      let name = b.name || '';
      const surname = (b.surname || '').trim(), givenName = (b.givenName || '').trim();
      if (surname && givenName) name = surname + ' ' + givenName;
      const isOfficer = role === 'officer';
      if (!name) return sendJson(res, 400, { error: '名前が必要です' });
      if (isOfficer && (!password || password.length < 4)) return sendJson(res, 400, { error: '幹部は4文字以上のパスワードが必要です' });
      if (data.members.some((m) => m.name === name)) return sendJson(res, 400, { error: 'その名前は登録済みです' });
      if (isOfficer) {
        // 幹部パスワードは全幹部共通。未設定ならこの入力が初代の共通パスワードになる。
        // 設定済みなら一致しない限り幹部登録できない。
        if (officerPasswordIsSet()) {
          if (!verifyOfficerPassword(password)) return sendJson(res, 400, { error: '幹部パスワードが違います' });
        } else {
          setOfficerPassword(password);
        }
      }
      const member = { id: newId(), name, surname: surname || null, givenName: givenName || null, role: isOfficer ? 'officer' : 'member', grade: grade || '', gradeBase: parseInt(grade) || null, gradeYear: academicYear() };
      data.members.push(member);
      const token = crypto.randomBytes(24).toString('hex');
      data.sessions[token] = member.id;
      saveData(data);
      return sendJson(res, 200, { token, member: publicMember(member) });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const { password } = b;
      let name = b.name || '';
      if (b.surname && b.givenName) name = b.surname.trim() + ' ' + b.givenName.trim();
      const member = data.members.find((m) => m.name === name);
      if (!member) return sendJson(res, 401, { error: '名前かパスワードが違います' });
      // パスワードが必要なのは幹部だけ（全幹部共通のパスワードで判定）。部員は名前だけでログインできる
      if (member.role === 'officer') {
        if (!officerPasswordIsSet()) return sendJson(res, 401, { error: '幹部パスワードが未設定です。幹部に設定してもらってください' });
        if (!verifyOfficerPassword(password))
          return sendJson(res, 401, { error: '名前かパスワードが違います' });
      }
      const token = crypto.randomBytes(24).toString('hex');
      data.sessions[token] = member.id;
      saveData(data);
      return sendJson(res, 200, { token, member: publicMember(member) });
    }
    const me = authMember(req);
    if (!me) return sendJson(res, 401, { error: 'ログインが必要です' });

    if (p === '/api/me') return sendJson(res, 200, { member: { ...publicMember(me), changesThisMonth: changesThisMonth(me.id) } });
    if (p === '/api/settings' && req.method === 'GET') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '幹部だけが見られます' });
      return sendJson(res, 200, { settings: publicSettings(), presets: GYM_DISTANCE_PRESETS });
    }
    if (p === '/api/settings' && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '幹部だけが変更できます' });
      const b = await readBody(req);
      if (b.gymDistances) data.settings.gymDistances = b.gymDistances;
      if (b.gasPrices) data.settings.gasPrices = b.gasPrices;
      saveData(data);
      return sendJson(res, 200, { ok: true, settings: publicSettings() });
    }
    if (p === '/api/settings/officer-password' && req.method === 'POST') {
      // 幹部パスワード（全幹部共通）の変更。幹部ログイン済みの人だけが実行できる。
      if (me.role !== 'officer') return sendJson(res, 403, { error: '幹部パスワードの変更は幹部だけができます' });
      const b = await readBody(req);
      const newPassword = b.newPassword || '';
      if (newPassword.length < 4) return sendJson(res, 400, { error: '新しいパスワードは4文字以上にしてください' });
      // 設定済みの場合は現在のパスワード確認が必須。未設定なら設定として扱う。
      if (officerPasswordIsSet() && !verifyOfficerPassword(b.currentPassword))
        return sendJson(res, 400, { error: '現在のパスワードが違います' });
      setOfficerPassword(newPassword);
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }

    // --- ガソリン価格の自動取得（gogo.gs 茨城県平均、幹部専用） ---
    if (p === '/api/gas-prices' && req.method === 'GET') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '価格の自動取得は幹部だけができます' });
      try {
        const [regHtml, highHtml] = await Promise.all([
          fetchText('https://gogo.gs/chart/pref/8?mode=0&range=0'),
          fetchText('https://gogo.gs/chart/pref/8?mode=1&range=0'),
        ]);
        const reg = extractGogoIbarakiPrice(regHtml);
        const high = extractGogoIbarakiPrice(highHtml);
        if (!reg || !high) return sendJson(res, 502, { error: '価格データを取り出せませんでした' });
        return sendJson(res, 200, { regular: reg.price, high: high.price, date: reg.date, source: 'gogo.gs 茨城県平均（現金価格）' });
      } catch {
        return sendJson(res, 502, { error: 'ガソリン価格の自動取得に失敗しました' });
      }
    }

    // --- プッシュ通知の購読 ---
    if (p === '/api/push/key' && req.method === 'GET') return sendJson(res, 200, { publicKey: ensureVapid().pub });
    if (p === '/api/push/subscribe' && req.method === 'POST') {
      const b = await readBody(req);
      const sub = b.subscription;
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth)
        return sendJson(res, 400, { error: '購読情報が不正です' });
      const list = data.pushSubs[me.id] || (data.pushSubs[me.id] = []);
      if (!list.some((s) => s.endpoint === sub.endpoint)) list.push({ endpoint: sub.endpoint, keys: sub.keys });
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/push/unsubscribe' && req.method === 'POST') {
      const b = await readBody(req);
      if (data.pushSubs[me.id]) data.pushSubs[me.id] = data.pushSubs[me.id].filter((s) => s.endpoint !== b.endpoint);
      saveData(data);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const token = (req.headers.authorization || '').slice(7);
      delete data.sessions[token]; saveData(data);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/members') return sendJson(res, 200, { members: data.members.map((m) => me.role === 'officer' ? { ...publicMember(m), changesThisMonth: changesThisMonth(m.id), catalogFuel: m.catalogFuel ?? null, fuelType: m.fuelType === 'high' ? 'high' : 'regular' } : publicMember(m)) });
    if (p === '/api/members/fuel' && req.method === 'POST') {
      // カタログ燃費と燃料種別の入力は幹部だけが行う（部員から聞いて幹部が登録する）
      if (me.role !== 'officer') return sendJson(res, 403, { error: '燃費の変更は幹部だけができます' });
      const b = await readBody(req);
      const target = data.members.find((m) => m.id === b.memberId);
      if (!target) return sendJson(res, 404, { error: '部員が見つかりません' });
      // 先に全部検証してから反映する（検証エラー時に片方だけ保存されるのを防ぐ）
      let newFuel;
      if (b.catalogFuel === '' || b.catalogFuel == null) {
        newFuel = null;
      } else {
        const v = parseFloat(b.catalogFuel);
        if (!(v > 0 && v <= 100)) return sendJson(res, 400, { error: 'カタログ燃費は km/L で入力してください' });
        newFuel = v;
      }
      if (b.fuelType !== undefined && !['regular', 'high'].includes(b.fuelType))
        return sendJson(res, 400, { error: '燃料種別が不正です' });
      target.catalogFuel = newFuel;
      if (b.fuelType !== undefined) target.fuelType = b.fuelType;
      saveData(data);
      return sendJson(res, 200, { ok: true, memberId: target.id, catalogFuel: target.catalogFuel ?? null, fuelType: target.fuelType === 'high' ? 'high' : 'regular' });
    }
    if (p === '/api/members/grade' && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '学年の変更は幹部だけができます' });
      const b = await readBody(req);
      const target = data.members.find((m) => m.id === b.memberId);
      if (!target) return sendJson(res, 404, { error: '部員が見つかりません' });
      target.grade = b.grade || '';
      target.gradeBase = parseInt(b.grade) || null;
      target.gradeYear = academicYear();
      saveData(data);
      return sendJson(res, 200, { member: publicMember(target) });
    }
    if (p === '/api/members/role' && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '役割の変更は幹部だけができます' });
      const b = await readBody(req);
      const target = data.members.find((m) => m.id === b.memberId);
      if (!target) return sendJson(res, 404, { error: '部員が見つかりません' });
      const newRole = b.role === 'officer' ? 'officer' : 'member';
      // 幹部パスワードは全幹部共通なので、昇格時に個人パスワードの設定は不要。
      // 昇格した人は共通パスワードでログインできる。
      target.role = newRole;
      delete target.passHash;
      delete target.salt;
      saveData(data);
      return sendJson(res, 200, { member: publicMember(target) });
    }

    // --- 練習 ---
    if (p === '/api/practices' && req.method === 'GET') {
      return sendJson(res, 200, { practices: data.practices.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)) });
    }
    if (p === '/api/practices' && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '練習の登録は幹部だけができます' });
      const b = await readBody(req);
      if (!b.date || !b.place) return sendJson(res, 400, { error: '日付と場所が必要です' });
      const practice = { id: newId(), date: b.date, start: b.start || '', end: b.end || '', place: b.place, type: b.type || '通常練', deadline: b.deadline || '', note: b.note || '', createdBy: me.id };
      data.practices.push(practice); saveData(data);
      // 練習は1週間分まとめて連絡するため、登録ごとの通知は送らない
      return sendJson(res, 200, { practice });
    }

    if (p === '/api/notify-week' && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '通知は幹部だけができます' });
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
      const limit = new Date(Date.now() + 8 * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
      const ups = data.practices.filter((x) => x.date >= today && x.date <= limit)
        .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
      if (!ups.length) return sendJson(res, 400, { error: 'これから8日以内の練習がありません' });
      const body = ups.map((x) => `${x.date} ${x.place}（${x.type}）${x.deadline ? ' 期限：' + x.deadline : ''}`).join('\n');
      notifyMembers(allMemberIdsExcept(me.id), { title: '来週分の練習が登録されました', body }).catch(() => {});
      return sendJson(res, 200, { ok: true, count: ups.length });
    }

    const updateMatch = p.match(/^\/api\/practices\/([^/]+)\/update$/);
    if (updateMatch && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '練習の変更は幹部だけができます' });
      const practice = data.practices.find((x) => x.id === updateMatch[1]);
      if (!practice) return sendJson(res, 404, { error: '練習が見つかりません' });
      const b = await readBody(req);
      for (const k of ['date', 'start', 'end', 'place', 'type', 'deadline', 'note']) {
        if (b[k] !== undefined) practice[k] = b[k];
      }
      saveData(data);
      return sendJson(res, 200, { practice });
    }

    // --- 回答 ---
    if (p === '/api/responses' && req.method === 'POST') {
      const b = await readBody(req);
      const targetPractice = data.practices.find((x) => x.id === b.practiceId);
      if (!targetPractice) return sendJson(res, 400, { error: '練習が見つかりません' });
      if (me.role !== 'officer' && targetPractice.deadline && new Date() > new Date(targetPractice.deadline))
        return sendJson(res, 400, { error: '回答期限を過ぎています。変更リクエストを使ってください' });
      let transport = ['driver', 'passenger', 'pin'].includes(b.transport) ? b.transport : (b.car ? 'driver' : 'passenger');
      let departure = ['first', 'second'].includes(b.departure) ? b.departure : 'first';
      if (transport === 'pin') departure = '';
      // 遅刻が選べるのはピンの人だけ（通常通り／遅刻の2択、時刻入力なし）
      const lateEarly = transport === 'pin' && b.lateEarly === 'late' ? 'late' : 'none';
      const r = {
        practiceId: b.practiceId, memberId: me.id,
        status: b.status === 'absent' ? 'absent' : 'present',
        transport, departure, color: b.color || '',
        car: transport === 'driver', seats: transport === 'driver' ? Math.max(0, parseInt(b.seats) || 0) : 0,
        lateEarly, time: '', comment: b.comment || '',
        updatedAt: new Date().toISOString(),
      };
      const i = data.responses.findIndex((x) => x.practiceId === r.practiceId && x.memberId === r.memberId);
      if (i >= 0) { data.responses[i] = r; data.changeLog.push({ memberId: me.id, practiceId: r.practiceId, at: new Date().toISOString(), kind: 'update' }); }
      else data.responses.push(r);
      saveData(data);
      return sendJson(res, 200, { response: r });
    }

    // --- 車割 ---
    if (p === '/api/allocation' && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '車割の作成は幹部だけができます' });
      const b = await readBody(req);
      data.allocations[b.practiceId] = b.assignments || {};
      saveData(data);
      const pr = data.practices.find((x) => x.id === b.practiceId);
      if (pr) notifyMembers(allMemberIdsExcept(me.id), { title: '車割が決まりました', body: `${pr.date} ${pr.place}の車割が決まりました` }).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    // --- 期限後の変更リクエスト ---
    if (p === '/api/change-requests' && req.method === 'POST') {
      const b = await readBody(req);
      if (!data.practices.some((x) => x.id === b.practiceId)) return sendJson(res, 400, { error: '練習が見つかりません' });
      const cr = { id: newId(), practiceId: b.practiceId, memberId: me.id, desiredStatus: b.desiredStatus === 'absent' ? 'absent' : 'present', message: b.message || '', createdAt: new Date().toISOString() };
      data.changeRequests.push(cr);
      data.changeLog.push({ memberId: me.id, practiceId: b.practiceId, at: new Date().toISOString(), kind: 'request' });
      saveData(data);
      notifyMembers(officerIdsExcept(me.id), { title: '変更リクエストが届きました', body: `${me.name}さんから変更リクエストが届きました` }).catch(() => {});
      return sendJson(res, 200, { changeRequest: cr });
    }
    if (p === '/api/change-requests' && req.method === 'GET') {
      const list = data.changeRequests
        .filter((c) => me.role === 'officer' || c.memberId === me.id)
        .map((c) => ({ ...c, member: publicMember(data.members.find((m) => m.id === c.memberId) || { name: '?' }), practice: data.practices.find((x) => x.id === c.practiceId) || null }));
      return sendJson(res, 200, { changeRequests: list });
    }

    // --- 2部練の設定（幹部） ---
    const splitMatch = p.match(/^\/api\/practices\/([^/]+)\/split$/);
    if (splitMatch && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '幹部のみ' });
      const practice = data.practices.find((x) => x.id === splitMatch[1]);
      if (!practice) return sendJson(res, 404, { error: '練習が見つかりません' });
      const b = await readBody(req);
      practice.split = Array.isArray(b.groups) && b.groups.length ? b.groups.map((g) => ({
        label: g.label || '', start: g.start || '', end: g.end || '',
        colors: Array.isArray(g.colors) ? g.colors : [],
      })) : null;
      saveData(data);
      if (practice.split) notifyMembers(allMemberIdsExcept(me.id), { title: '2部練の振り分けが決まりました', body: `${practice.date} ${practice.place}は2部練になりました` }).catch(() => {});
      return sendJson(res, 200, { practice });
    }

    // --- 新歓練への派遣（幹部） ---
    const shinkanMatch = p.match(/^\/api\/practices\/([^/]+)\/shinkan$/);
    if (shinkanMatch && req.method === 'POST') {
      if (me.role !== 'officer') return sendJson(res, 403, { error: '幹部のみ' });
      const practice = data.practices.find((x) => x.id === shinkanMatch[1]);
      if (!practice) return sendJson(res, 404, { error: '練習が見つかりません' });
      const b = await readBody(req);
      practice.shinkan = Array.isArray(b.memberIds) ? b.memberIds : [];
      saveData(data);
      return sendJson(res, 200, { practice });
    }

    // --- 練習詳細（集計） ---
    const detailMatch = p.match(/^\/api\/practices\/([^/]+)\/detail$/);
    if (detailMatch && req.method === 'GET') {
      const practice = data.practices.find((x) => x.id === detailMatch[1]);
      if (!practice) return sendJson(res, 404, { error: '練習が見つかりません' });
      let rs = data.responses.filter((r) => r.practiceId === practice.id)
        .map((r) => ({ ...r, member: publicMember(data.members.find((m) => m.id === r.memberId) || { name: '?' }) }));
      const answered = new Set(rs.map((r) => r.memberId));
      let unanswered = data.members.filter((m) => !answered.has(m.id)).map(publicMember);
      if (me.role !== 'officer') { rs = rs.filter((r) => r.memberId === me.id); unanswered = []; }
      return sendJson(res, 200, { practice, responses: rs, unanswered, allocation: me.role === 'officer' ? (data.allocations[practice.id] || {}) : {} });
    }

    // --- 今日の一覧 ---
    if (p === '/api/today' && req.method === 'GET') {
      const t = todayJST();
      const todays = data.practices.filter((x) => x.date === t);
      const result = todays.map((practice) => {
        let rs = data.responses.filter((r) => r.practiceId === practice.id)
          .map((r) => ({ ...r, member: publicMember(data.members.find((m) => m.id === r.memberId) || { name: '?' }) }));
        if (me.role !== 'officer') rs = [];
        return { practice, responses: rs, allocation: me.role === 'officer' ? (data.allocations[practice.id] || {}) : {} };
      });
      return sendJson(res, 200, { date: t, items: result });
    }

    // 生成画像の一時アップロード（表示・保存用に実URLを返す）
    if (p === '/api/image' && req.method === 'POST') {
      const me = authMember(req); if (!me) return sendJson(res, 401, { error: 'ログインが必要です' });
      const b = await readBody(req, 9e6);
      const m = /^data:image\/png;base64,(.+)$/.exec(b.data || '');
      if (!m) return sendJson(res, 400, { error: '画像データが不正です' });
      for (const [k, v] of tmpImages) if (v.exp < Date.now()) tmpImages.delete(k);
      const id = crypto.randomBytes(8).toString('hex');
      tmpImages.set(id, { buf: Buffer.from(m[1], 'base64'), exp: Date.now() + 10 * 60 * 1000 });
      return sendJson(res, 200, { url: '/img/' + id + '.png' });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  // --- 一時画像の配信 ---
  const imgMatch = /^\/img\/([a-f0-9]+)\.png$/.exec(p);
  if (imgMatch && req.method === 'GET') {
    const t = tmpImages.get(imgMatch[1]);
    if (!t || t.exp < Date.now()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(t.buf);
  }

  // --- 静的ファイル（公開してよいファイルだけ） ---
  const file = p === '/' ? 'index.html' : p.slice(1);
  if (!PUBLIC_FILES.has(file)) { res.writeHead(404); return res.end('not found'); }
  const filePath = path.join(PUBLIC_DIR, file);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' };
    if (file === 'index.html') headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(buf);
  });
});

// 回答期限当日のリマインド（30分ごとにチェック、練習ごとに1回だけ）
function checkDeadlineReminders() {
  const today = todayJST();
  for (const pr of data.practices) {
    if (!pr.deadline || pr.deadline.slice(0, 10) !== today || data.reminded[pr.id]) continue;
    const answered = new Set(data.responses.filter((r) => r.practiceId === pr.id).map((r) => r.memberId));
    const targets = data.members.filter((m) => !answered.has(m.id)).map((m) => m.id);
    data.reminded[pr.id] = true; saveData(data);
    if (targets.length) notifyMembers(targets, { title: '回答期限は今日までです', body: `${pr.date} ${pr.place}（${pr.type}）の出欠回答がまだの人は今日中にお願いします` }).catch(() => {});
  }
}
setInterval(checkDeadlineReminders, 30 * 60 * 1000);

server.listen(PORT, () => console.log(`listening on ${PORT}`));
