// 알바 주간정산 앱 - 서버 API (Vercel Serverless Function)
// 설치할 패키지 없음. Node 18 이상 기본 기능만 사용합니다.
//
// Vercel 환경변수 3개가 필요합니다.
//   GOOGLE_CREDENTIALS : 구글 서비스 계정 JSON 키 파일 내용 "통째로"
//   SHEET_ID           : 구글 시트 주소(URL) 또는 ID
//   ADMIN_PASSWORD     : 관리자 비밀번호 (adi2026)

const crypto = require('crypto');

const TZ = 'Asia/Seoul';
const WORKER_TAB = '알바생';
const recordTab = (y) => `${y} 근무`;
const settleTab = (y) => `${y} 정산`;

const WORKER_HEAD = ['아이디', '이름', '시급', '상태', '연락처', '등록일', '비밀번호(암호화)'];
const RECORD_HEAD = ['날짜', '요일', '이름', '아이디', '출근', '퇴근', '근무시간', '근무(분)', '시급', '금액', '업무내용', '수정일시', '기록ID', '기록방법'];
const SETTLE_HEAD = ['주 시작(월)', '주 끝(일)', '이름', '아이디', '근무시간', '근무(분)', '계산금액', '입금액', '차액', '입금일', '메모', '기록일시'];

const W = { id: 0, name: 1, wage: 2, status: 3, phone: 4, created: 5, hash: 6 };
const R = { date: 0, dow: 1, name: 2, wid: 3, in: 4, out: 5, hm: 6, min: 7, wage: 8, pay: 9, content: 10, updated: 11, rid: 12, method: 13 };
const S = { start: 0, end: 1, name: 2, wid: 3, hm: 4, min: 5, calc: 6, paid: 7, diff: 8, paidDate: 9, memo: 10, updated: 11 };

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/* ───────── 시간 (한국 시간 기준) ───────── */

function kstNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}
const dateOf = (dt) => String(dt).slice(0, 10);
const yearOf = (d) => String(d).slice(0, 4);

function toUtcMs(dt) { // "YYYY-MM-DD HH:mm" (한국시간) → ms
  const m = String(dt).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5]);
}
function addDays(d, n) {
  const [y, mo, da] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, da + n));
  return t.toISOString().slice(0, 10);
}
function dowOf(d) {
  const [y, mo, da] = d.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, da)).getUTCDay();
}
const weekStartOf = (d) => addDays(d, -((dowOf(d) + 6) % 7));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const isTime = (t) => /^\d{2}:\d{2}$/.test(String(t || ''));

function minutesBetween(a, b) {
  const diff = Math.floor((toUtcMs(b) - toUtcMs(a)) / 60000);
  return Number.isFinite(diff) && diff > 0 ? diff : 0;
}
const hm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const payOf = (min, wage) => Math.round((min * Number(wage || 0)) / 60);

/* ───────── 환경변수 ───────── */

function getSheetId() {
  const raw = String(process.env.SHEET_ID || '').trim();
  if (!raw) throw new AppError('Vercel 환경변수 SHEET_ID가 비어 있어요. 구글 시트 주소를 넣고 다시 배포(Redeploy)해주세요.', 500);
  const m = raw.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : raw;
}

let credCache = null;
function getCred() {
  if (credCache) return credCache;
  const raw = process.env.GOOGLE_CREDENTIALS;
  if (!raw) throw new AppError('Vercel 환경변수 GOOGLE_CREDENTIALS가 비어 있어요. 서비스 계정 JSON 파일 내용을 통째로 붙여넣고 다시 배포해주세요.', 500);
  let c;
  try { c = JSON.parse(raw.trim()); } catch (e) {
    throw new AppError('GOOGLE_CREDENTIALS 내용이 올바른 JSON이 아니에요. JSON 파일을 메모장으로 열어 { 부터 } 까지 전부 복사해 붙여넣어주세요.', 500);
  }
  if (!c.client_email || !c.private_key) {
    throw new AppError('GOOGLE_CREDENTIALS에 client_email 또는 private_key가 없어요. "서비스 계정 키(JSON)" 파일이 맞는지 확인해주세요.', 500);
  }
  c.private_key = String(c.private_key).replace(/\\n/g, '\n');
  credCache = c;
  return c;
}

