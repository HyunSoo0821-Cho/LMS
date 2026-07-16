// 인프런 비즈니스 제휴사 API 대시보드 서버 (의존성 없음 — Node 내장 모듈만 사용)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { buildWorkbook } from './xlsx.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- .env 로드 (dotenv 의존성 없이 직접 파싱) ----
function loadEnv() {
  const path = join(__dirname, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const TOKEN = process.env.INFLEARN_TOKEN;
const PORT = Number(process.env.PORT) || 3000;
const API_BASE = 'https://partners.inflearn.com/api/v1';

if (!TOKEN) {
  console.error('❌ INFLEARN_TOKEN 이 설정되지 않았습니다. .env 파일을 확인하세요.');
  process.exit(1);
}

// 문서 규격: Authorization: Basic base64({Token})
const AUTH_HEADER = 'Basic ' + Buffer.from(TOKEN).toString('base64');

// ==== 계정/세션 (users.json 파일 저장소, 세션은 HMAC 서명 쿠키) ====
const USERS_PATH = join(__dirname, 'users.json');
function loadUserStore() {
  if (existsSync(USERS_PATH)) {
    try { return JSON.parse(readFileSync(USERS_PATH, 'utf8')); } catch { /* 손상 시 초기화 */ }
  }
  const store = { secret: randomBytes(32).toString('hex'), users: [] };
  writeFileSync(USERS_PATH, JSON.stringify(store, null, 2));
  return store;
}
const userStore = loadUserStore();
const saveUsers = () => writeFileSync(USERS_PATH, JSON.stringify(userStore, null, 2));

const hashPassword = (pw, salt = randomBytes(16).toString('hex')) =>
  salt + ':' + scryptSync(String(pw), salt, 64).toString('hex');
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = scryptSync(String(pw), salt, 64);
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const SESSION_MS = 12 * 60 * 60 * 1000; // 12시간
const b64url = (s) => Buffer.from(s).toString('base64url');
const hmac = (s) => createHmac('sha256', userStore.secret).update(s).digest('base64url');
function makeSession(user) {
  const payload = b64url(JSON.stringify({ e: user.email, r: user.role, x: Date.now() + SESSION_MS }));
  return payload + '.' + hmac(payload);
}
function readSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)lms_sess=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig || hmac(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.x || data.x < Date.now()) return null;
    const user = userStore.users.find((u) => u.email === data.e);
    if (!user) return null;
    return user;
  } catch { return null; }
}
const publicUser = (u) => ({ name: u.name, email: u.email, uuid: u.uuid || null, dept: u.dept || null, phone: u.phone || null, role: u.role, createdAt: u.createdAt, assessment: u.assessment || null });
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `lms_sess=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// ---- 인프런 API 호출 헬퍼 ----
async function inflearn(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: AUTH_HEADER } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { code: 'PARSE_ERROR', message: text }; }
  return { status: res.status, json };
}

// 페이지네이션이 있는 목록 엔드포인트에서 전체 레코드 수집
async function fetchAll(path, extraParams, dataKey) {
  const pageSize = 100;
  let pageNumber = 1;
  let all = [];
  let totalCount = 0;
  // 최대 페이지 안전장치
  for (let guard = 0; guard < 500; guard++) {
    const { status, json } = await inflearn(path, { ...extraParams, pageNumber, pageSize });
    if (status !== 200 || !json || json.code !== 'SUCCESS') {
      throw new Error(`${path} 실패 (page ${pageNumber}): ${status} ${json && json.message}`);
    }
    const data = json.data || {};
    totalCount = data.totalCount ?? totalCount;
    const rows = data[dataKey] || [];
    all = all.concat(rows);
    if (rows.length < pageSize || all.length >= totalCount) break;
    pageNumber++;
  }
  return { totalCount, rows: all };
}

// 여러 페이지를 병렬 배치로 수집 (전체 카탈로그처럼 페이지가 많은 경우 속도 개선)
async function fetchAllParallel(path, extraParams, dataKey, concurrency = 6) {
  const pageSize = 100;
  const first = await inflearn(path, { ...extraParams, pageNumber: 1, pageSize });
  if (first.status !== 200 || first.json?.code !== 'SUCCESS') {
    throw new Error(`${path} 실패: ${first.status} ${first.json?.message}`);
  }
  const totalCount = first.json.data?.totalCount ?? 0;
  let rows = first.json.data?.[dataKey] || [];
  const pages = Math.ceil(totalCount / pageSize);
  for (let start = 2; start <= pages; start += concurrency) {
    const batch = [];
    for (let p = start; p < Math.min(start + concurrency, pages + 1); p++) {
      batch.push(inflearn(path, { ...extraParams, pageNumber: p, pageSize }));
    }
    const results = await Promise.all(batch);
    for (const r of results) {
      const rr = r.json?.data?.[dataKey];
      if (rr) rows = rows.concat(rr);
    }
  }
  return { totalCount, rows };
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// ---- 전체 강의 카탈로그 (경량 버전 + 태그/카테고리 집계, 1시간 캐시) ----
let catalogCache = { at: 0, data: null, building: null };
const CATALOG_MS = 60 * 60 * 1000;

function compactCourse(c) {
  return {
    id: c.id,
    title: c.title,
    thumbnailUrl: c.thumbnailUrl,
    instructorName: c.instructorName,
    mainCategory: c.mainCategory,
    subCategory: c.subCategory,
    skillTags: c.skillTags || [],
    level: (c.level && c.level[0]) ? c.level[0].value : null,
    rating: c.rating,
    reviewCount: c.reviewCount,
    studentCount: c.studentCount,
    runtime: c.runtime,
    lectureCount: c.lectureCount,
    regularPrice: c.regularPrice,
    isCertificateIssuable: c.isCertificateIssuable,
    isAllowed: c.isAllowed,
    publishedDate: c.publishedDate,
    description: (c.description || '').slice(0, 220),
  };
}

async function buildCatalog() {
  const { totalCount, rows } = await fetchAllParallel(
    '/courses', { searchType: 'ALL', curriculum: 'EXCLUDE' }, 'courses', 8
  );
  const courses = rows.map(compactCourse);
  const tagCount = new Map(), catCount = new Map(), subCount = new Map(), lvlCount = new Map();
  for (const c of courses) {
    for (const t of c.skillTags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    if (c.mainCategory) catCount.set(c.mainCategory, (catCount.get(c.mainCategory) || 0) + 1);
    if (c.subCategory) subCount.set(c.subCategory, (subCount.get(c.subCategory) || 0) + 1);
    if (c.level) lvlCount.set(c.level, (lvlCount.get(c.level) || 0) + 1);
  }
  const sortEntries = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
  return {
    generatedAt: new Date().toISOString(),
    totalCount,
    courses,
    facets: {
      tags: sortEntries(tagCount),
      categories: sortEntries(catCount),
      subCategories: sortEntries(subCount),
      levels: sortEntries(lvlCount),
    },
  };
}

async function getCatalog(force = false) {
  const fresh = Date.now() - catalogCache.at < CATALOG_MS;
  if (catalogCache.data && fresh && !force) return catalogCache.data;
  if (catalogCache.building) return catalogCache.building;
  catalogCache.building = (async () => {
    const data = await buildCatalog();
    catalogCache = { at: Date.now(), data, building: null };
    return data;
  })();
  return catalogCache.building;
}

// ---- 개별 강의 상세 (커리큘럼 포함, 캐시) ----
const courseCache = new Map();
async function getCourse(id) {
  if (courseCache.has(id)) return courseCache.get(id);
  const { json } = await inflearn('/courses', {
    pageNumber: 1, pageSize: 1, searchType: 'ALL', curriculum: 'INCLUDE', id,
  });
  const course = json?.data?.courses?.[0] || null;
  if (course) courseCache.set(id, course);
  return course;
}

// ---- 특정 멤버(로그인 사용자 시뮬레이션)의 수강 정보 ----
async function getMyLearning(uuid) {
  const db = await getDashboard();
  const mine = db.enrollments.filter((e) => e.uuid === uuid);
  const completed = mine.filter((e) => e.completed).length;
  const inProgress = mine.filter((e) => !e.completed && e.progressRate > 0).length;
  const totalSeconds = mine.reduce((s, e) => s + 0, 0); // 런타임은 카탈로그와 조인 시 계산
  return {
    uuid,
    email: (db.members.find((m) => m.uuid === uuid) || {}).email || null,
    stats: {
      enrollments: mine.length,
      completed,
      inProgress,
      certificates: mine.filter((e) => e.certificateUrl).length,
      avgProgress: mine.length ? +(mine.reduce((s, e) => s + e.progressRate, 0) / mine.length).toFixed(1) : 0,
    },
    enrollments: mine,
  };
}

// ---- 대시보드용 데이터 종합 (메모리 캐시 5분) ----
let cache = { at: 0, data: null, building: null };
const CACHE_MS = 5 * 60 * 1000;

async function buildDashboard() {
  const today = new Date().toISOString().slice(0, 10);

  // 1) 학습 현황 전체 (진도/완료 수업 수/최근 접속 등 상세)
  const lh = await fetchAll('/learning-history', {}, 'vouchers');

  // 2) 일별 진도율 (이메일 + 강의명 포함) — 넓은 기간으로 사실상 전체 수집
  let progress = { totalCount: 0, rows: [] };
  try {
    progress = await fetchAll(
      '/progress-by-date',
      { createdDateStart: '2015-01-01', createdDateEnd: today, inquiryDate: today },
      'vouchers'
    );
  } catch (e) {
    console.warn('progress-by-date 수집 경고:', e.message);
  }

  // 3) 강의 카탈로그 요약 (전체 개수 + 그룹 허용 강의)
  let catalogTotal = 0, groupCourses = [];
  try {
    const c = await inflearn('/courses', { pageNumber: 1, pageSize: 1, searchType: 'ALL' });
    catalogTotal = c.json?.data?.totalCount ?? 0;
    const g = await fetchAll('/courses', { searchType: 'GROUP', curriculum: 'EXCLUDE' }, 'courses');
    groupCourses = g.rows;
  } catch (e) {
    console.warn('courses 수집 경고:', e.message);
  }

  // voucher id 기준으로 learning-history + progress 조인
  const progById = new Map(progress.rows.map((v) => [v.id, v]));
  const enrollments = lh.rows.map((v) => {
    const p = progById.get(v.id) || {};
    const progressRate = num(v.progressRate ?? p.progressRate);
    return {
      id: v.id,
      uuid: v.uuid,
      email: p.email || null,
      courseId: v.courseId,
      courseTitle: p.courseTitle || `강의 #${v.courseId}`,
      createdAt: v.createdAt || p.createdAt || null,
      expiredAt: v.expiredAt ?? null,
      progressRate,
      completedLectureCount: v.completedLectureCount ?? null,
      learningStartedAt: v.learningStartedAt ?? null,
      latestAccessedAt: v.latestAccessedAt ?? null,
      courseCompletedAt: v.courseCompletedAt ?? p.courseCompletedAt ?? null,
      completed: !!(v.courseCompletedAt || p.courseCompletedAt) || progressRate >= 100,
      certificateUrl: v.courseCertificateUrl || p.courseCertificateUrl || null,
    };
  });

  // 멤버별 집계
  const memberMap = new Map();
  for (const e of enrollments) {
    if (!memberMap.has(e.uuid)) {
      memberMap.set(e.uuid, {
        uuid: e.uuid, email: e.email, enrollments: 0, completed: 0,
        certificates: 0, progressSum: 0, lastAccess: null,
      });
    }
    const m = memberMap.get(e.uuid);
    if (!m.email && e.email) m.email = e.email;
    m.enrollments++;
    if (e.completed) m.completed++;
    if (e.certificateUrl) m.certificates++;
    m.progressSum += e.progressRate;
    if (e.latestAccessedAt && (!m.lastAccess || e.latestAccessedAt > m.lastAccess)) {
      m.lastAccess = e.latestAccessedAt;
    }
  }
  const members = [...memberMap.values()].map((m) => ({
    ...m,
    avgProgress: m.enrollments ? +(m.progressSum / m.enrollments).toFixed(1) : 0,
  })).sort((a, b) => b.enrollments - a.enrollments);

  // 강의별 집계
  const courseMap = new Map();
  for (const e of enrollments) {
    if (!courseMap.has(e.courseId)) {
      courseMap.set(e.courseId, {
        courseId: e.courseId, title: e.courseTitle,
        enrollments: 0, completed: 0, progressSum: 0,
      });
    }
    const c = courseMap.get(e.courseId);
    if (c.title.startsWith('강의 #') && !e.courseTitle.startsWith('강의 #')) c.title = e.courseTitle;
    c.enrollments++;
    if (e.completed) c.completed++;
    c.progressSum += e.progressRate;
  }
  const courses = [...courseMap.values()].map((c) => ({
    ...c,
    avgProgress: c.enrollments ? +(c.progressSum / c.enrollments).toFixed(1) : 0,
    completionRate: c.enrollments ? +((c.completed / c.enrollments) * 100).toFixed(1) : 0,
  })).sort((a, b) => b.enrollments - a.enrollments);

  const totalCompleted = enrollments.filter((e) => e.completed).length;
  const totalCerts = enrollments.filter((e) => e.certificateUrl).length;
  const avgProgress = enrollments.length
    ? +(enrollments.reduce((s, e) => s + e.progressRate, 0) / enrollments.length).toFixed(1) : 0;

  // 진도율 구간 분포
  const buckets = [
    { label: '0%', min: 0, max: 0, count: 0 },
    { label: '1-25%', min: 0.01, max: 25, count: 0 },
    { label: '26-50%', min: 25.01, max: 50, count: 0 },
    { label: '51-75%', min: 50.01, max: 75, count: 0 },
    { label: '76-99%', min: 75.01, max: 99.99, count: 0 },
    { label: '100%', min: 100, max: 100, count: 0 },
  ];
  for (const e of enrollments) {
    const b = buckets.find((b) => e.progressRate >= b.min && e.progressRate <= b.max);
    if (b) b.count++;
  }

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      members: members.length,
      enrollments: enrollments.length,
      completed: totalCompleted,
      completionRate: enrollments.length ? +((totalCompleted / enrollments.length) * 100).toFixed(1) : 0,
      avgProgress,
      certificates: totalCerts,
      catalogTotal,
      groupCourses: groupCourses.length,
      distinctCourses: courses.length,
    },
    buckets,
    members,
    courses,
    enrollments: enrollments.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
  };
}