function getAdminPassword() {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) throw new AppError('Vercel 환경변수 ADMIN_PASSWORD가 비어 있어요. adi2026 을 넣고 다시 배포해주세요.', 500);
  return String(pw);
}

/* ───────── 구글 인증 + 시트 API ───────── */

let tokenCache = null;
async function googleToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const c = getCred();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: c.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })}`;
  let sig;
  try {
    sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(c.private_key).toString('base64url');
  } catch (e) {
    throw new AppError('GOOGLE_CREDENTIALS의 private_key가 손상됐어요. JSON 파일 내용을 다시 통째로 붙여넣어주세요.', 500);
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}`,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new AppError('구글 로그인에 실패했어요. 서비스 계정 키가 삭제됐거나 복사가 잘렸을 수 있어요. 새 JSON 키를 받아 GOOGLE_CREDENTIALS에 다시 넣어주세요.', 500);
  }
  tokenCache = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function gapi(path, { method = 'GET', body } = {}) {
  const token = await googleToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${getSheetId()}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.ok) return res.json();
  const err = await res.json().catch(() => ({}));
  const msg = (err.error && err.error.message) || '';
  if (res.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(msg + JSON.stringify(err))) {
    throw new AppError('구글 클라우드에서 "Google Sheets API"가 꺼져 있어요. API 라이브러리에서 사용(Enable)을 눌러주세요.', 500);
  }
  if (res.status === 403) {
    throw new AppError(`구글 시트에 접근 권한이 없어요. 시트 오른쪽 위 [공유]에서 ${getCred().client_email} 을 "편집자"로 추가해주세요.`, 500);
  }
  if (res.status === 404) {
    throw new AppError('구글 시트를 찾을 수 없어요. SHEET_ID(시트 주소)가 맞는지 확인해주세요.', 500);
  }
  if (res.status === 429) throw new AppError('잠시 요청이 많았어요. 10초 뒤에 다시 눌러주세요.', 503);
  throw new AppError(`구글 시트 오류 (${res.status}) ${msg}`, 500);
}

const q = (title) => encodeURIComponent(`'${title}'`);