async function getDashboard(force = false) {
  const fresh = Date.now() - cache.at < CACHE_MS;
  if (cache.data && fresh && !force) return cache.data;
  if (cache.building) return cache.building;
  cache.building = (async () => {
    const data = await buildDashboard();
    cache = { at: Date.now(), data, building: null };
    return data;
  })();
  return cache.building;
}

// ---- 정적 파일 서빙 ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ---- 조직도 구성 (Microsoft Graph) — 라우트와 엑셀 내보내기에서 공용 ----
const COMPANY_MAP = {
  estsoft: 'ESTsoft', 이스트소프트: 'ESTsoft',
  estgames: 'ESTgames', 이스트게임즈: 'ESTgames',
  estaid: 'ESTaid', 이스트에이드: 'ESTaid',
  estsecurity: 'ESTsecurity', 이스트시큐리티: 'ESTsecurity',
  rounz: 'Rounz', 라운즈: 'Rounz',
  exponential: 'Exponential', 익스포넨셜: 'Exponential',
};
// 조직도 명단 파일(org-data.json — 엑셀 "조직도 전체" 시트에서 추출)이 있으면 Graph 대신 사용.
// 대분야(회사)는 ESTsoft / ESTsecurity 두 개로만 분류한다.
const ORG_DATA_PATH = join(__dirname, 'org-data.json');
async function buildOrgFromFile() {
  const roster = JSON.parse(readFileSync(ORG_DATA_PATH, 'utf8'));
  const db = await getDashboard();
  const byEmail = new Map(db.members.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m]));
  const byUuid = new Map(db.members.filter((m) => m.uuid).map((m) => [String(m.uuid), m]));
  const accByEmail = new Map(userStore.users.map((u) => [u.email.toLowerCase(), u]));
  return roster
    .filter((p) => p && (p.name || p.email))
    .map((p) => {
      const email = String(p.email || '').toLowerCase();
      const lms = byEmail.get(email) || (p.uuid ? byUuid.get(String(p.uuid).trim()) : null) || null;
      const acc = accByEmail.get(email) || null;
      const company = /security/i.test(String(p.company || '')) ? 'ESTsecurity' : 'ESTsoft';
      return {
        name: p.name, email,
        company, dept: (p.dept && String(p.dept).trim()) || '(부서 미지정)', title: p.title || '',
        uuid: lms?.uuid || (p.uuid ? String(p.uuid).trim() : null) || acc?.uuid || null,
        enrollments: lms?.enrollments || 0, completed: lms?.completed || 0,
        avgProgress: lms?.avgProgress || 0, lastAccess: lms?.lastAccess || null,
        hasAccount: !!acc,
      };
    });
}
async function buildOrg() {
  if (existsSync(ORG_DATA_PATH)) return buildOrgFromFile();
  const tok = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID, client_secret: process.env.AZURE_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
    }),
  }).then((r) => r.json());
  if (!tok.access_token) throw new Error('Graph 토큰 발급 실패: ' + (tok.error_description || tok.error || 'unknown'));
  let users = [], next = 'https://graph.microsoft.com/v1.0/users?$select=displayName,mail,userPrincipalName,department,jobTitle,companyName,proxyAddresses&$top=999';
  while (next) {
    const page = await fetch(next, { headers: { Authorization: 'Bearer ' + tok.access_token } }).then((r) => r.json());
    if (page.error) throw new Error('Graph 사용자 조회 실패: ' + page.error.message);
    users = users.concat(page.value || []);
    next = page['@odata.nextLink'] || null;
  }
  const db = await getDashboard();
  const byEmail = new Map(db.members.filter((m) => m.email).map((m) => [m.email.toLowerCase(), m]));
  const accByEmail = new Map(userStore.users.map((u) => [u.email.toLowerCase(), u]));
  const org = [];
  for (const g of users) {
    const company = COMPANY_MAP[String(g.companyName || '').trim().toLowerCase()];
    if (!company) continue;
    const candidates = [g.mail, g.userPrincipalName,
      ...(g.proxyAddresses || []).map((a) => String(a).replace(/^smtp:/i, ''))]
      .filter(Boolean).map((e) => e.toLowerCase());
    let lms = null, matchedMail = null;
    for (const e of candidates) { if (byEmail.has(e)) { lms = byEmail.get(e); matchedMail = e; break; } }
    const mail = (g.mail || g.userPrincipalName || '').toLowerCase();
    const acc = candidates.map((e) => accByEmail.get(e)).find(Boolean) || null;
    org.push({
      name: g.displayName, email: matchedMail || mail,
      company, dept: g.department || '(부서 미지정)', title: g.jobTitle || '',
      uuid: lms?.uuid || acc?.uuid || null,
      enrollments: lms?.enrollments || 0, completed: lms?.completed || 0,
      avgProgress: lms?.avgProgress || 0, lastAccess: lms?.lastAccess || null,
      hasAccount: !!acc,
    });
  }
  return org;
}

// 파일 다운로드 응답 (한글 파일명 안전 처리)
function sendFile(res, buf, filename, mime) {
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Disposition': `attachment; filename="download.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': buf.length,
  });
  res.end(buf);
}
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const dstr = (s) => (s ? String(s).replace('T', ' ').slice(0, 16) : '');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // --- 인증 라우트 ---
    if (path === '/api/auth/signup' && req.method === 'POST') {
      const b = await readBody(req);
      const { name, email, password, uuid, dept, phone } = b;
      const role = b.role === 'admin' ? 'admin' : 'user';
      if (!name || !email || !password) return sendJson(res, 400, { error: '이름/이메일/비밀번호는 필수입니다' });
      if (String(password).length < 4) return sendJson(res, 400, { error: '비밀번호는 4자 이상이어야 합니다' });
      if (userStore.users.some((u) => u.email === email)) return sendJson(res, 409, { error: '이미 가입된 이메일입니다' });
      const user = { name, email, uuid: uuid || null, dept: dept || null, phone: phone || null, role, pass: hashPassword(password), createdAt: new Date().toISOString() };
      userStore.users.push(user); saveUsers();
      setSessionCookie(res, makeSession(user));
      return sendJson(res, 201, { user: publicUser(user) });
    }
    if (path === '/api/auth/login' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const user = userStore.users.find((u) => u.email === email);
      if (!user || !checkPassword(password, user.pass)) return sendJson(res, 401, { error: '이메일 또는 비밀번호가 올바르지 않습니다' });
      setSessionCookie(res, makeSession(user));
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (path === '/api/auth/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'lms_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/api/auth/me') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      return sendJson(res, 200, { user: publicUser(user) });
    }
    if (path === '/api/auth/change-password' && req.method === 'POST') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { current, next } = await readBody(req);
      if (!checkPassword(current, user.pass)) return sendJson(res, 400, { error: '현재 비밀번호가 올바르지 않습니다' });
      if (!next || String(next).length < 4) return sendJson(res, 400, { error: '새 비밀번호는 4자 이상이어야 합니다' });
      user.pass = hashPassword(next); saveUsers();
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/api/auth/profile' && req.method === 'POST') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { name, uuid, dept } = await readBody(req);
      if (name) user.name = name;
      if (uuid !== undefined) user.uuid = uuid || null;
      if (dept !== undefined) user.dept = dept || null;
      saveUsers();
      return sendJson(res, 200, { user: publicUser(user) });
    }

    // --- 관리자 전용 API (계정 관리) ---
    if (path.startsWith('/api/admin/')) {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      if (path === '/api/admin/users' && req.method === 'GET') {
        return sendJson(res, 200, { users: userStore.users.map(publicUser) });
      }
      if (path === '/api/admin/users' && req.method === 'POST') {
        const { name, email, password, uuid, dept, phone, role } = await readBody(req);
        if (!name || !email || !password) return sendJson(res, 400, { error: '이름/이메일/초기 비밀번호는 필수입니다' });
        if (userStore.users.some((u) => u.email === email)) return sendJson(res, 409, { error: '이미 존재하는 이메일입니다' });
        const user = { name, email, uuid: uuid || null, dept: dept || null, phone: phone || null, role: role === 'admin' ? 'admin' : 'user', pass: hashPassword(password), createdAt: new Date().toISOString() };
        userStore.users.push(user); saveUsers();
        return sendJson(res, 201, { user: publicUser(user) });
      }
      if (path === '/api/admin/users' && req.method === 'PATCH') {
        const { email, name, uuid, dept, phone, role, resetPassword } = await readBody(req);
        const user = userStore.users.find((u) => u.email === email);
        if (!user) return sendJson(res, 404, { error: '해당 이메일의 계정이 없습니다' });
        if (name) user.name = name;
        if (uuid !== undefined) user.uuid = uuid || null;
        if (dept !== undefined) user.dept = dept || null;
        if (phone !== undefined) user.phone = phone || null;
        if (role) user.role = role === 'admin' ? 'admin' : 'user';
        if (resetPassword) user.pass = hashPassword(resetPassword);
        saveUsers();
        return sendJson(res, 200, { user: publicUser(user) });
      }
      if (path === '/api/admin/users' && req.method === 'DELETE') {
        const { email } = await readBody(req);
        const i = userStore.users.findIndex((u) => u.email === email);
        if (i < 0) return sendJson(res, 404, { error: '해당 이메일의 계정이 없습니다' });
        if (userStore.users[i].email === me.email) return sendJson(res, 400, { error: '본인 계정은 삭제할 수 없습니다' });
        userStore.users.splice(i, 1); saveUsers();
        return sendJson(res, 200, { ok: true });
      }
    }

    // --- 역량진단 결과 저장/조회 (로그인 사용자) ---
    if (path === '/api/auth/assessment' && req.method === 'POST') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { level, tier, total, avg, weak } = await readBody(req);
      user.assessment = { level, tier, total, avg, weak, at: new Date().toISOString() };
      saveUsers();
      return sendJson(res, 200, { ok: true, assessment: user.assessment });
    }
    if (path === '/api/auth/assessment' && req.method === 'GET') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      return sendJson(res, 200, { assessment: user.assessment || null });
    }

    // --- 추천 설정 (강의 풀·태그 가중치) — 조회는 로그인 사용자, 수정은 관리자 ---
    const REC_PATH = join(__dirname, 'rec-config.json');
    if (path === '/api/rec-config' && req.method === 'GET') {
      if (!existsSync(REC_PATH)) return sendJson(res, 200, { config: null });
      return sendJson(res, 200, { config: JSON.parse(readFileSync(REC_PATH, 'utf8')) });
    }
    if (path === '/api/admin/rec-config' && req.method === 'POST') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const config = await readBody(req);
      config.updatedAt = new Date().toISOString();
      config.updatedBy = me.email;
      writeFileSync(REC_PATH, JSON.stringify(config, null, 2));
      return sendJson(res, 200, { ok: true, config });
    }

    // --- 조직도 (Microsoft Graph API) + 이메일→UUID 매핑 + 리마인드 발송 ---
    if (path === '/api/admin/org' && req.method === 'GET') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      try {
        const org = await buildOrg();
        return sendJson(res, 200, { count: org.length, org });
      } catch (e) { return sendJson(res, 502, { error: 'Graph 연동 오류: ' + e.message }); }
    }
    const REMIND_PATH = join(__dirname, 'reminders.json');
    const loadReminds = () => existsSync(REMIND_PATH) ? JSON.parse(readFileSync(REMIND_PATH, 'utf8')) : [];
    if (path === '/api/admin/remind' && req.method === 'POST') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const { targets, message } = await readBody(req); // targets: [{name,email,uuid}]
      if (!Array.isArray(targets) || !targets.length) return sendJson(res, 400, { error: '발송 대상(targets)이 필요합니다' });
      const list = loadReminds();
      const batch = targets.map((t) => ({
        name: t.name, email: t.email, uuid: t.uuid || null,
        message: message || '수강 신청/학습을 시작해 주세요! — EST family 학습 리마인드',
        sentBy: me.email, sentAt: new Date().toISOString(), channel: 'teams(예정)·이메일(데모 기록)',
      }));
      list.push(...batch);
      writeFileSync(REMIND_PATH, JSON.stringify(list, null, 2));
      return sendJson(res, 200, { ok: true, sent: batch.length });
    }
    if (path === '/api/admin/reminders' && req.method === 'GET') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      return sendJson(res, 200, { reminders: loadReminds().slice(-200).reverse() });
    }

    // --- 엑셀 내보내기: 학습자현황 (그대로 뽑기) ---
    if (path === '/api/admin/export/learners.xlsx' && req.method === 'GET') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const db = await getDashboard();
      const s = db.stats;
      const summary = {
        name: '요약', cols: [22, 16],
        rows: [
          ['항목', '값'],
          ['수강 멤버(고유 UUID)', s.members],
          ['총 수강권', s.enrollments],
          ['수료 완료', s.completed],
          ['수료율(%)', s.completionRate],
          ['평균 진도율(%)', s.avgProgress],
          ['수료증 발급', s.certificates],
          ['수강 강의 수', s.distinctCourses],
          ['전체 강의 카탈로그', s.catalogTotal],
          ['기준 시각', dstr(db.generatedAt)],
        ],
      };
      const members = {
        name: '멤버별 현황', cols: [14, 30, 12, 10, 14, 10, 18],
        rows: [['UUID', '이메일', '수강 강의수', '수료수', '평균 진도율(%)', '수료증수', '최근 학습']]
          .concat(db.members.map((m) => [m.uuid, m.email || '', m.enrollments, m.completed, m.avgProgress, m.certificates, m.lastAccess || ''])),
      };
      const enroll = {
        name: '수강내역', cols: [12, 26, 10, 40, 12, 10, 16, 16, 16],
        rows: [['UUID', '이메일', '강의ID', '강의명', '진도율(%)', '상태', '수강신청일', '최근 학습', '수료일']]
          .concat(db.enrollments.map((e) => [e.uuid, e.email || '', e.courseId, e.courseTitle, e.progressRate,
            e.completed ? '수료' : e.progressRate > 0 ? '학습중' : '미시작', dstr(e.createdAt), e.latestAccessedAt || '', dstr(e.courseCompletedAt)])),
      };
      const buf = buildWorkbook([summary, members, enroll]);
      return sendFile(res, buf, `학습자현황_${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME);
    }

    // --- 엑셀 내보내기: 조직도·리마인드 (부서별 정리) ---
    if (path === '/api/admin/export/org.xlsx' && req.method === 'GET') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      let org;
      try { org = await buildOrg(); }
      catch (e) { return sendJson(res, 502, { error: 'Graph 연동 오류: ' + e.message }); }

      // 리마인드 기록 → 이메일별 최근 발송일시/횟수 매핑
      const reminds = loadReminds();
      const lastRemindByEmail = new Map();
      const countByEmail = new Map();
      for (const r of reminds) {
        const k = (r.email || '').toLowerCase();
        if (!k) continue;
        countByEmail.set(k, (countByEmail.get(k) || 0) + 1);
        if (!lastRemindByEmail.has(k) || r.sentAt > lastRemindByEmail.get(k)) lastRemindByEmail.set(k, r.sentAt);
      }

      // 화면(관리자 트리)과 동일한 규칙
      const NO_CO = '(소속사 미지정)', NO_DEPT = '(부서 미지정)';
      const eligible = (p) => (Number(p.enrollments) || 0) === 0 || (Number(p.avgProgress) || 0) === 0; // 리마인드 대상
      const statusOf = (p) => {
        const en = Number(p.enrollments) || 0;
        if (en === 0) return '수강 없음';
        if ((Number(p.avgProgress) || 0) === 0) return '미시작';
        if ((Number(p.completed) || 0) === en) return '완료';
        return '학습중';
      };

      // 회사 → 부서 트리 구성 (화면과 동일: 매핑 많은순, 미지정은 마지막)
      const coMap = new Map();
      org.forEach((p) => {
        const coName = (p.company && String(p.company).trim()) || NO_CO;
        const deName = (p.dept && String(p.dept).trim()) || NO_DEPT;
        let c = coMap.get(coName);
        if (!c) { c = { name: coName, size: 0, mapped: 0, remindN: 0, enr: 0, comp: 0, prog: 0, depts: new Map() }; coMap.set(coName, c); }
        let d = c.depts.get(deName);
        if (!d) { d = { name: deName, people: [], mapped: 0, remindN: 0, enr: 0, comp: 0, prog: 0 }; c.depts.set(deName, d); }
        d.people.push(p); c.size++;
        if (p.uuid) { d.mapped++; c.mapped++; }
        if (eligible(p)) { d.remindN++; c.remindN++; }
        d.enr += p.enrollments; d.comp += p.completed; d.prog += p.avgProgress;
        c.enr += p.enrollments; c.comp += p.completed; c.prog += p.avgProgress;
      });
      const rank = (noName) => (a, b) => {
        const au = a.name === noName, bu = b.name === noName;
        if (au !== bu) return au ? 1 : -1;
        if (b.mapped !== a.mapped) return b.mapped - a.mapped;
        return b.size - a.size || (b.people ? b.people.length : 0) - (a.people ? a.people.length : 0);
      };
      const companies = [...coMap.values()].sort(rank(NO_CO));
      companies.forEach((c) => { c.deptList = [...c.depts.values()].sort((x, y) => (x.name === NO_DEPT) - (y.name === NO_DEPT) || y.mapped - x.mapped || y.people.length - x.people.length); });
      const avg = (sum, n) => (n ? +(sum / n).toFixed(1) : 0);

      // 시트1: 회사별 요약
      const coSheet = {
        name: '회사별 요약', cols: [16, 8, 8, 10, 12, 14],
        rows: [['회사', '부서수', '인원', 'UUID매핑', '리마인드대상', '평균진도율(%)']]
          .concat(companies.map((c) => [c.name, c.deptList.length, c.size, c.mapped, c.remindN, avg(c.prog, c.size)])),
      };

      // 시트2: 부서별 요약 (화면 트리와 동일 순서)
      const deptRows = [['회사', '부서', '인원', 'UUID매핑', '리마인드대상', '총수강', '총수료', '평균진도율(%)']];
      companies.forEach((c) => c.deptList.forEach((d) =>
        deptRows.push([c.name, d.name, d.people.length, d.mapped, d.remindN, d.enr, d.comp, avg(d.prog, d.people.length)])));
      const deptSheet = { name: '부서별 요약', cols: [16, 24, 8, 10, 12, 10, 10, 14], rows: deptRows };

      // 시트3: 조직도 전체 (트리 순서대로, 인원 명단 + 리마인드 대상/발송 상태)
      const fullRows = [['회사', '부서', '이름', '직책', '이메일', '사번(UUID)', 'LMS계정', '수강', '수료', '평균진도율(%)', '상태', '리마인드대상', '최근 발송']];
      companies.forEach((c) => c.deptList.forEach((d) => d.people.forEach((p) => {
        const k = (p.email || '').toLowerCase();
        fullRows.push([c.name, d.name, p.name, p.title, p.email, p.uuid || '', p.hasAccount ? 'O' : '-',
          p.enrollments, p.completed, p.avgProgress, statusOf(p), eligible(p) ? 'Y' : '', dstr(lastRemindByEmail.get(k))]);
      })));
      const orgSheet = { name: '조직도 전체', cols: [16, 22, 12, 16, 28, 12, 8, 8, 8, 12, 10, 10, 16], rows: fullRows };

      // 시트4: 리마인드 발송기록
      const remindSheet = {
        name: '리마인드 기록', cols: [18, 12, 26, 12, 40, 24, 22],
        rows: [['발송일시', '이름', '이메일', '사번', '메시지', '발송자', '채널']]
          .concat([...reminds].reverse().map((r) => [dstr(r.sentAt), r.name || '', r.email || '', r.uuid || '', r.message || '', r.sentBy || '', r.channel || ''])),
      };

      const buf = buildWorkbook([coSheet, deptSheet, orgSheet, remindSheet]);
      return sendFile(res, buf, `조직도_리마인드_부서별_${new Date().toISOString().slice(0, 10)}.xlsx`, XLSX_MIME);
    }

    // --- 공지사항 (조회: 전체, 편집: 관리자) ---
    const NOTICE_PATH = join(__dirname, 'notices.json');
    const defaultNotices = [
      { id: 1, tag: '공지', t: '[EST family] 새롭게 추가된 신규 강의를 확인하세요', d: '2026.07.10' },
      { id: 2, tag: '안내', t: 'The RED: 실무에 바로 적용하는 심화 강의 시리즈 오픈', d: '2026.06.28' },
      { id: 3, tag: '이벤트', t: 'AI 활용 역량 강화 학습 챌린지 참여 안내', d: '2026.06.15' },
      { id: 4, tag: '공지', t: '개인별 학습 리포트 기능이 업데이트되었습니다', d: '2026.05.30' },
    ];
    const loadNotices = () => existsSync(NOTICE_PATH) ? JSON.parse(readFileSync(NOTICE_PATH, 'utf8')) : defaultNotices;
    if (path === '/api/notices' && req.method === 'GET') {
      return sendJson(res, 200, { notices: loadNotices() });
    }
    if (path === '/api/admin/notices' && req.method === 'POST') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const { notices } = await readBody(req); // 전체 목록 교체 방식
      if (!Array.isArray(notices)) return sendJson(res, 400, { error: 'notices 배열이 필요합니다' });
      writeFileSync(NOTICE_PATH, JSON.stringify(notices, null, 2));
      return sendJson(res, 200, { ok: true, notices });
    }

    // --- 추천 검색어 (조회: 노출 중인 것만, 편집: 관리자) — 검색서비스 추천 검색어 제공 ---
    const SEARCHKW_PATH = join(__dirname, 'search-keywords.json');
    const defaultSearchKeywords = [
      { id: 1, keyword: '바이브코딩', device: 'PC/MOB', startDate: '2026-07-01', endDate: '2026-12-31', status: '게시중', createdBy: 'admin@test.com', createdAt: '2026-07-01T09:00:00.000Z' },
      { id: 2, keyword: 'AI Agent', device: 'PC/MOB', startDate: '2026-07-01', endDate: '2026-12-31', status: '게시중', createdBy: 'admin@test.com', createdAt: '2026-07-01T09:00:00.000Z' },
      { id: 3, keyword: '클로드 코드', device: 'PC', startDate: '2026-07-01', endDate: '2026-12-31', status: '게시중', createdBy: 'admin@test.com', createdAt: '2026-07-01T09:00:00.000Z' },
      { id: 4, keyword: 'RAG', device: 'PC/MOB', startDate: '2026-07-01', endDate: '2026-12-31', status: '게시중', createdBy: 'admin@test.com', createdAt: '2026-07-01T09:00:00.000Z' },
      { id: 5, keyword: 'n8n 업무 자동화', device: 'PC/MOB', startDate: '2026-07-01', endDate: '2026-12-31', status: '게시중', createdBy: 'admin@test.com', createdAt: '2026-07-01T09:00:00.000Z' },
      { id: 6, keyword: '프롬프트엔지니어링', device: 'MOB', startDate: '2026-07-01', endDate: '2026-12-31', status: '게시중', createdBy: 'admin@test.com', createdAt: '2026-07-01T09:00:00.000Z' },
    ];
    const loadSearchKeywords = () => existsSync(SEARCHKW_PATH) ? JSON.parse(readFileSync(SEARCHKW_PATH, 'utf8')) : defaultSearchKeywords;
    if (path === '/api/search-keywords' && req.method === 'GET') {
      const today = new Date().toISOString().slice(0, 10);
      const active = loadSearchKeywords().filter((k) =>
        k.keyword && k.status === '게시중' && (!k.startDate || k.startDate <= today) && (!k.endDate || k.endDate >= today));
      return sendJson(res, 200, { keywords: active });
    }
    if (path === '/api/admin/search-keywords' && req.method === 'GET') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      return sendJson(res, 200, { keywords: loadSearchKeywords() });
    }
    if (path === '/api/admin/search-keywords' && req.method === 'POST') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const { keywords } = await readBody(req); // 전체 목록 교체 방식 (공지사항과 동일)
      if (!Array.isArray(keywords)) return sendJson(res, 400, { error: 'keywords 배열이 필요합니다' });
      const now = new Date().toISOString();
      for (const k of keywords) {
        if (!k.createdBy) k.createdBy = me.email;
        if (!k.createdAt) k.createdAt = now;
      }
      writeFileSync(SEARCHKW_PATH, JSON.stringify(keywords, null, 2));
      return sendJson(res, 200, { ok: true, keywords });
    }

    // ==== 커뮤니티 · 질문&답변 (강의별 Q&A) ====
    const QNA_PATH = join(__dirname, 'questions.json');
    const loadQna = () => existsSync(QNA_PATH) ? JSON.parse(readFileSync(QNA_PATH, 'utf8')) : { seq: 1, questions: [] };
    const saveQna = (db) => writeFileSync(QNA_PATH, JSON.stringify(db, null, 2));
    const publicQ = (q) => ({
      id: q.id, courseId: q.courseId, title: q.title, body: q.body,
      authorName: q.authorName, authorEmail: q.authorEmail, createdAt: q.createdAt,
      resolved: !!q.resolved,
      answers: (q.answers || []).map((a) => ({
        id: a.id, body: a.body, authorName: a.authorName, authorEmail: a.authorEmail,
        isInstructor: !!a.isInstructor, createdAt: a.createdAt,
      })),
    });

    // 질문 목록 (강의별, 로그인 사용자) — 최신순
    if (path === '/api/questions' && req.method === 'GET') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const courseId = url.searchParams.get('courseId');
      if (!courseId) return sendJson(res, 400, { error: 'courseId 파라미터가 필요합니다' });
      const db = loadQna();
      const list = db.questions
        .filter((q) => String(q.courseId) === String(courseId))
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map(publicQ);
      return sendJson(res, 200, { questions: list, canModerate: me.role === 'admin' });
    }
    // 질문 등록 (로그인 사용자)
    if (path === '/api/questions' && req.method === 'POST') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { courseId, title, body } = await readBody(req);
      if (!courseId) return sendJson(res, 400, { error: 'courseId가 필요합니다' });
      if (!title || !String(title).trim()) return sendJson(res, 400, { error: '질문 제목을 입력해 주세요' });
      const db = loadQna();
      const q = {
        id: db.seq++, courseId: Number(courseId) || courseId,
        title: String(title).trim().slice(0, 200),
        body: String(body || '').trim().slice(0, 4000),
        authorName: me.name, authorEmail: me.email,
        createdAt: new Date().toISOString(), resolved: false, answers: [],
      };
      db.questions.push(q);
      saveQna(db);
      return sendJson(res, 201, { question: publicQ(q) });
    }
    // 질문 삭제 (작성자 본인 또는 관리자)
    if (path === '/api/questions' && req.method === 'DELETE') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const id = Number(url.searchParams.get('id'));
      const db = loadQna();
      const i = db.questions.findIndex((q) => q.id === id);
      if (i < 0) return sendJson(res, 404, { error: '질문을 찾을 수 없습니다' });
      if (db.questions[i].authorEmail !== me.email && me.role !== 'admin') {
        return sendJson(res, 403, { error: '본인 또는 관리자만 삭제할 수 있습니다' });
      }
      db.questions.splice(i, 1);
      saveQna(db);
      return sendJson(res, 200, { ok: true });
    }
    // 답변 등록 (로그인 사용자) — 관리자 답변은 지식공유자 뱃지
    if (path === '/api/answers' && req.method === 'POST') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { questionId, body } = await readBody(req);
      if (!body || !String(body).trim()) return sendJson(res, 400, { error: '답변 내용을 입력해 주세요' });
      const db = loadQna();
      const q = db.questions.find((x) => x.id === (Number(questionId) || questionId));
      if (!q) return sendJson(res, 404, { error: '질문을 찾을 수 없습니다' });
      const a = {
        id: (q.aSeq = (q.aSeq || 0) + 1),
        body: String(body).trim().slice(0, 4000),
        authorName: me.name, authorEmail: me.email,
        isInstructor: me.role === 'admin',
        createdAt: new Date().toISOString(),
      };
      if (!Array.isArray(q.answers)) q.answers = [];
      q.answers.push(a);
      saveQna(db);
      return sendJson(res, 201, { question: publicQ(q) });
    }
    // 답변 삭제 (작성자 본인 또는 관리자)
    if (path === '/api/answers' && req.method === 'DELETE') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const questionId = Number(url.searchParams.get('questionId'));
      const answerId = Number(url.searchParams.get('answerId'));
      const db = loadQna();
      const q = db.questions.find((x) => x.id === questionId);
      if (!q) return sendJson(res, 404, { error: '질문을 찾을 수 없습니다' });
      const i = (q.answers || []).findIndex((a) => a.id === answerId);
      if (i < 0) return sendJson(res, 404, { error: '답변을 찾을 수 없습니다' });
      if (q.answers[i].authorEmail !== me.email && me.role !== 'admin') {
        return sendJson(res, 403, { error: '본인 또는 관리자만 삭제할 수 있습니다' });
      }
      q.answers.splice(i, 1);
      saveQna(db);
      return sendJson(res, 200, { question: publicQ(q) });
    }

    // ==== 수강신청 승인 (바로 수강신청 → 관리자 승인/불가 → 내 학습 반영) ====
    const ENROLL_PATH = join(__dirname, 'enroll-requests.json');
    const loadEnroll = () => existsSync(ENROLL_PATH) ? JSON.parse(readFileSync(ENROLL_PATH, 'utf8')) : { seq: 1, requests: [] };
    const saveEnroll = (db) => writeFileSync(ENROLL_PATH, JSON.stringify(db, null, 2));

    // 사용자 본인 신청 목록
    if (path === '/api/enrollments' && req.method === 'GET') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const db = loadEnroll();
      const mine = db.requests
        .filter((r) => r.userEmail === me.email)
        .sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
      return sendJson(res, 200, { requests: mine });
    }
    // 수강신청 (승인 대기 상태로 접수)
    if (path === '/api/enrollments' && req.method === 'POST') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { courseId, courseTitle, thumbnailUrl } = await readBody(req);
      if (!courseId) return sendJson(res, 400, { error: 'courseId가 필요합니다' });
      const db = loadEnroll();
      const existing = db.requests.filter((r) => r.userEmail === me.email && String(r.courseId) === String(courseId));
      if (existing.some((r) => r.status === 'pending')) return sendJson(res, 409, { error: '이미 승인 대기 중인 신청이 있습니다' });
      if (existing.some((r) => r.status === 'approved')) return sendJson(res, 409, { error: '이미 승인된 강의입니다' });
      const reqObj = {
        id: db.seq++, courseId: Number(courseId) || courseId,
        courseTitle: String(courseTitle || '').slice(0, 200) || `강의 #${courseId}`,
        thumbnailUrl: thumbnailUrl || null,
        userEmail: me.email, userName: me.name, uuid: me.uuid || null,
        status: 'pending', reason: null,
        requestedAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
      };
      db.requests.push(reqObj);
      saveEnroll(db);
      return sendJson(res, 201, { request: reqObj });
    }
    // 사용자 본인 신청 취소/삭제 (대기·불가 상태만)
    if (path === '/api/enrollments' && req.method === 'DELETE') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const id = Number(url.searchParams.get('id'));
      const db = loadEnroll();
      const i = db.requests.findIndex((r) => r.id === id);
      if (i < 0) return sendJson(res, 404, { error: '신청 내역을 찾을 수 없습니다' });
      if (db.requests[i].userEmail !== me.email && me.role !== 'admin') return sendJson(res, 403, { error: '본인 신청만 취소할 수 있습니다' });
      if (db.requests[i].status === 'approved' && me.role !== 'admin') return sendJson(res, 400, { error: '이미 승인된 신청은 취소할 수 없습니다' });
      db.requests.splice(i, 1);
      saveEnroll(db);
      return sendJson(res, 200, { ok: true });
    }
    // 관리자: 전체 신청 목록
    if (path === '/api/admin/enrollments' && req.method === 'GET') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const db = loadEnroll();
      const list = [...db.requests].sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
      const counts = { pending: 0, approved: 0, rejected: 0 };
      for (const r of list) counts[r.status] = (counts[r.status] || 0) + 1;
      return sendJson(res, 200, { requests: list, counts });
    }
    // 관리자: 승인/승인 불가 결정
    if (path === '/api/admin/enrollments/decide' && req.method === 'POST') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const { id, decision, reason } = await readBody(req);
      if (!['approved', 'rejected'].includes(decision)) return sendJson(res, 400, { error: "decision은 'approved' 또는 'rejected' 여야 합니다" });
      const db = loadEnroll();
      const r = db.requests.find((x) => x.id === (Number(id) || id));
      if (!r) return sendJson(res, 404, { error: '신청 내역을 찾을 수 없습니다' });
      r.status = decision;
      r.reason = decision === 'rejected' ? (String(reason || '').slice(0, 300) || null) : null;
      r.decidedAt = new Date().toISOString();
      r.decidedBy = me.email;
      saveEnroll(db);
      return sendJson(res, 200, { ok: true, request: r });
    }

    // ==== 개별학습(사외교육·자격증·학위) 사전신청 → 승인 → 결과보고 → 이수 ====
    const IL_PATH = join(__dirname, 'individual-learning.json');
    const loadIL = () => existsSync(IL_PATH) ? JSON.parse(readFileSync(IL_PATH, 'utf8')) : { seq: 1, records: [] };
    const saveIL = (db) => writeFileSync(IL_PATH, JSON.stringify(db, null, 2));
    const IL_TYPES = ['사외교육', '자격증', '학위'];

    // 사용자 본인 개별학습 목록
    if (path === '/api/individual-learning' && req.method === 'GET') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const db = loadIL();
      const mine = db.records
        .filter((r) => r.userEmail === me.email)
        .sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
      return sendJson(res, 200, { records: mine });
    }
    // 사전신청 등록
    if (path === '/api/individual-learning' && req.method === 'POST') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const b = await readBody(req);
      if (!b.title || !String(b.title).trim()) return sendJson(res, 400, { error: '교육명을 입력해 주세요' });
      const db = loadIL();
      const rec = {
        id: db.seq++,
        ltype: IL_TYPES.includes(b.ltype) ? b.ltype : '사외교육',
        title: String(b.title).trim().slice(0, 200),
        category: String(b.category || '').slice(0, 60),
        org: String(b.org || '').slice(0, 120),          // 교육발령기관
        place: String(b.place || '').slice(0, 120),       // 장소
        startDate: b.startDate || null,
        endDate: b.endDate || null,
        completeDate: b.completeDate || null,             // 수료(취득)일
        hours: Number(b.hours) || 0,                      // 학습인정시간
        cost: Number(b.cost) || 0,                        // 비용
        insurance: String(b.insurance || '해당없음').slice(0, 20), // 교통보험
        content: String(b.content || '').slice(0, 4000),  // 교육내용
        attachment: String(b.attachment || '').slice(0, 200) || null,
        userEmail: me.email, userName: me.name, uuid: me.uuid || null, dept: me.dept || null,
        status: 'in_progress', progress: 0, reason: null, result: null,
        certNo: null, certIssuedAt: null,
        requestedAt: new Date().toISOString(), decidedAt: null, decidedBy: null,
        resultReportedAt: null,
      };
      db.records.push(rec);
      saveIL(db);
      return sendJson(res, 201, { record: rec });
    }
    // 학습률 갱신 (본인, 이수 완료 전만)
    if (path === '/api/individual-learning/progress' && req.method === 'POST') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { id, progress } = await readBody(req);
      const db = loadIL();
      const r = db.records.find((x) => x.id === (Number(id) || id));
      if (!r) return sendJson(res, 404, { error: '개별학습 내역을 찾을 수 없습니다' });
      if (r.userEmail !== me.email) return sendJson(res, 403, { error: '본인 학습만 갱신할 수 있습니다' });
      if (r.status === 'completed') return sendJson(res, 400, { error: '이미 이수 완료된 학습입니다' });
      r.progress = Math.min(100, Math.max(0, Number(progress) || 0));
      saveIL(db);
      return sendJson(res, 200, { record: r });
    }
    // 수료증 발급 (본인, 학습률 100% 필요) → 이수 완료 처리
    if (path === '/api/individual-learning/certificate' && req.method === 'POST') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { id } = await readBody(req);
      const db = loadIL();
      const r = db.records.find((x) => x.id === (Number(id) || id));
      if (!r) return sendJson(res, 404, { error: '개별학습 내역을 찾을 수 없습니다' });
      if (r.userEmail !== me.email) return sendJson(res, 403, { error: '본인 학습만 발급할 수 있습니다' });
      if (r.status === 'completed' && r.certNo) return sendJson(res, 200, { record: r }); // 이미 발급됨
      if ((Number(r.progress) || 0) < 100) return sendJson(res, 400, { error: '학습률 100% 달성 시에만 수료증을 발급할 수 있습니다' });
      r.status = 'completed';
      r.certNo = 'IL-' + new Date().getFullYear() + '-' + String(r.id).padStart(4, '0');
      r.certIssuedAt = new Date().toISOString();
      if (!r.completeDate) r.completeDate = new Date().toISOString().slice(0, 10);
      saveIL(db);
      return sendJson(res, 200, { record: r });
    }
    // 결과보고 제출 (사전 승인된 건만) — 구버전 호환용
    if (path === '/api/individual-learning/result' && req.method === 'POST') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { id, result, attachment, completeDate } = await readBody(req);
      const db = loadIL();
      const r = db.records.find((x) => x.id === (Number(id) || id));
      if (!r) return sendJson(res, 404, { error: '개별학습 내역을 찾을 수 없습니다' });
      if (r.userEmail !== me.email) return sendJson(res, 403, { error: '본인 신청만 보고할 수 있습니다' });
      if (r.status !== 'pre_approved' && r.status !== 'post_rejected') {
        return sendJson(res, 400, { error: '사전 승인된 건만 결과보고할 수 있습니다' });
      }
      if (!result || !String(result).trim()) return sendJson(res, 400, { error: '결과보고 내용을 입력해 주세요' });
      r.result = String(result).trim().slice(0, 4000);
      if (attachment) r.attachment = String(attachment).slice(0, 200);
      if (completeDate) r.completeDate = completeDate;
      r.status = 'post_pending';
      r.reason = null;
      r.resultReportedAt = new Date().toISOString();
      saveIL(db);
      return sendJson(res, 200, { record: r });
    }
    // 사용자 본인 취소/삭제 (사전신청 대기/반려 상태만)
    if (path === '/api/individual-learning' && req.method === 'DELETE') {
      const me = readSession(req);
      if (!me) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const id = Number(url.searchParams.get('id'));
      const db = loadIL();
      const i = db.records.findIndex((r) => r.id === id);
      if (i < 0) return sendJson(res, 404, { error: '개별학습 내역을 찾을 수 없습니다' });
      if (db.records[i].userEmail !== me.email && me.role !== 'admin') return sendJson(res, 403, { error: '본인 신청만 취소할 수 있습니다' });
      const st = db.records[i].status;
      if (st === 'completed' && me.role !== 'admin') {
        return sendJson(res, 400, { error: '이수 완료된 내역은 관리자만 삭제할 수 있습니다' });
      }
      db.records.splice(i, 1);
      saveIL(db);
      return sendJson(res, 200, { ok: true });
    }
    // 관리자: 전체 목록 + 상태 카운트
    if (path === '/api/admin/individual-learning' && req.method === 'GET') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const db = loadIL();
      const list = [...db.records].sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''));
      const counts = {};
      for (const r of list) counts[r.status] = (counts[r.status] || 0) + 1;
      return sendJson(res, 200, { records: list, counts });
    }
    // 관리자: 사전/사후 승인·반려 결정
    if (path === '/api/admin/individual-learning/decide' && req.method === 'POST') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const { id, phase, decision, reason } = await readBody(req);
      if (!['pre', 'post'].includes(phase)) return sendJson(res, 400, { error: "phase는 'pre' 또는 'post' 여야 합니다" });
      if (!['approved', 'rejected'].includes(decision)) return sendJson(res, 400, { error: "decision은 'approved' 또는 'rejected' 여야 합니다" });
      const db = loadIL();
      const r = db.records.find((x) => x.id === (Number(id) || id));
      if (!r) return sendJson(res, 404, { error: '개별학습 내역을 찾을 수 없습니다' });
      r.status = `${phase}_${decision}`;
      r.reason = decision === 'rejected' ? (String(reason || '').slice(0, 300) || null) : null;
      r.decidedAt = new Date().toISOString();
      r.decidedBy = me.email;
      saveIL(db);
      return sendJson(res, 200, { ok: true, record: r });
    }

    // ==== 사내 개설 과정 (강좌 개설 · 학사운영 · 교육이수 관리) ====
    const CC_PATH = join(__dirname, 'custom-courses.json');
    const loadCC = () => existsSync(CC_PATH) ? JSON.parse(readFileSync(CC_PATH, 'utf8')) : { seq: 1, courses: [] };
    const saveCC = (db) => writeFileSync(CC_PATH, JSON.stringify(db, null, 2));
    const RES_TYPES = ['동영상', '집합교육', '설문', '파일등록', '토론', '과제', '외부링크']; // 시험/퀴즈 제외

    // 사용자: 개설 과정 목록 (learners는 본인 것만 노출)
    if (path === '/api/custom-courses' && req.method === 'GET') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const db = loadCC();
      const courses = db.courses.map((c) => ({
        ...c,
        learners: undefined,
        learnerCount: c.learners.length,
        completedCount: c.learners.filter((l) => l.status === '수료').length,
        mine: c.learners.find((l) => l.email === user.email) || null,
      }));
      return sendJson(res, 200, { courses });
    }
    // 사용자: 수강신청 (신청형=즉시 입과, 선발형=신청대기)
    if (path === '/api/custom-courses/apply' && req.method === 'POST') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { courseId } = await readBody(req);
      const db = loadCC();
      const c = db.courses.find((x) => x.id === courseId);
      if (!c) return sendJson(res, 404, { error: '과정을 찾을 수 없습니다' });
      if (c.status !== '운영중') return sendJson(res, 400, { error: '모집 중인 과정이 아닙니다' });
      if (c.learners.some((l) => l.email === user.email)) return sendJson(res, 409, { error: '이미 신청/수강 중인 과정입니다' });
      const learner = {
        email: user.email, name: user.name, uuid: user.uuid || null, dept: user.dept || null,
        status: c.entry === '선발형' ? '신청대기' : '수강중', progress: 0,
        enrolledAt: new Date().toISOString(), completedAt: null, certAt: null,
      };
      c.learners.push(learner); saveCC(db);
      return sendJson(res, 200, { ok: true, status: learner.status });
    }
    // 사용자: 학습 진도 반영 (데모) — 수료 기준 도달 시 자동 수료 + 수료증 발급
    if (path === '/api/custom-courses/progress' && req.method === 'POST') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { courseId, progress } = await readBody(req);
      const db = loadCC();
      const c = db.courses.find((x) => x.id === courseId);
      const l = c && c.learners.find((x) => x.email === user.email);
      if (!l) return sendJson(res, 404, { error: '수강 정보가 없습니다' });
      if (l.status === '신청대기') return sendJson(res, 400, { error: '선발 승인 대기 중입니다' });
      l.progress = Math.max(0, Math.min(100, Number(progress) || 0));
      if (l.progress >= (c.completeRate ?? 80) && l.status !== '수료') {
        l.status = '수료'; l.completedAt = new Date().toISOString(); l.certAt = l.completedAt;
      }
      saveCC(db);
      return sendJson(res, 200, { ok: true, learner: l });
    }
    // 관리자: 과정 목록/생성·수정/삭제
    if (path === '/api/admin/custom-courses') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const db = loadCC();
      if (req.method === 'GET') return sendJson(res, 200, { courses: db.courses, resTypes: RES_TYPES });
      if (req.method === 'POST') {
        const { course } = await readBody(req);
        if (!course || !course.title) return sendJson(res, 400, { error: '과정 제목은 필수입니다' });
        course.resources = (course.resources || []).filter((r) => RES_TYPES.includes(r.type) && r.title);
        const now = new Date().toISOString();
        if (course.id) { // 수정 (learners는 기존 것 유지)
          const i = db.courses.findIndex((x) => x.id === course.id);
          if (i < 0) return sendJson(res, 404, { error: '과정을 찾을 수 없습니다' });
          db.courses[i] = { ...db.courses[i], ...course, learners: db.courses[i].learners, updatedAt: now };
        } else {
          course.id = 'cc' + db.seq++;
          course.learners = [];
          course.createdBy = me.email; course.createdAt = now; course.updatedAt = now;
          db.courses.unshift(course);
        }
        saveCC(db);
        return sendJson(res, 200, { ok: true, course: db.courses.find((x) => x.id === course.id) });
      }
      if (req.method === 'DELETE') {
        const { id } = await readBody(req);
        const i = db.courses.findIndex((x) => x.id === id);
        if (i < 0) return sendJson(res, 404, { error: '과정을 찾을 수 없습니다' });
        db.courses.splice(i, 1); saveCC(db);
        return sendJson(res, 200, { ok: true });
      }
    }
    // 관리자: 학사운영 — 학습자 등록/선발승인/진도/수료처리/제외/독려
    if (path === '/api/admin/custom-courses/learners' && req.method === 'POST') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const { courseId, action, emails, progress, message } = await readBody(req);
      const db = loadCC();
      const c = db.courses.find((x) => x.id === courseId);
      if (!c) return sendJson(res, 404, { error: '과정을 찾을 수 없습니다' });
      const list = Array.isArray(emails) ? emails : [];
      const now = new Date().toISOString();
      if (action === 'add') {
        let added = 0;
        for (const email of list) {
          if (c.learners.some((l) => l.email === email)) continue;
          const u = userStore.users.find((x) => x.email === email);
          c.learners.push({
            email, name: u?.name || email.split('@')[0], uuid: u?.uuid || null, dept: u?.dept || null,
            status: '수강중', progress: 0, enrolledAt: now, completedAt: null, certAt: null,
          });
          added++;
        }
        saveCC(db);
        return sendJson(res, 200, { ok: true, added });
      }
      if (action === 'remove') {
        c.learners = c.learners.filter((l) => !list.includes(l.email)); saveCC(db);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'approve') { // 선발형 신청대기 → 수강중
        c.learners.forEach((l) => { if (list.includes(l.email) && l.status === '신청대기') l.status = '수강중'; });
        saveCC(db);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'progress') {
        const p = Math.max(0, Math.min(100, Number(progress) || 0));
        c.learners.forEach((l) => { if (list.includes(l.email) && l.status !== '신청대기') l.progress = p; });
        saveCC(db);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'complete') { // 수료 처리 + 수료증 발급
        c.learners.forEach((l) => {
          if (list.includes(l.email) && l.status !== '신청대기') {
            l.status = '수료'; l.progress = Math.max(l.progress, c.completeRate ?? 80);
            l.completedAt = l.completedAt || now; l.certAt = l.certAt || now;
          }
        });
        saveCC(db);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'remind') { // 독려 발송 (리마인드 기록에 남김)
        const targets = c.learners.filter((l) => list.includes(l.email));
        const reminders = loadReminds();
        reminders.push(...targets.map((t) => ({
          name: t.name, email: t.email, uuid: t.uuid,
          message: message || `[${c.title}] 학습을 이어서 진행해 주세요! — 사내교육 독려`,
          sentBy: me.email, sentAt: now, channel: '사내과정 독려(데모 기록)',
        })));
        writeFileSync(REMIND_PATH, JSON.stringify(reminders, null, 2));
        return sendJson(res, 200, { ok: true, sent: targets.length });
      }
      return sendJson(res, 400, { error: '알 수 없는 action 입니다' });
    }

    // ==== 개별학습(사외교육·컨퍼런스) 승인 시스템: 사전신청 → 승인 → 결과보고 → 이수인정 ====
    const APPR_PATH = join(__dirname, 'approvals.json');
    const loadAppr = () => existsSync(APPR_PATH) ? JSON.parse(readFileSync(APPR_PATH, 'utf8')) : { seq: 1, items: [] };
    const saveAppr = (db) => writeFileSync(APPR_PATH, JSON.stringify(db, null, 2));
    const APPR_TYPES = ['사외교육', '컨퍼런스', '자격증', '학위'];

    if (path === '/api/approvals' && req.method === 'GET') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const db = loadAppr();
      return sendJson(res, 200, { items: db.items.filter((i) => i.applicant.email === user.email), types: APPR_TYPES });
    }
    if (path === '/api/approvals' && req.method === 'POST') { // 사전신청 등록
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const b = await readBody(req);
      if (!b.title || !b.type) return sendJson(res, 400, { error: '교육명과 유형은 필수입니다' });
      if (!APPR_TYPES.includes(b.type)) return sendJson(res, 400, { error: '유형은 ' + APPR_TYPES.join('/') + ' 중 하나여야 합니다' });
      const db = loadAppr();
      const item = {
        id: db.seq++,
        type: b.type, title: String(b.title).slice(0, 100), org: b.org || '', place: b.place || '',
        startDate: b.startDate || null, endDate: b.endDate || null,
        hours: Number(b.hours) || 0, cost: Number(b.cost) || 0,
        reason: b.reason || '', attachment: b.attachment || null,
        applicant: { name: user.name, email: user.email, dept: user.dept || null, uuid: user.uuid || null },
        status: '대기', decision: null,   // 사전신청 승인 상태
        report: null,                      // {summary, certFile, submittedAt, status, decision}
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      db.items.unshift(item); saveAppr(db);
      return sendJson(res, 201, { ok: true, item });
    }
    if (path === '/api/approvals/cancel' && req.method === 'POST') {
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { id } = await readBody(req);
      const db = loadAppr();
      const item = db.items.find((i) => i.id === id && i.applicant.email === user.email);
      if (!item) return sendJson(res, 404, { error: '신청 내역을 찾을 수 없습니다' });
      if (item.status !== '대기') return sendJson(res, 400, { error: '대기 상태의 신청만 취소할 수 있습니다' });
      item.status = '취소'; item.updatedAt = new Date().toISOString(); saveAppr(db);
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/api/approvals/report' && req.method === 'POST') { // 결과보고 제출
      const user = readSession(req);
      if (!user) return sendJson(res, 401, { error: '로그인이 필요합니다' });
      const { id, summary, certFile } = await readBody(req);
      const db = loadAppr();
      const item = db.items.find((i) => i.id === id && i.applicant.email === user.email);
      if (!item) return sendJson(res, 404, { error: '신청 내역을 찾을 수 없습니다' });
      if (item.status !== '승인') return sendJson(res, 400, { error: '사전신청이 승인된 건만 결과보고 할 수 있습니다' });
      if (item.report && item.report.status === '승인') return sendJson(res, 400, { error: '이미 이수 인정된 건입니다' });
      item.report = { summary: summary || '', certFile: certFile || null, submittedAt: new Date().toISOString(), status: '대기', decision: null };
      item.updatedAt = new Date().toISOString(); saveAppr(db);
      return sendJson(res, 200, { ok: true, item });
    }
    if (path === '/api/admin/approvals' && req.method === 'GET') {
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const db = loadAppr();
      return sendJson(res, 200, { items: db.items, types: APPR_TYPES });
    }
    if (path === '/api/admin/approvals/decision' && req.method === 'POST') { // 승인/반려 처리
      const me = readSession(req);
      if (!me || me.role !== 'admin') return sendJson(res, 403, { error: '관리자 권한이 필요합니다' });
      const { id, stage, action, comment } = await readBody(req);
      if (!['승인', '반려'].includes(action)) return sendJson(res, 400, { error: 'action은 승인/반려만 가능합니다' });
      const db = loadAppr();
      const item = db.items.find((i) => i.id === id);
      if (!item) return sendJson(res, 404, { error: '신청 내역을 찾을 수 없습니다' });
      const decision = { by: me.email, at: new Date().toISOString(), comment: comment || '' };
      if (stage === 'report') {
        if (!item.report) return sendJson(res, 400, { error: '결과보고가 제출되지 않았습니다' });
        item.report.status = action; item.report.decision = decision;
      } else {
        if (item.status === '취소') return sendJson(res, 400, { error: '취소된 신청입니다' });
        item.status = action; item.decision = decision;
      }
      item.updatedAt = decision.at; saveAppr(db);
      return sendJson(res, 200, { ok: true, item });
    }

    // --- 페이지 라우트: /login, /admin(관리자 전용), 온보딩 플로우 ---
    if (path === '/onboarding') {
      const body = await readFile(join(__dirname, 'public', 'onboarding.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    if (path === '/diagnosis') {
      const body = await readFile(join(__dirname, 'public', 'diagnosis.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    if (path === '/login') {
      const body = await readFile(join(__dirname, 'public', 'login.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    if (path === '/admin') {
      const user = readSession(req);
      if (!user) { res.writeHead(302, { Location: '/login?next=/admin' }); return res.end(); }
      if (user.role !== 'admin') { res.writeHead(302, { Location: '/#/' }); return res.end(); }
      const body = await readFile(join(__dirname, 'public', 'admin.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(body);
    }

    // --- API 라우트 ---
    if (path === '/api/health') {
      const { status, json } = await inflearn('/courses', { pageNumber: 1, pageSize: 1, searchType: 'ALL' });
      return sendJson(res, 200, {
        ok: status === 200 && json.code === 'SUCCESS',
        tokenValid: status === 200 && json.code === 'SUCCESS',
        httpStatus: status, apiCode: json.code, catalogTotal: json.data?.totalCount ?? null,
      });
    }

    if (path === '/api/dashboard') {
      const data = await getDashboard(url.searchParams.get('refresh') === '1');
      return sendJson(res, 200, data);
    }

    if (path === '/api/catalog') {
      const data = await getCatalog(url.searchParams.get('refresh') === '1');
      return sendJson(res, 200, data);
    }

    if (path === '/api/course') {
      const id = url.searchParams.get('id');
      if (!id) return sendJson(res, 400, { error: 'id 파라미터 필요' });
      const course = await getCourse(id);
      if (!course) return sendJson(res, 404, { error: '강의를 찾을 수 없습니다' });
      return sendJson(res, 200, course);
    }

    if (path === '/api/my') {
      const uuid = url.searchParams.get('uuid') || 'es12';
      const data = await getMyLearning(uuid);
      return sendJson(res, 200, data);
    }

    // 원본 엔드포인트 프록시 (문서의 7개 스키마 그대로 전달)
    const proxyMap = {
      '/api/courses': '/courses',
      '/api/learning-history': '/learning-history',
      '/api/progress-by-date': '/progress-by-date',
      '/api/check-enrollment': '/check-enrollment',
      '/api/learning-status-by-units': '/learning-status-by-units',
    };
    if (proxyMap[path]) {
      const params = Object.fromEntries(url.searchParams.entries());
      const { status, json } = await inflearn(proxyMap[path], params);
      return sendJson(res, status, json);
    }

    // --- 정적 파일 ---
    let filePath = path === '/' ? '/index.html' : path;
    filePath = join(__dirname, 'public', filePath.replace(/\.\./g, ''));
    if (existsSync(filePath)) {
      const ext = extname(filePath);
      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return res.end(body);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  } catch (err) {
    console.error('요청 처리 오류:', err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n✅ LMS 대시보드 서버 실행 중`);
  console.log(`   → http://localhost:${PORT}`);
  console.log(`   토큰 인증: Basic ${AUTH_HEADER.slice(6, 16)}... (base64)`);
  console.log(`   Ctrl+C 로 종료\n`);
});