// 한 번의 요청 안에서 탭 목록을 기억해 둡니다.
function makeSheet() {
  let meta = null;
  async function tabs() {
    if (!meta) {
      const d = await gapi('?fields=sheets.properties(sheetId,title)');
      meta = {};
      (d.sheets || []).forEach((s) => { meta[s.properties.title] = s.properties.sheetId; });
    }
    return meta;
  }
  async function ensure(title, head) {
    const t = await tabs();
    if (t[title] !== undefined) return;
    try {
      const r = await gapi(':batchUpdate', {
        method: 'POST',
        body: { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] },
      });
      t[title] = r.replies[0].addSheet.properties.sheetId;
      await gapi(`/values/${q(title)}!A1?valueInputOption=RAW`, { method: 'PUT', body: { values: [head] } });
    } catch (e) {
      if (!/already exists|이미/.test(e.message)) throw e;
      meta = null; await tabs();
    }
  }
  async function read(title) {
    const t = await tabs();
    if (t[title] === undefined) return [];
    const d = await gapi(`/values/${q(title)}!A2:Z?valueRenderOption=UNFORMATTED_VALUE`);
    return (d.values || []).map((row, i) => ({ row: i + 2, v: row }));
  }
  async function append(title, head, values) {
    await ensure(title, head);
    await gapi(`/values/${q(title)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST', body: { values: [values] },
    });
  }
  async function update(title, row, values) {
    await gapi(`/values/${q(title)}!A${row}?valueInputOption=RAW`, { method: 'PUT', body: { values: [values] } });
  }
  async function remove(title, row) {
    const t = await tabs();
    await gapi(':batchUpdate', {
      method: 'POST',
      body: { requests: [{ deleteDimension: { range: { sheetId: t[title], dimension: 'ROWS', startIndex: row - 1, endIndex: row } } }] },
    });
  }
  return { tabs, ensure, read, append, update, remove };
}

/* ───────── 로그인 토큰 / 비밀번호 ───────── */

function secret() {
  return crypto.createHash('sha256').update(`${getCred().private_key}|${getAdminPassword()}|albawork`).digest();
}
function signToken(payload, days) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + days * 86400000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readToken(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}
function hashPw(pw) {
  const salt = crypto.randomBytes(12).toString('hex');
  return `${salt}$${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function checkPw(pw, stored) {
  const [salt, hash] = String(stored || '').split('$');
  if (!salt || !hash) return false;
  const a = crypto.scryptSync(String(pw), salt, 32);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ───────── 데이터 변환 ───────── */

const str = (v) => (v === undefined || v === null ? '' : String(v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const normId = (id) => str(id).trim().toLowerCase();

function workerObj(r) {
  const v = r.v;
  return {
    row: r.row, id: str(v[W.id]).trim(), name: str(v[W.name]), wage: num(v[W.wage]),
    status: str(v[W.status]) || '사용', phone: str(v[W.phone]), created: str(v[W.created]), hash: str(v[W.hash]),
  };
}
const publicWorker = (w) => ({ id: w.id, name: w.name, wage: w.wage, status: w.status, phone: w.phone, created: w.created });

function recordObj(r, tab) {
  const v = r.v;
  return {
    row: r.row, tab, rid: str(v[R.rid]), date: str(v[R.date]), wid: str(v[R.wid]).trim(), name: str(v[R.name]),
    in: str(v[R.in]), out: str(v[R.out]), min: num(v[R.min]), wage: num(v[R.wage]), pay: num(v[R.pay]), content: str(v[R.content]), method: str(v[R.method]),
  };
}
const publicRecord = (r) => ({ rid: r.rid, date: r.date, in: r.in, out: r.out, min: r.min, wage: r.wage, pay: r.pay, content: r.content, method: r.method });

function recordRow(rec) {
  const min = rec.out ? minutesBetween(rec.in, rec.out) : 0;
  const pay = rec.out ? payOf(min, rec.wage) : 0;
  return [
    rec.date, DOW[dowOf(rec.date)], rec.name, rec.wid, rec.in, rec.out || '',
    rec.out ? hm(min) : '', rec.out ? min : '', rec.wage, rec.out ? pay : '', rec.content || '', kstNow(), rec.rid, rec.method || '',
  ];
}

function settleObj(r, tab) {
  const v = r.v;
  return {
    row: r.row, tab, start: str(v[S.start]), end: str(v[S.end]), wid: str(v[S.wid]).trim(), name: str(v[S.name]),
    min: num(v[S.min]), calc: num(v[S.calc]), paid: num(v[S.paid]), diff: num(v[S.diff]),
    paidDate: str(v[S.paidDate]), memo: str(v[S.memo]), updated: str(v[S.updated]),
  };
}
const publicSettle = (s) => s && ({ start: s.start, end: s.end, min: s.min, calc: s.calc, paid: s.paid, diff: s.diff, paidDate: s.paidDate, memo: s.memo, updated: s.updated });

async function loadWorkers(sh) {
  return (await sh.read(WORKER_TAB)).map(workerObj).filter((w) => w.id);
}
async function loadRecordsBetween(sh, from, to) {
  const years = [...new Set([yearOf(from), yearOf(to)])];
  let out = [];
  for (const y of years) {
    const rows = await sh.read(recordTab(y));
    out = out.concat(rows.map((r) => recordObj(r, recordTab(y))).filter((x) => x.rid && x.date >= from && x.date <= to));
  }
  return out.sort((a, b) => (a.in < b.in ? -1 : 1));
}
async function findRecord(sh, rid, dateHint) {
  const tabs = await sh.tabs();
  const titles = Object.keys(tabs).filter((t) => /^\d{4} 근무$/.test(t));
  if (dateHint) {
    const y = yearOf(dateHint);
    titles.sort((a, b) => (b.startsWith(y) ? 1 : 0) - (a.startsWith(y) ? 1 : 0));
  }
  for (const t of titles) {
    const hit = (await sh.read(t)).map((r) => recordObj(r, t)).find((x) => x.rid === rid);
    if (hit) return hit;
  }
  return null;
}
async function findOpen(sh, wid) {
  const today = dateOf(kstNow());
  const years = [...new Set([yearOf(addDays(today, -1)), yearOf(today)])];
  for (const y of years) {
    const hit = (await sh.read(recordTab(y))).map((r) => recordObj(r, recordTab(y)))
      .filter((x) => x.rid && normId(x.wid) === normId(wid) && !x.out).pop();
    if (hit) return hit;
  }
  return null;
}
async function loadSettles(sh, weekStart) {
  const end = addDays(weekStart, 6);
  const t = settleTab(yearOf(end));
  return (await sh.read(t)).map((r) => settleObj(r, t)).filter((s) => s.start === weekStart);
}

function weekInfo(weekStart) {
  const end = addDays(weekStart, 6);
  const due = `${end} 22:00`;
  return { start: weekStart, end, due, dueReached: kstNow() >= due };
}

function summarize(records) {
  const done = records.filter((r) => r.out);
  return {
    days: new Set(done.map((r) => r.date)).size,
    min: done.reduce((a, r) => a + r.min, 0),
    calc: done.reduce((a, r) => a + r.pay, 0),
    working: records.some((r) => !r.out),
  };
}

const newId = () => `R${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

/* ───────── 기능별 처리 ───────── */

async function login(sh, { id, password }) {
  const uid = normId(id);
  if (!uid || !password) throw new AppError('아이디와 비밀번호를 모두 입력해주세요.');
  if (uid === 'admin') {
    if (!safeEqual(password, getAdminPassword())) throw new AppError('비밀번호가 맞지 않아요.', 401);
    await sh.ensure(WORKER_TAB, WORKER_HEAD);
    return { token: signToken({ role: 'admin', id: 'admin' }, 30), role: 'admin', name: '관리자', sheetUrl: `https://docs.google.com/spreadsheets/d/${getSheetId()}/edit` };
  }
  const w = (await loadWorkers(sh)).find((x) => normId(x.id) === uid);
  if (!w || !checkPw(password, w.hash)) throw new AppError('아이디 또는 비밀번호가 맞지 않아요.', 401);
  if (w.status === '중지') throw new AppError('사용이 중지된 계정이에요. 사장님께 문의해주세요.', 403);
  return { token: signToken({ role: 'worker', id: w.id }, 90), role: 'worker', name: w.name };
}

async function currentWorker(sh, auth) {
  const w = (await loadWorkers(sh)).find((x) => normId(x.id) === normId(auth.id));
  if (!w) throw new AppError('계정을 찾을 수 없어요. 다시 로그인해주세요.', 401);
  if (w.status === '중지') throw new AppError('사용이 중지된 계정이에요. 사장님께 문의해주세요.', 401);
  return w;
}

async function workerHome(sh, auth, { weekStart }) {
  const w = await currentWorker(sh, auth);
  const now = kstNow();
  const ws = isDate(weekStart) ? weekStartOf(weekStart) : weekStartOf(dateOf(now));
  const info = weekInfo(ws);
  const records = (await loadRecordsBetween(sh, info.start, info.end)).filter((r) => normId(r.wid) === normId(w.id));
  const settle = (await loadSettles(sh, ws)).find((s) => normId(s.wid) === normId(w.id));
  const open = await findOpen(sh, w.id);
  return {
    now, worker: { name: w.name, wage: w.wage }, week: info, locked: !!settle,
    records: records.map(publicRecord), summary: summarize(records),
    open: open ? publicRecord(open) : null,
    settle: settle ? { paid: settle.paid, paidDate: settle.paidDate } : null,
  };
}

async function clockIn(sh, auth, { content }) {
  const w = await currentWorker(sh, auth);
  if (await findOpen(sh, w.id)) throw new AppError('이미 출근 중이에요. 화면을 새로고침해주세요.');
  const now = kstNow();
  const rec = { rid: newId(), date: dateOf(now), wid: w.id, name: w.name, in: now, out: '', wage: w.wage, content: str(content).trim(), method: '출퇴근 버튼' };
  await sh.append(recordTab(yearOf(rec.date)), RECORD_HEAD, recordRow(rec));
  return { ok: true, time: now };
}

async function clockOut(sh, auth, { content }) {
  const w = await currentWorker(sh, auth);
  const text = str(content).trim();
  if (!text) throw new AppError('오늘 한 일을 적어야 퇴근할 수 있어요.');
  const open = await findOpen(sh, w.id);
  if (!open) throw new AppError('출근 기록이 없어요. 화면을 새로고침해주세요.');
  const now = kstNow();
  const rec = { ...open, out: now, content: text };
  await sh.update(open.tab, open.row, recordRow(rec));
  return { ok: true, time: now, min: minutesBetween(open.in, now) };
}

async function isSettled(sh, wid, date) {
  return (await loadSettles(sh, weekStartOf(date))).some((s) => normId(s.wid) === normId(wid));
}
const LOCKED_MSG = '입금이 끝난 주라서 고칠 수 없어요. 고칠 내용은 사장님께 말씀해주세요.';

// 같은 사람의 다른 기록과 시간이 겹치는지 확인
async function checkOverlap(sh, wid, inDt, outDt, excludeRid) {
  const now = kstNow();
  const recs = (await loadRecordsBetween(sh, addDays(dateOf(inDt), -1), dateOf(outDt || now)))
    .filter((r) => normId(r.wid) === normId(wid) && r.rid !== excludeRid);
  if (!outDt && recs.some((r) => !r.out)) throw new AppError('퇴근을 안 찍은 기록이 이미 있어요. 그 기록의 퇴근 시간을 먼저 넣어주세요.');
  const a1 = toUtcMs(inDt), a2 = toUtcMs(outDt || now);
  const hit = recs.find((r) => toUtcMs(r.in) < a2 && a1 < toUtcMs(r.out || now));
  if (hit) {
    const [, m, d] = hit.date.split('-').map(Number);
    throw new AppError(`${m}월 ${d}일 ${hit.in.slice(11, 16)} 출근 기록과 시간이 겹쳐요.`);
  }
}

// 날짜 + 시간 입력을 출근/퇴근 일시로 바꿈 (퇴근이 출근보다 이르면 다음날)
function buildTimes(date, inTime, outTime) {
  if (!isDate(date) || !isTime(inTime)) throw new AppError('날짜와 출근 시간을 입력해주세요.');
  if (outTime && !isTime(outTime)) throw new AppError('퇴근 시간 형식이 맞지 않아요.');
  const inDt = `${date} ${inTime}`;
  const outDt = outTime ? `${outTime <= inTime ? addDays(date, 1) : date} ${outTime}` : '';
  return { inDt, outDt };
}

async function mySaveRecord(sh, auth, { rid, date, inTime, outTime, content }) {
  const w = await currentWorker(sh, auth);
  const { inDt, outDt } = buildTimes(date, inTime, outTime);
  const now = kstNow();
  const text = str(content).trim();
  if (inDt > now || (outDt && outDt > now)) throw new AppError('아직 지나지 않은 시간은 기록할 수 없어요. 퇴근 전이면 퇴근 칸을 비워두세요.');
  if (date < addDays(weekStartOf(dateOf(now)), -7)) throw new AppError('지난주보다 오래된 기록은 직접 넣을 수 없어요. 사장님께 말씀해주세요.');
  if (!outDt && date < addDays(dateOf(now), -1)) throw new AppError('지난 날은 퇴근 시간까지 넣어주세요.');
  if (outDt && minutesBetween(inDt, outDt) > 16 * 60) throw new AppError('근무 시간이 16시간을 넘어요. 오전/오후를 다시 확인해주세요.');
  if (outDt && !text) throw new AppError('그날 한 일을 적어주세요.');
  if (await isSettled(sh, w.id, date)) throw new AppError(LOCKED_MSG);

  if (rid) {
    const old = await findRecord(sh, str(rid), date);
    if (!old || normId(old.wid) !== normId(w.id)) throw new AppError('기록을 찾을 수 없어요. 새로고침해주세요.');
    if (await isSettled(sh, w.id, old.date)) throw new AppError(LOCKED_MSG);
    await checkOverlap(sh, w.id, inDt, outDt, old.rid);
    const timeChanged = old.in !== inDt || old.out !== outDt;
    const rec = { ...old, date, in: inDt, out: outDt, content: text, method: timeChanged ? '알바생 수정' : old.method };
    if (yearOf(old.date) === yearOf(date)) {
      await sh.update(old.tab, old.row, recordRow(rec));
    } else {
      await sh.append(recordTab(yearOf(date)), RECORD_HEAD, recordRow(rec));
      await sh.remove(old.tab, old.row);
    }
    return { ok: true };
  }
  await checkOverlap(sh, w.id, inDt, outDt, '');
  const rec = { rid: newId(), date, wid: w.id, name: w.name, in: inDt, out: outDt, wage: w.wage, content: text, method: '알바생 입력' };
  await sh.append(recordTab(yearOf(date)), RECORD_HEAD, recordRow(rec));
  return { ok: true };
}

async function myDeleteRecord(sh, auth, { rid }) {
  const w = await currentWorker(sh, auth);
  const rec = await findRecord(sh, str(rid));
  if (!rec || normId(rec.wid) !== normId(w.id)) throw new AppError('기록을 찾을 수 없어요.');
  if (await isSettled(sh, w.id, rec.date)) throw new AppError(LOCKED_MSG);
  await sh.remove(rec.tab, rec.row);
  return { ok: true };
}

async function saveMemo(sh, auth, { rid, content }) {
  const w = await currentWorker(sh, auth);
  const rec = await findRecord(sh, str(rid));
  if (!rec || normId(rec.wid) !== normId(w.id)) throw new AppError('기록을 찾을 수 없어요.');
  if (await isSettled(sh, w.id, rec.date)) throw new AppError(LOCKED_MSG);
  await sh.update(rec.tab, rec.row, recordRow({ ...rec, content: str(content).trim() }));
  return { ok: true };
}

/* 관리자 */

async function adminWeek(sh, { weekStart }) {
  const ws = isDate(weekStart) ? weekStartOf(weekStart) : weekStartOf(dateOf(kstNow()));
  const info = weekInfo(ws);
  const workers = await loadWorkers(sh);
  const records = await loadRecordsBetween(sh, info.start, info.end);
  const settles = await loadSettles(sh, ws);
  const ids = new Set([...workers.filter((w) => w.status !== '중지').map((w) => normId(w.id)), ...records.map((r) => normId(r.wid)), ...settles.map((s) => normId(s.wid))]);
  const list = [...ids].map((id) => {
    const w = workers.find((x) => normId(x.id) === id);
    const recs = records.filter((r) => normId(r.wid) === id);
    const st = settles.find((s) => normId(s.wid) === id);
    return {
      id: w ? w.id : (recs[0] || st).wid,
      name: w ? w.name : (recs[0] || st).name,
      wage: w ? w.wage : 0,
      status: w ? w.status : '삭제됨',
      records: recs.map(publicRecord), summary: summarize(recs), settle: publicSettle(st),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return { now: kstNow(), week: info, workers: list };
}

async function adminWorkers(sh) {
  const workers = await loadWorkers(sh);
  return { workers: workers.map(publicWorker).sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name, 'ko') : a.status === '중지' ? 1 : -1)) };
}

async function saveWorker(sh, { isNew, id, name, wage, status, phone, password }) {
  const uid = str(id).trim();
  const nm = str(name).trim();
  const wg = Math.round(num(wage));
  if (!nm) throw new AppError('이름을 입력해주세요.');
  if (wg <= 0) throw new AppError('시급을 숫자로 입력해주세요.');
  const workers = await loadWorkers(sh);
  if (isNew) {
    if (!/^[a-zA-Z0-9_.-]{2,20}$/.test(uid)) throw new AppError('아이디는 영문, 숫자로 2~20자로 만들어주세요.');
    if (normId(uid) === 'admin') throw new AppError('admin은 관리자용이라 쓸 수 없어요.');
    if (workers.some((w) => normId(w.id) === normId(uid))) throw new AppError('이미 있는 아이디예요. 다른 아이디를 정해주세요.');
    if (str(password).length < 4) throw new AppError('비밀번호는 4자 이상으로 정해주세요.');
    await sh.append(WORKER_TAB, WORKER_HEAD, [uid, nm, wg, status === '중지' ? '중지' : '사용', str(phone).trim(), dateOf(kstNow()), hashPw(password)]);
    return { ok: true };
  }
  const w = workers.find((x) => normId(x.id) === normId(uid));
  if (!w) throw new AppError('알바생을 찾을 수 없어요.');
  if (password && str(password).length < 4) throw new AppError('비밀번호는 4자 이상으로 정해주세요.');
  await sh.update(WORKER_TAB, w.row, [w.id, nm, wg, status === '중지' ? '중지' : '사용', str(phone).trim(), w.created, password ? hashPw(password) : w.hash]);
  return { ok: true };
}

async function saveRecord(sh, { rid, workerId, date, inTime, outTime, content }) {
  const { inDt, outDt } = buildTimes(date, inTime, outTime);
  if (rid) {
    const old = await findRecord(sh, str(rid), date);
    if (!old) throw new AppError('기록을 찾을 수 없어요. 새로고침해주세요.');
    await checkOverlap(sh, old.wid, inDt, outDt, old.rid);
    const timeChanged = old.in !== inDt || old.out !== outDt;
    const rec = { ...old, date, in: inDt, out: outDt, content: str(content).trim(), method: timeChanged ? '관리자 수정' : old.method };
    if (yearOf(old.date) === yearOf(date)) {
      await sh.update(old.tab, old.row, recordRow(rec));
    } else {
      await sh.append(recordTab(yearOf(date)), RECORD_HEAD, recordRow(rec));
      await sh.remove(old.tab, old.row);
    }
    return { ok: true };
  }
  const w = (await loadWorkers(sh)).find((x) => normId(x.id) === normId(workerId));
  if (!w) throw new AppError('알바생을 찾을 수 없어요.');
  await checkOverlap(sh, w.id, inDt, outDt, '');
  const rec = { rid: newId(), date, wid: w.id, name: w.name, in: inDt, out: outDt, wage: w.wage, content: str(content).trim(), method: '관리자 입력' };
  await sh.append(recordTab(yearOf(date)), RECORD_HEAD, recordRow(rec));
  return { ok: true };
}

async function deleteRecord(sh, { rid }) {
  const rec = await findRecord(sh, str(rid));
  if (!rec) throw new AppError('기록을 찾을 수 없어요.');
  await sh.remove(rec.tab, rec.row);
  return { ok: true };
}

async function saveSettle(sh, { weekStart, workerId, paid, paidDate, memo }) {
  if (!isDate(weekStart)) throw new AppError('주를 다시 선택해주세요.');
  const ws = weekStartOf(weekStart);
  const info = weekInfo(ws);
  const paidN = Math.round(num(String(paid).replace(/[^0-9-]/g, '')));
  if (paidN < 0 || String(paid).trim() === '') throw new AppError('입금액을 입력해주세요.');
  if (!isDate(paidDate)) throw new AppError('입금일을 선택해주세요.');
  const workers = await loadWorkers(sh);
  const records = (await loadRecordsBetween(sh, info.start, info.end)).filter((r) => normId(r.wid) === normId(workerId));
  const w = workers.find((x) => normId(x.id) === normId(workerId));
  const name = w ? w.name : (records[0] && records[0].name) || '';
  const sum = summarize(records);
  const row = [info.start, info.end, name, w ? w.id : workerId, hm(sum.min), sum.min, sum.calc, paidN, paidN - sum.calc, paidDate, str(memo).trim(), kstNow()];
  const existing = (await loadSettles(sh, ws)).find((s) => normId(s.wid) === normId(workerId));
  if (existing) await sh.update(existing.tab, existing.row, row);
  else await sh.append(settleTab(yearOf(info.end)), SETTLE_HEAD, row);
  return { ok: true };
}

async function deleteSettle(sh, { weekStart, workerId }) {
  const existing = (await loadSettles(sh, weekStartOf(weekStart))).find((s) => normId(s.wid) === normId(workerId));
  if (!existing) throw new AppError('입금 기록이 없어요.');
  await sh.remove(existing.tab, existing.row);
  return { ok: true };
}

async function workerHistory(sh, { workerId, year }) {
  const y = /^\d{4}$/.test(String(year)) ? String(year) : yearOf(kstNow());
  const t = settleTab(y);
  const list = (await sh.read(t)).map((r) => settleObj(r, t)).filter((s) => normId(s.wid) === normId(workerId))
    .sort((a, b) => (a.start < b.start ? 1 : -1)).map(publicSettle);
  return { year: y, list, total: list.reduce((a, s) => a + s.paid, 0) };
}

/* 연결 점검 (브라우저에서 /api?check=1) */
async function check() {
  const steps = [];
  const step = async (name, fn) => {
    try { const r = await fn(); steps.push({ name, ok: true, detail: r || '' }); return true; } catch (e) { steps.push({ name, ok: false, detail: e.message }); return false; }
  };
  (await step('ADMIN_PASSWORD 환경변수', () => { getAdminPassword(); return '있음'; }))
  && (await step('SHEET_ID 환경변수', () => { const id = getSheetId(); return `${id.slice(0, 6)}…(${id.length}자)`; }))
  && (await step('GOOGLE_CREDENTIALS 환경변수', () => getCred().client_email))
  && (await step('구글 로그인', async () => { await googleToken(); return '성공'; }))
  && (await step('구글 시트 읽기/쓰기', async () => {
    const sh = makeSheet();
    await sh.ensure(WORKER_TAB, WORKER_HEAD);
    return `탭: ${Object.keys(await sh.tabs()).join(', ')}`;
  }));
  return { ok: steps.every((s) => s.ok) && steps.length === 5, steps };
}

/* ───────── 요청 처리 ───────── */

const WORKER_ACTIONS = { home: workerHome, clockIn, clockOut, saveMemo, mySaveRecord, myDeleteRecord };
const ADMIN_ACTIONS = { adminWeek, adminWorkers, saveWorker, saveRecord, deleteRecord, saveSettle, deleteSettle, workerHistory };

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const send = (status, obj) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === 'GET') {
      // 브라우저에서 주소/api 로 열면 연결 점검 결과를 보여줍니다.
      const r = await check();
      const e = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>연결 점검</title>
<body style="font-family:system-ui,sans-serif;font-size:18px;max-width:560px;margin:24px auto;padding:0 16px;background:#bdbfb8;color:#3c3e40">
<h1 style="font-size:26px">연결 점검 ${r.ok ? '완료' : '필요'}</h1>
${r.steps.map((s) => `<div style="background:${s.ok ? '#eeefea' : '#f2d9d4'};border-radius:12px;padding:12px 14px;margin-bottom:10px">
<b>${s.ok ? '통과' : '확인 필요'}</b> ${e(s.name)}<div style="font-size:15px;margin-top:4px;word-break:break-all">${e(s.detail)}</div></div>`).join('')}
${r.ok ? '<p>모두 통과했어요. 첫 화면에서 admin 으로 로그인하세요.</p>' : '<p>빨간 칸의 안내대로 고친 뒤, Vercel에서 다시 배포(Redeploy)하고 이 페이지를 새로고침하세요.</p>'}
</body>`);
    }
    if (req.method !== 'POST') return send(405, { error: '허용되지 않은 요청이에요.' });
    const body = await readBody(req);
    const sh = makeSheet();
    const { action } = body;
    if (action === 'login') return send(200, await login(sh, body));

    const auth = readToken(body.token);
    if (!auth) return send(401, { error: '로그인이 만료됐어요. 다시 로그인해주세요.' });
    if (auth.role === 'worker' && WORKER_ACTIONS[action]) return send(200, await WORKER_ACTIONS[action](sh, auth, body));
    if (auth.role === 'admin' && ADMIN_ACTIONS[action]) return send(200, await ADMIN_ACTIONS[action](sh, body));
    return send(403, { error: '권한이 없는 요청이에요.' });
  } catch (e) {
    const status = e instanceof AppError ? e.status : 500;
    if (!(e instanceof AppError)) console.error(e);
    return send(status, { error: e instanceof AppError ? e.message : `서버 오류: ${e.message}` });
  }
};

// 테스트용
module.exports._test = { kstNow, weekStartOf, addDays, minutesBetween, payOf };
