/* ===== EST family LMS 프론트엔드 (SPA) ===== */
'use strict';

const state = {
  catalog: null,      // {courses, facets, totalCount}
  courseById: new Map(),
  my: null,           // 로그인 사용자 수강정보
  user: null,         // 로그인 계정 {name,email,uuid,role,assessment}
  recConfig: null,    // 추천 설정 (관리자 관리: 강의풀/태그 가중치)
  bookmarks: new Set(JSON.parse(localStorage.getItem('lms_bookmarks') || '[]')),
  recent: JSON.parse(localStorage.getItem('lms_recent') || '[]'),
  timers: [],
};

const $ = (s, r = document) => r.querySelector(s);
const app = () => $('#app');

// ---------- 유틸 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtDur(sec) {
  if (!sec) return '-';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}
function fmtDurShort(sec) {
  if (!sec) return '0분';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}
function priceLabel(p) { return !p ? '무료' : '₩' + p.toLocaleString(); }
function stars(rating) {
  const r = Math.round((rating || 0) * 2) / 2;
  let s = '';
  for (let i = 1; i <= 5; i++) s += i <= r ? '★' : (i - .5 === r ? '⯪' : '☆');
  return s;
}
function saveBookmarks() { localStorage.setItem('lms_bookmarks', JSON.stringify([...state.bookmarks])); }
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 1900);
}
function clearTimers() { state.timers.forEach(clearInterval); state.timers = []; }
function go(hash) { location.hash = hash; }

// ---------- 데이터 로딩 ----------
async function boot() {
  try {
    // 로그인 확인 (미로그인 → 로그인 페이지)
    const meRes = await fetch('/api/auth/me');
    if (meRes.status === 401) { location.href = '/login'; return; }
    state.user = (await meRes.json()).user;

    const uuid = state.user.uuid || 'es12';
    const [cat, my, rec, nt, kw, enr] = await Promise.all([
      fetch('/api/catalog').then((r) => r.json()),
      fetch('/api/my?uuid=' + encodeURIComponent(uuid)).then((r) => r.json()).catch(() => null),
      fetch('/api/rec-config').then((r) => r.json()).catch(() => ({ config: null })),
      fetch('/api/notices').then((r) => r.json()).catch(() => ({ notices: [] })),
      fetch('/api/search-keywords').then((r) => r.json()).catch(() => ({ keywords: [] })),
      fetch('/api/enrollments').then((r) => r.json()).catch(() => ({ requests: [] })),
    ]);
    state.catalog = cat;
    cat.courses.forEach((c) => state.courseById.set(c.id, c));
    state.my = my;
    state.recConfig = rec.config;
    state.notices = nt.notices || [];
    state.searchKeywords = (kw.keywords || []).map((k) => k.keyword).filter(Boolean);
    state.myRequests = enr.requests || [];
    applyHeader();
    initSearchSuggest();
    route();
  } catch (e) {
    app().innerHTML = `<div class="loading-screen"><p>❌ 데이터 로딩 실패: ${esc(e.message)}</p><p class="muted">server.js 가 실행 중인지 확인하세요.</p></div>`;
  }
}

function applyHeader() {
  const u = state.user; if (!u) return;
  const av = $('#hdrAvatar'); if (av) av.textContent = (u.name || 'ME').slice(0, 2);
  const nm = $('#hdrName'); if (nm) nm.textContent = `${u.name} 님 ▾`;
  const isAdmin = u.role === 'admin';
  const adm = $('#navAdmin'); if (adm) adm.style.display = isAdmin ? '' : 'none';
  // 관리자 화면에서는 사용자용 개인 메뉴(내 학습·개별학습·마이페이지)를 숨김
  document.querySelectorAll('.nav [data-page="my"], .nav [data-page="mypage"], .nav [data-page="illearn"]').forEach((el) => { el.style.display = isAdmin ? 'none' : ''; });
  const chip = $('.profile-chip'); if (chip) chip.setAttribute('onclick', isAdmin ? "location.href='/admin'" : "go('#/mypage')");
}
window.logout = async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  location.href = '/login';
};

// ---------- 공지사항 편집 (관리자 전용, 사용자 화면에서 바로) ----------
async function saveNotices() {
  const r = await fetch('/api/admin/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notices: state.notices }) });
  if (!r.ok) { toast('저장 실패: ' + ((await r.json()).error || r.status)); return false; }
  toast('공지사항이 저장되었습니다');
  return true;
}
window.addNotice = async () => {
  const t = prompt('공지 내용'); if (!t) return;
  const tag = prompt('분류 (공지/안내/이벤트)', '공지') || '공지';
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  state.notices.unshift({ id: Date.now(), tag, t, d });
  if (await saveNotices()) renderHome();
};
window.editNotice = async (i) => {
  const n = state.notices[i]; if (!n) return;
  const t = prompt('공지 내용 수정', n.t); if (t === null) return;
  const tag = prompt('분류 수정 (공지/안내/이벤트)', n.tag); if (tag === null) return;
  n.t = t || n.t; n.tag = tag || n.tag;
  if (await saveNotices()) renderHome();
};
window.delNotice2 = async (i) => {
  if (!confirm('이 공지를 삭제할까요?')) return;
  state.notices.splice(i, 1);
  if (await saveNotices()) renderHome();
};

// ---------- 역량진단 결과 + 맞춤 추천 (관리자 rec-config 기반) ----------
function getDiagnosis() {
  if (state.user?.assessment) return state.user.assessment;
  try { return JSON.parse(localStorage.getItem('lms_diagnosis') || 'null'); } catch { return null; }
}
// 약점 역량의 태그 가중치 맵 (검색 스코어 부스트에 사용)
function weakTagWeights() {
  const cfg = state.recConfig, diag = getDiagnosis();
  if (!cfg || !diag || !diag.weak?.length) return {};
  const w = {};
  for (const k of diag.weak) {
    for (const t of (cfg.compTags?.[k] || [])) {
      w[t] = Math.max(w[t] || 0, cfg.tagWeights?.[t] ?? 1);
    }
  }
  return w;
}
// 역량 × 난이도 매트릭스 + 폴백 규칙으로 추천 산출
function recommendCourses() {
  const cfg = state.recConfig, diag = getDiagnosis();
  if (!cfg || !diag) return null;
  const weak = (diag.weak || []).slice().sort((a, b) => (diag.avg?.[a] ?? 5) - (diag.avg?.[b] ?? 5));
  const tier = diag.tier === '중급이상' || diag.level === '중급' ? '중급이상' : diag.level;
  const nondev = diag.job === 'nondev';
  // 약점 없음 → 추천풀 전체에서 유지·확장 추천 (중급 판정자는 심화 트랙 안내 + 초급 보강 우선)
  if (!weak.length) {
    const notes = [];
    if (tier === '중급이상') notes.push(cfg.rules?.midTierDeepTrack || '심화 트랙 — 인프런 중급+ 강의 개설·안내');
    notes.push('약점(3.5 미만) 역량이 없습니다 — 추천풀에서 역량 유지·확장 강의를 안내합니다.');
    const items = cfg.pool.slice()
      .sort((a, b) => (tier === '중급이상' ? ((b.lv === '초급') - (a.lv === '초급')) : 0) || (b.weight || 0) - (a.weight || 0))
      .slice(0, 8)
      .map((c) => ({ ...c, comp: c.comp[0], why: tier === '중급이상' ? '심화 트랙 전 보강' : '역량 유지·확장' }));
    return { level: diag.level, tier, items, notes };
  }
  const seen = new Set(); const items = []; const notes = [];
  const pick = (list, k, why) => {
    list.slice().sort((a, b) => (nondev ? (b.nd ? 1 : 0) - (a.nd ? 1 : 0) : 0) || (b.weight || 0) - (a.weight || 0))
      .forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); items.push({ ...c, comp: k, why }); } });
  };
  for (const k of weak) {
    const cname = cfg.comps?.[k] || k;
    if (tier === '중급이상') {
      notes.push(`${k} ${cname}: ${cfg.rules?.midTierDeepTrack || '심화 트랙 안내'}`);
      pick(cfg.pool.filter((c) => c.comp.includes(k) && c.lv === '초급'), k, '심화 전 보강(초급)');
      continue;
    }
    let list = cfg.pool.filter((c) => c.comp.includes(k) && c.lv === tier);
    if (list.length) { pick(list, k, `${cname} 약점 · ${tier}`); continue; }
    // 폴백 ⓐ 한 단계 아래 난이도
    if (tier === '초급') {
      const alt = cfg.pool.filter((c) => c.comp.includes(k) && c.lv === '입문');
      if (alt.length) { pick(alt, k, `${cname} 약점 · 초급 공백 → 입문 하향`); notes.push(`${k} ${cname}: ${cfg.rules?.efIntermediateGap || '초급 공백 → 입문 하향 대체'}`); continue; }
    }
    // 폴백 ⓑ V 입문 공백 → E·F 기초 먼저
    if (tier === '입문' && k === 'V') {
      notes.push(`V ${cname}: ${cfg.rules?.vBeginnerGap || 'V 입문 공백 → E·F 기초 먼저'}`);
      pick(cfg.pool.filter((c) => (c.comp.includes('E') || c.comp.includes('F')) && c.lv === '입문'), k, 'V 대비 기초(E·F)');
      continue;
    }
    notes.push(`${k} ${cname}: 현 난이도(${tier}) 직접 매핑 강의 없음 → 인접 난이도로 대체`);
    pick(cfg.pool.filter((c) => c.comp.includes(k)), k, `${cname} 약점 · 인접 난이도`);
  }
  return { level: diag.level, tier, items: items.slice(0, 8), notes };
}
// 검색서비스 상단 맞춤 추천 배너
function recBannerHtml() {
  const rec = recommendCourses(); const diag = getDiagnosis();
  if (!diag) {
    return `<div class="rec-banner empty"><div class="rb-head">✨ AI 역량진단을 아직 하지 않으셨어요</div>
      <div class="rb-sub">진단을 완료하면 약점 역량·난이도에 맞는 강의를 여기서 추천해 드립니다.</div>
      <a class="mini-btn" href="/diagnosis">🧭 역량진단 하러 가기</a></div>`;
  }
  if (!rec || !rec.items.length) {
    return `<div class="rec-banner"><div class="rb-head">🎉 ${esc(state.user?.name || '')}님, 약점 역량이 없습니다 (레벨 ${esc(diag.level)})</div>
      <div class="rb-sub">${rec?.notes?.map(esc).join(' · ') || '심화 트랙으로 확장을 고려하세요.'}</div></div>`;
  }
  const cards = rec.items.map((it) => {
    const c = state.courseById.get(it.id);
    const compName = state.recConfig?.comps?.[it.comp] || it.comp;
    return `<div class="rb-card" onclick="go('#/course/${it.id}')">
      <img loading="lazy" src="${esc(c?.thumbnailUrl || '')}" onerror="this.style.opacity=0">
      <div class="rb-body">
        <span class="rb-tag">${esc(it.comp)} ${esc(compName)} · ${esc(it.lv)}</span>
        <div class="rb-title">${esc(c?.title || it.title)}</div>
        <div class="rb-why">${esc(it.why)}${it.indirect ? ' · 간접' : ''}</div>
      </div></div>`;
  }).join('');
  return `<div class="rec-banner">
    <div class="rb-head">✨ ${esc(state.user?.name || '')}님 역량진단 맞춤 추천 <span class="rb-lv">레벨 ${esc(rec.level)} · 약점 ${(getDiagnosis().weak || []).join('·') || '없음'}</span>
      <a class="rb-redo" href="/diagnosis">진단 다시 하기 ↻</a></div>
    <div class="rb-rail">${cards}</div>
    ${rec.notes.length ? `<div class="rb-notes">${rec.notes.map((n) => `<div>· ${esc(n)}</div>`).join('')}</div>` : ''}
  </div>`;
}

// 수강정보를 카탈로그와 조인 (썸네일/런타임 보강)
function myEnrollments() {
  const base = (state.my?.enrollments || []).map((e) => {
    const c = state.courseById.get(e.courseId);
    return { ...e, thumbnailUrl: c?.thumbnailUrl, runtime: c?.runtime || 0, catTitle: c?.title };
  });
  // 관리자 승인된 수강신청 → 아직 실데이터에 없는 강의는 '학습 중(0%)'으로 병합
  const have = new Set(base.map((e) => String(e.courseId)));
  const approved = (state.myRequests || []).filter((r) => r.status === 'approved' && !have.has(String(r.courseId)));
  const extra = approved.map((r) => {
    const c = state.courseById.get(r.courseId);
    const started = r.decidedAt || r.requestedAt || null;
    return {
      id: 'req-' + r.id, courseId: r.courseId,
      courseTitle: r.courseTitle || c?.title || `강의 #${r.courseId}`,
      catTitle: c?.title, thumbnailUrl: c?.thumbnailUrl || r.thumbnailUrl || '',
      runtime: c?.runtime || 0, progressRate: 0, completed: false,
      createdAt: started, learningStartedAt: started, latestAccessedAt: null,
      courseCompletedAt: null, certificateUrl: null, expiredAt: null, justApproved: true,
    };
  });
  return [...extra, ...base];
}
// 병합된 수강목록 기준 통계 (승인 신청 반영)
function myStats(enr) {
  const completed = enr.filter((e) => e.completed).length;
  const inProgress = enr.filter((e) => !e.completed && (e.progressRate > 0 || e.justApproved)).length;
  return {
    ...(state.my?.stats || {}),
    enrollments: enr.length,
    completed,
    inProgress,
    certificates: enr.filter((e) => e.certificateUrl).length,
    avgProgress: enr.length ? +(enr.reduce((s, e) => s + (e.progressRate || 0), 0) / enr.length).toFixed(1) : 0,
  };
}
// 진행 중(학습 중) 판정 — 승인 직후(0%)도 포함
function isInProgress(e) { return !e.completed && (e.progressRate > 0 || e.justApproved); }

// ---------- 강의 카드 ----------
function courseCard(c, opts = {}) {
  const bm = state.bookmarks.has(c.id);
  const badge = opts.badge === 'new' ? '<span class="badge-new">NEW</span>'
    : opts.badge === 'pick' ? '<span class="badge-pick">PICK</span>' : '';
  return `<div class="card" onclick="go('#/course/${c.id}')">
    <div class="thumb-wrap">
      ${badge}
      <img loading="lazy" src="${esc(c.thumbnailUrl || '')}" alt="" onerror="this.style.opacity=0">
      <button class="bookmark ${bm ? 'on' : ''}" title="관심강의 저장" onclick="event.stopPropagation();toggleBookmark(${c.id},this)">${bm ? '★' : '☆'}</button>
    </div>
    <div class="info">
      <div class="c-title">${esc(c.title)}</div>
      <div class="c-inst">${esc(c.instructorName || '')}</div>
      <div class="c-tags">${(c.skillTags || []).slice(0, 3).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      <div class="c-meta">
        <span class="rate">★ ${(c.rating || 0).toFixed(1)}</span>
        <span>·</span><span>${(c.studentCount || 0).toLocaleString()}명</span>
        ${c.level ? `<span class="lv">${esc(c.level)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

window.toggleBookmark = (id, btn) => {
  if (state.bookmarks.has(id)) { state.bookmarks.delete(id); toast('관심강의에서 제거했어요'); }
  else { state.bookmarks.add(id); toast('관심강의에 저장했어요 ★'); }
  saveBookmarks();
  if (btn) { const on = state.bookmarks.has(id); btn.classList.toggle('on', on); btn.textContent = on ? '★' : '☆'; }
};

function carousel(id, cards) {
  return `<div class="carousel">
    <button class="rail-btn left" onclick="railScroll('${id}',-1)">‹</button>
    <div class="rail" id="${id}">${cards.join('')}</div>
    <button class="rail-btn right" onclick="railScroll('${id}',1)">›</button>
  </div>`;
}
window.railScroll = (id, dir) => { const el = $('#' + id); if (el) el.scrollBy({ left: dir * 720, behavior: 'smooth' }); };

// ---------- 헤더 활성화 ----------
function setNav(page) {
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page));
}

// ================= 홈 =================
function renderHome() {
  setNav('home');
  const cat = state.catalog;
  const courses = cat.courses;
  const my = state.my?.stats || { enrollments: 0, completed: 0, inProgress: 0 };
  const myEnr = myEnrollments();

  // 이어서 보기: 진행 중 + 최근 학습
  const cont = myEnr.filter((e) => !e.completed && e.progressRate > 0)
    .sort((a, b) => (b.latestAccessedAt || '').localeCompare(a.latestAccessedAt || ''))[0]
    || myEnr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];

  // 수강시간 합계(진도 반영)
  const totalSec = myEnr.reduce((s, e) => s + (e.runtime || 0) * (e.progressRate / 100), 0);

  const fresh = [...courses].sort((a, b) => (b.publishedDate || '').localeCompare(a.publishedDate || '')).slice(0, 12);
  const top = [...courses].sort((a, b) => b.studentCount - a.studentCount).slice(0, 12);
  const topTags = cat.facets.tags.slice(0, 20);

  const notices = state.notices || [];
  const isAdmin = state.user?.role === 'admin';

  app().innerHTML = `<div class="wrap">
    <div class="hero">
      <div>
        <div class="hero-title">지금 만나는 지식이<br>내일을 바꿔줄 거예요! ☀️</div>
        <div class="stat-chips">
          <div class="stat-chip"><div class="k">수강 중인 강의 <span class="badge">진행</span></div><div class="v num">${my.inProgress}<small> 개</small></div></div>
          <div class="stat-chip"><div class="k">수료한 강의 <span class="badge">완료</span></div><div class="v num">${my.completed}<small> 개</small></div></div>
          <div class="stat-chip"><div class="k">총 수강 강의</div><div class="v num">${my.enrollments}<small> 개</small></div></div>
          <div class="stat-chip"><div class="k">누적 수강시간</div><div class="v num">${fmtDurShort(totalSec)}</div></div>
        </div>
      </div>
      <div class="notice">
        <h3>공지사항 ${isAdmin ? '<a onclick="addNotice()" style="cursor:pointer;color:#4f7cff;font-weight:700">＋ 추가</a>' : '<a href="#">전체보기</a>'}</h3>
        <ul>${notices.map((n, i) => `<li><span class="tag">${esc(n.tag)}</span><span class="txt">${esc(n.t)}</span><span class="date">${esc(n.d)}</span>${isAdmin ? `<span style="white-space:nowrap;margin-left:6px"><a onclick="editNotice(${i})" style="cursor:pointer;font-size:11px;color:#4f7cff">수정</a> <a onclick="delNotice2(${i})" style="cursor:pointer;font-size:11px;color:#e5484d">삭제</a></span>` : ''}</li>`).join('')}</ul>
      </div>
    </div>

    ${recBannerHtml()}

    ${cont ? `<div class="continue-card">
      <img class="thumb" src="${esc(cont.thumbnailUrl || '')}" onerror="this.style.opacity=0">
      <div class="body">
        <div class="lbl">최근 수강 강의</div>
        <div class="t">${esc(cont.catTitle || cont.courseTitle)}</div>
        <div class="progress"><span style="width:${cont.progressRate}%"></span></div>
        <div class="meta"><span>진도율 ${cont.progressRate.toFixed(1)}%</span><span>최근 학습 ${cont.latestAccessedAt || '-'}</span></div>
      </div>
      <button class="cta" onclick="go('#/learn/${cont.courseId}')">▶ 이어서 보기</button>
    </div>` : ''}

    <div class="section"><div class="section-head"><h2>새롭게 들어온 강의</h2><a onclick="go('#/courses')">전체보기 ›</a></div>
      ${carousel('rail-new', fresh.map((c) => courseCard(c, { badge: 'new' })))}</div>

    <div class="section"><div class="section-head"><h2>Top 수강 강의 🔥</h2><a onclick="go('#/courses')">전체보기 ›</a></div>
      ${carousel('rail-top', top.map((c) => courseCard(c)))}</div>

    <div class="section"><div class="section-head"><h2>태그로 강의 찾기</h2></div>
      <div class="tag-cloud">${topTags.map((t) => `<a class="tag-chip" onclick="go('#/courses?tag=${encodeURIComponent(t.name)}')">${esc(t.name)}<small>${t.count}</small></a>`).join('')}</div>
    </div>
  </div>`;
}

// ================= 카테고리 바 (인프런 스타일 검색/필터/카테고리 네비) =================
const CAT_ICONS = { 'AI 기술': '🧠', 'AI 활용': '🤖', '개발': '💻', '게임': '🎮', '데이터': '📊', '보안': '🛡️', '하드웨어': '🔧', '디자인': '🎨', '기획': '📈', '외국어': '🗣️', '업무 생산성': '🗂️', '커리어': '🧭', '대학': '🎓' };
function catIcon(name) { for (const k in CAT_ICONS) if (name.includes(k)) return CAT_ICONS[k]; return '📚'; }
function categoryBar() {
  const cats = state.catalog.facets.categories;
  const chips = [
    { id: 'ai', label: 'AI 활용', ic: '🤖' },
    { id: 'beginner', label: '왕초보', ic: '👶' },
    { id: 'mit', label: 'MIT opencourse', ic: '🎓' },
    { id: 'free', label: '무료', ic: '🎁' },
    { id: 'cert', label: '수료증', ic: '🏅' },
    { id: 'price', label: '가격순', ic: '💰' },
    { id: 'time', label: '강의 시간', ic: '⏱' },
  ];
  // 역량 칩: 진단 약점 + E/V/O/F (rec-config의 역량→태그 매핑 기반)
  const diag = getDiagnosis();
  const compChips = [];
  if (diag?.weak?.length) compChips.push({ id: 'comp-weak', label: `내 약점 역량 (${diag.weak.join('·')})`, ic: '🧭' });
  for (const [k, name] of Object.entries(state.recConfig?.comps || {})) {
    compChips.push({ id: 'comp-' + k, label: `${k} ${name}`, ic: { E: '⚡', V: '🔁', O: '🕹', F: '🤝' }[k] || '✨' });
  }
  return `<div class="cat-bar">
    ${coursesView.q ? `<div class="search-active">🔍 "<b>${esc(coursesView.q)}</b>" 검색 결과 <button onclick="clearCourseSearch()">✕ 검색 해제</button></div>` : ''}
    <div class="quick-chips">
      ${chips.map((c) => `<button class="quick-chip ${coursesView.quick === c.id ? 'on' : ''}" onclick="quickFilter('${c.id}')"><span>${c.ic}</span>${esc(c.label)}</button>`).join('')}
    </div>
    ${compChips.length ? `<div class="quick-chips" style="margin-top:6px">
      <span style="font-size:12px;font-weight:700;color:#8b93a1;align-self:center;margin-right:2px">역량별 추천</span>
      ${compChips.map((c) => `<button class="quick-chip comp ${coursesView.quick === c.id ? 'on' : ''}" onclick="quickFilter('${c.id}')"><span>${c.ic}</span>${esc(c.label)}</button>`).join('')}
    </div>` : ''}
    ${(state.searchKeywords || []).length ? `<div class="quick-chips" style="margin-top:6px">
      <span style="font-size:12px;font-weight:700;color:#8b93a1;align-self:center;margin-right:2px">🔥 추천 검색어</span>
      ${state.searchKeywords.map((k) => `<button class="quick-chip kw ${coursesView.q === k ? 'on' : ''}" onclick="searchKeyword('${esc(k).replace(/'/g, "\\'")}')">${esc(k)}</button>`).join('')}
    </div>` : ''}
    <div class="cat-nav">
      <button class="cat-item ${!coursesView.cat ? 'on' : ''}" onclick="pickCat(null)"><span class="cic">📚</span>전체</button>
      ${cats.map((c) => `<button class="cat-item ${coursesView.cat === c.name ? 'on' : ''}" onclick="pickCat('${esc(c.name).replace(/'/g, "\\'")}')"><span class="cic">${catIcon(c.name)}</span>${esc(c.name.replace(/ · /g, '·'))}</button>`).join('')}
    </div>
  </div>`;
}
window.pickCat = (name) => { coursesView.cat = name; coursesView.limit = 40; drawCourses(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
window.quickFilter = (id) => {
  coursesView.quick = coursesView.quick === id ? null : id;
  coursesView.limit = 40;
  // 정렬형 칩은 sort 로만 반영
  if (id === 'price') coursesView.sort = coursesView.quick ? 'price' : 'popular';
  if (id === 'time') coursesView.sort = coursesView.quick ? 'time' : 'popular';
  drawCourses();
};
window.clearCourseSearch = () => {
  coursesView.q = ''; coursesView.limit = 40;
  const hs = $('#hdrSearch'); if (hs) hs.value = '';
  drawCourses();
};

// ================= 전체강의 =================
const coursesView = { limit: 40, cat: null, level: null, tag: null, sort: 'popular', q: '', quick: null, rating: null, time: null, cert: null, price: null };
// 학습시간 필터 구간 (초 단위)
const TIME_RANGES = { u2: [0, 7200], '2-5': [7200, 18000], '5-10': [18000, 36000], '10+': [36000, Infinity] };
function renderCourses(params) {
  setNav('courses');
  coursesView.tag = params.get('tag') || null;
  coursesView.cat = params.get('cat') || null;
  coursesView.q = params.get('q') || '';
  coursesView.quick = null; coursesView.level = null;
  coursesView.rating = null; coursesView.time = null; coursesView.cert = null; coursesView.price = null;
  coursesView.limit = 40;
  drawCourses();
}
function filteredCourses() {
  let list = state.catalog.courses;
  if (coursesView.cat) list = list.filter((c) => c.mainCategory === coursesView.cat);
  if (coursesView.level) list = list.filter((c) => c.level === coursesView.level);
  if (coursesView.tag) list = list.filter((c) => c.skillTags.includes(coursesView.tag));
  // 검색 필터 바 (평점·학습시간·수료증·가격)
  if (coursesView.rating) list = list.filter((c) => (c.rating || 0) >= coursesView.rating);
  if (coursesView.time && TIME_RANGES[coursesView.time]) {
    const [min, max] = TIME_RANGES[coursesView.time];
    list = list.filter((c) => (c.runtime || 0) >= min && (c.runtime || 0) < max);
  }
  if (coursesView.cert === 'y') list = list.filter((c) => c.isCertificateIssuable);
  if (coursesView.cert === 'n') list = list.filter((c) => !c.isCertificateIssuable);
  if (coursesView.price === 'free') list = list.filter((c) => !c.regularPrice);
  if (coursesView.price === 'paid') list = list.filter((c) => c.regularPrice > 0);
  // 빠른 필터 칩
  const qk = coursesView.quick;
  if (qk === 'ai') list = list.filter((c) => c.mainCategory === 'AI 기술' || c.skillTags.some((t) => /AI|ChatGPT|LLM|생성형/i.test(t)));
  if (qk === 'beginner') list = list.filter((c) => c.level === '입문');
  if (qk === 'mit') list = list.filter((c) => c.skillTags.includes('MIT'));
  if (qk === 'free') list = list.filter((c) => !c.regularPrice);
  if (qk === 'cert') list = list.filter((c) => c.isCertificateIssuable);
  // 역량 칩: rec-config 역량→태그 매핑에 걸리는 강의만 + 태그 가중치·매칭 수 순 정렬
  if (qk && qk.startsWith('comp-')) {
    const cfg = state.recConfig || {};
    const comps = qk === 'comp-weak' ? (getDiagnosis()?.weak || []) : [qk.slice(5)];
    const tagSet = {};
    for (const k of comps) for (const t of (cfg.compTags?.[k] || [])) tagSet[t] = Math.max(tagSet[t] || 0, cfg.tagWeights?.[t] ?? 1);
    const scoreOf = (c) => c.skillTags.reduce((s, t) => s + (tagSet[t] || 0), 0);
    list = list.filter((c) => scoreOf(c) > 0)
      .map((c) => ({ c, s: scoreOf(c) }))
      .sort((a, b) => b.s - a.s || b.c.studentCount - a.c.studentCount)
      .map((x) => x.c);
    return list; // 역량 정렬 유지 (아래 일반 정렬 건너뜀)
  }
  if (coursesView.q) { const q = coursesView.q.toLowerCase(); list = list.filter((c) => c.title.toLowerCase().includes(q) || c.skillTags.some((t) => t.toLowerCase().includes(q)) || (c.instructorName || '').toLowerCase().includes(q)); }
  const s = coursesView.sort;
  list = [...list].sort((a, b) =>
    s === 'popular' ? b.studentCount - a.studentCount :
    s === 'rating' ? b.rating - a.rating :
    s === 'new' ? (b.publishedDate || '').localeCompare(a.publishedDate || '') :
    s === 'reviews' ? b.reviewCount - a.reviewCount :
    s === 'price' ? (a.regularPrice || 0) - (b.regularPrice || 0) :
    s === 'time' ? (b.runtime || 0) - (a.runtime || 0) : 0);
  return list;
}
// 검색 필터 바 — 학습자료 탐색을 돕는 다양한 검색 필터 (난이도·평점·학습시간·수료증·가격·태그)
function searchFilterBar() {
  const cat = state.catalog;
  const v = coursesView;
  const opt = (val, label, cur) => `<option value="${esc(val)}" ${String(cur ?? '') === String(val) ? 'selected' : ''}>${esc(label)}</option>`;
  const hasFilter = v.level || v.rating || v.time || v.cert || v.price || v.tag;
  return `<div class="sf-bar">
    <select onchange="setSF('level', this.value||null)">
      ${opt('', '난이도 · 전체', v.level)}
      ${cat.facets.levels.map((l) => opt(l.name, `${l.name} (${l.count})`, v.level)).join('')}
    </select>
    <select onchange="setSF('rating', this.value?Number(this.value):null)">
      ${opt('', '평점 · 전체', v.rating)}${opt(4.5, '★ 4.5 이상', v.rating)}${opt(4, '★ 4.0 이상', v.rating)}${opt(3.5, '★ 3.5 이상', v.rating)}
    </select>
    <select onchange="setSF('time', this.value||null)">
      ${opt('', '학습시간 · 전체', v.time)}${opt('u2', '2시간 미만', v.time)}${opt('2-5', '2~5시간', v.time)}${opt('5-10', '5~10시간', v.time)}${opt('10+', '10시간 이상', v.time)}
    </select>
    <select onchange="setSF('cert', this.value||null)">
      ${opt('', '수료증 · 전체', v.cert)}${opt('y', '수료증 제공', v.cert)}${opt('n', '수료증 미제공', v.cert)}
    </select>
    <select onchange="setSF('price', this.value||null)">
      ${opt('', '가격 · 전체', v.price)}${opt('free', '무료', v.price)}${opt('paid', '유료', v.price)}
    </select>
    <select onchange="setSF('tag', this.value||null)">
      ${opt('', '인기 태그 · 전체', v.tag)}
      ${cat.facets.tags.slice(0, 30).map((t) => opt(t.name, `${t.name} (${t.count})`, v.tag)).join('')}
    </select>
    ${hasFilter ? `<button class="sf-reset" onclick="resetSF()">↺ 필터 초기화</button>` : ''}
  </div>`;
}
window.setSF = (key, val) => { coursesView[key] = val; coursesView.limit = 40; drawCourses(); };
window.resetSF = () => {
  Object.assign(coursesView, { level: null, rating: null, time: null, cert: null, price: null, tag: null });
  coursesView.limit = 40; drawCourses();
};
window.searchKeyword = (k) => {
  saveRecent(k);
  coursesView.q = coursesView.q === k ? '' : k;
  coursesView.limit = 40; drawCourses();
};
function drawCourses() {
  const list = filteredCourses();
  const shown = list.slice(0, coursesView.limit);
  const hs = $('#hdrSearch'); if (hs && hs.value !== coursesView.q) hs.value = coursesView.q;
  app().innerHTML = `<div class="wrap">
    ${categoryBar()}
    ${searchFilterBar()}
    <div class="list-toolbar">
      <div class="count">${coursesView.tag ? `#${esc(coursesView.tag)} · ` : ''}${coursesView.cat ? `${esc(coursesView.cat)} · ` : ''}총 <b>${list.length.toLocaleString()}</b>개의 학습자료</div>
      <select onchange="coursesView.sort=this.value;drawCourses()">
        <option value="popular" ${coursesView.sort === 'popular' ? 'selected' : ''}>수강생 많은순</option>
        <option value="rating" ${coursesView.sort === 'rating' ? 'selected' : ''}>평점 높은순</option>
        <option value="reviews" ${coursesView.sort === 'reviews' ? 'selected' : ''}>리뷰 많은순</option>
        <option value="new" ${coursesView.sort === 'new' ? 'selected' : ''}>최신순</option>
        <option value="price" ${coursesView.sort === 'price' ? 'selected' : ''}>가격 낮은순</option>
        <option value="time" ${coursesView.sort === 'time' ? 'selected' : ''}>학습시간 긴순</option>
      </select>
    </div>
    <div class="grid">${shown.map((c) => courseCard(c)).join('')}</div>
    ${list.length > coursesView.limit ? `<button class="more-btn" onclick="coursesView.limit+=40;drawCourses()">더 보기 (${(list.length - coursesView.limit).toLocaleString()}개 남음)</button>` : ''}
  </div>`;
}

// ================= 자연어 검색 =================
const SUGGESTED = [
  '실무에 바로 쓸 수 있는 파이썬 데이터 분석을 배우고 싶어요',
  '프론트엔드 개발자에게 필요한 최신 React 강의가 뭐가 있을까요?',
  '업무 자동화를 위한 n8n, RPA 강의를 추천해줘',
  'ChatGPT와 생성형 AI를 실무에 활용하는 방법을 배우고 싶어요',
  '비개발자를 위한 SQL 데이터 분석 입문 강의 있을까요?',
  '쿠버네티스와 도커로 배포 자동화를 배우고 싶어요',
  '엑셀 데이터 분석 실무 스킬을 키우고 싶어요',
  '설득력을 높이는 비즈니스 커뮤니케이션 강의를 찾고 있어요',
];
const searchView = { q: '', results: null, filter: '전체' };

function renderSearch(params) {
  setNav('search');
  searchView.q = params.get('q') || '';
  drawSearch();
  if (searchView.q) doSearch(searchView.q, true);
}
function drawSearch() {
  const pick = [...SUGGESTED].sort(() => 0.5 - Math.random()).slice(0, 4);
  app().innerHTML = `<div class="wrap"><div class="search-page">
    <div class="search-hero"><h1>무엇이든 물어보세요 🔍</h1><p>ChatGPT에게 질문하듯, 원하는 학습을 자연어로 설명해 주세요.</p></div>
    ${recBannerHtml()}
    <div class="nl-box">
      <textarea id="nlInput" placeholder="예) 나는 백엔드 개발자로 3년 일했어. AI 시대에 필요한 기술을 배우고 싶은데 추천해줄래?">${esc(searchView.q)}</textarea>
      <div class="row">
        <button class="clear" onclick="$('#nlInput').value='';$('#nlInput').focus()">내용 지우기</button>
        <button class="nl-send" onclick="doSearch($('#nlInput').value)">→</button>
      </div>
    </div>
    ${state.recent.length ? `<div class="recent">${state.recent.map((r, i) => `<span class="chip"><a onclick="doSearch(${JSON.stringify(r).replace(/"/g, '&quot;')})">${esc(r)}</a><button onclick="removeRecent(${i})">✕</button></span>`).join('')}</div>` : ''}
    <div class="suggest">
      <div class="h"><span>이런 질문은 어떠신가요?</span><button onclick="drawSearch()">다른 질문 불러오기 ↻</button></div>
      <div class="suggest-grid">${pick.map((s) => `<div class="suggest-card" onclick="doSearch(${JSON.stringify(s).replace(/"/g, '&quot;')})"><span>${esc(s)}</span><span>→</span></div>`).join('')}</div>
    </div>
    <div id="searchResults"></div>
  </div></div>`;
  const ta = $('#nlInput');
  if (ta) ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) doSearch(ta.value); });
}

const STOP = new Set(['그리고', '싶어요', '싶은데', '있을까요', '있을', '뭐가', '무엇을', '어떤', '위한', '위해', '나는', '내가', '너무', '정말', '강의', '강좌', '추천', '추천해줘', '추천해줄래', '배우고', '배우는', '알려줘', '해줘', '실무에', '바로', '것', '수', '을', '를', '이', '가', '은', '는', 'for', 'the', 'to', 'a', 'and', 'me', 'i']);
function tokenize(q) {
  return q.toLowerCase().replace(/[?!.,]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}
window.doSearch = (q, skipPush) => {
  q = (q || '').trim();
  if (!q) return;
  searchView.q = q; searchView.filter = '전체';
  // 최근검색 저장
  state.recent = [q, ...state.recent.filter((r) => r !== q)].slice(0, 6);
  localStorage.setItem('lms_recent', JSON.stringify(state.recent));
  if (!skipPush && location.hash.indexOf('#/search') !== 0) { go('#/search?q=' + encodeURIComponent(q)); return; }

  const toks = tokenize(q);
  const wtags = weakTagWeights(); // 진단 약점 역량 태그 → 가중치 부스트 (관리자 rec-config)
  const scored = state.catalog.courses.map((c) => {
    const title = c.title.toLowerCase(), desc = (c.description || '').toLowerCase();
    const tags = c.skillTags.map((t) => t.toLowerCase()).join(' ');
    const cat = (c.mainCategory + ' ' + c.subCategory).toLowerCase();
    const inst = (c.instructorName || '').toLowerCase();
    let score = 0;
    for (const t of toks) {
      if (title.includes(t)) score += 6;
      if (tags.includes(t)) score += 5;
      if (cat.includes(t)) score += 3;
      if (inst.includes(t)) score += 2;
      if (desc.includes(t)) score += 1;
    }
    score += Math.min(3, c.studentCount / 5000); // 인기 가중
    let boost = 0;
    for (const t of c.skillTags) if (wtags[t]) boost += wtags[t]; // 진단 결과 태그 가중
    return { c, score, boost };
  }).filter((x) => x.score >= 3).sort((a, b) => (b.score + b.boost) - (a.score + a.boost)).slice(0, 60).map((x) => x.c);

  searchView.results = scored;
  if (location.hash.indexOf('#/search') !== 0) { drawSearch(); }
  drawResults();
};
window.removeRecent = (i) => { state.recent.splice(i, 1); localStorage.setItem('lms_recent', JSON.stringify(state.recent)); drawSearch(); if (searchView.q) drawResults(); };

function drawResults() {
  const box = $('#searchResults'); if (!box) return;
  const res = searchView.results || [];
  if (!res.length) { box.innerHTML = `<div class="empty-box" style="margin-top:24px">"${esc(searchView.q)}"에 대한 결과가 없어요. 다른 키워드로 검색해 보세요.</div>`; return; }
  // 카테고리 기반 필터 탭
  const cats = ['전체', ...[...new Set(res.map((c) => c.mainCategory))].slice(0, 5)];
  const filtered = searchView.filter === '전체' ? res : res.filter((c) => c.mainCategory === searchView.filter);
  box.innerHTML = `
    <div class="section-head" style="margin:26px 0 4px"><h2 style="font-size:18px">검색 결과 <span class="muted num">${res.length}</span></h2></div>
    <div class="result-filters">${cats.map((f) => `<span class="f ${searchView.filter === f ? 'on' : ''}" onclick="searchView.filter='${esc(f)}';drawResults()">${esc(f)}</span>`).join('')}</div>
    ${filtered.map((c) => resultItem(c)).join('')}`;
}
function resultItem(c) {
  const bm = state.bookmarks.has(c.id);
  return `<div class="result-item" onclick="go('#/course/${c.id}')">
    <img class="thumb" src="${esc(c.thumbnailUrl || '')}" onerror="this.style.opacity=0">
    <div class="rbody">
      <div class="rt">${esc(c.title)}</div>
      <div class="rd">${esc(c.description || '')}</div>
      <div class="rmeta"><span>${esc(c.instructorName || '')}</span><span>★ ${(c.rating || 0).toFixed(1)}</span><span>${(c.studentCount || 0).toLocaleString()}명 수강</span>${c.level ? `<span>${esc(c.level)}</span>` : ''}</div>
    </div>
    <button class="rbm ${bm ? 'on' : ''}" title="관심강의 저장" onclick="event.stopPropagation();toggleBookmark(${c.id},null);this.classList.toggle('on')">${bm ? '★' : '☆'}</button>
  </div>`;
}

// ================= 강의 상세 =================
async function renderCourseDetail(id) {
  setNav('');
  app().innerHTML = `<div class="loading-screen"><div class="spinner"></div>강의 정보를 불러오는 중…</div>`;
  let course;
  try { course = await fetch('/api/course?id=' + id).then((r) => r.json()); }
  catch { course = null; }
  if (!course || course.error) { app().innerHTML = `<div class="loading-screen">강의를 찾을 수 없어요.</div>`; return; }
  const c = course;
  const lv = (c.level && c.level[0]) ? c.level[0].value : '입문';
  const watching = 30 + (c.id % 400);
  const abilities = splitLines(c.abilities), targets = splitLines(c.targets), based = splitLines(c.based);
  const tabState = { tab: 'intro', course: c };
  window.__course = c;

  app().innerHTML = `
  <div class="detail-top"><div class="detail-top-inner">
    <div>
      <div class="crumb"><a onclick="go('#/courses?cat=${encodeURIComponent(c.mainCategory)}')">${esc(c.mainCategory)}</a> › ${esc(c.subCategory)}</div>
      <h1 class="detail-title">${esc(c.title)}</h1>
      <div class="detail-desc">${esc(c.description || '')}</div>
      <div class="detail-inst">${esc(c.instructorName)} <span class="verified">✔</span></div>
      <div class="watching">👀 <b>${watching}명</b>이 수강하고 있어요 · 총 수강생 ${(c.studentCount || 0).toLocaleString()}명</div>
      <div class="detail-tags">${(c.skillTags || []).map((t) => `<span>${esc(t)}</span>`).join('')}</div>
    </div>
    <div class="buy-card">
      <img class="cover" src="${esc(c.thumbnailUrl || '')}" onerror="this.style.opacity=0">
      <div class="pad">
        <div class="price">${priceLabel(c.regularPrice)} ${c.regularPrice ? '<small>비즈니스 지원</small>' : ''}</div>
        <div id="enrollBox">${enrollBtnHtml(c)}</div>
        <div class="buy-actions">
          <button onclick="toast('폴더에 담았어요')">📁 폴더</button>
          <button onclick="shareCourse(${c.id})">🔗 공유</button>
          <button onclick="toggleBookmark(${c.id},null);this.classList.toggle('liked');toast('관심강의 저장')">🤍 찜 ${state.bookmarks.has(c.id) ? '1' : ''}</button>
        </div>
        <div class="buy-info">
          <div class="r"><span class="k">지식공유자</span><span>${esc(c.instructorName)}</span></div>
          <div class="r"><span class="k">커리큘럼</span><span>수업 ${c.lectureCount}개</span></div>
          <div class="r"><span class="k">강의 시간</span><span>${fmtDur(c.runtime)}</span></div>
          <div class="r"><span class="k">수강기한</span><span>${c.period ? c.period + '개월' : '무제한'}</span></div>
          <div class="r"><span class="k">수료증</span><span>${c.isCertificateIssuable ? '제공' : '미제공'}</span></div>
          <div class="r"><span class="k">난이도</span><span>${esc(lv)}</span></div>
        </div>
        <div class="buy-note">지식공유자 답변이 제공되는 강의입니다.</div>
      </div>
    </div>
  </div></div>

  <div class="detail-body">
    <div class="detail-main">
      <div class="dtabs">
        ${['intro:강의 소개', 'curr:커리큘럼', 'review:수강평', 'community:커뮤니티', 'news:새소식'].map((t) => {
          const [k, l] = t.split(':'); return `<a class="dtab ${k === 'intro' ? 'active' : ''}" data-tab="${k}" onclick="switchTab('${k}')">${l}</a>`;
        }).join('')}
      </div>
      <div id="tabBody"></div>
    </div>
    <div></div>
  </div>`;
  switchTab('intro');
}

window.switchTab = (k) => {
  const c = window.__course;
  document.querySelectorAll('.dtab').forEach((t) => t.classList.toggle('active', t.dataset.tab === k));
  const body = $('#tabBody');
  if (k === 'intro') {
    const abilities = splitLines(c.abilities), targets = splitLines(c.targets), based = splitLines(c.based);
    body.innerHTML = `
      <div class="d-h">수강 후 이런 걸 얻을 수 있어요 ✅</div>
      <div class="gain-list">${(abilities.length ? abilities : ['실무에 바로 적용할 수 있는 핵심 역량', '체계적인 개념 이해와 실습 경험']).map((a) => `<div class="g"><span class="chk">✔</span><span>${esc(a)}</span></div>`).join('')}</div>
      ${targets.length ? `<div class="d-h">이런 분께 추천해요 🙌</div><div class="gain-list">${targets.map((a) => `<div class="g"><span class="chk">✔</span><span>${esc(a)}</span></div>`).join('')}</div>` : ''}
      ${based.length ? `<div class="d-h">선수 지식이 필요해요 📚</div><div class="gain-list">${based.map((a) => `<div class="g"><span class="chk">✔</span><span>${esc(a)}</span></div>`).join('')}</div>` : ''}
      <div class="d-h">강의 소개</div>
      <p style="font-size:15px;color:#40454d;white-space:pre-wrap;line-height:1.7">${esc(c.description || '')}</p>
      <div class="d-h">지식공유자 소개</div>
      <p style="font-size:15px;color:#40454d;white-space:pre-wrap;line-height:1.7">${esc(c.instructorIntroduce && c.instructorIntroduce !== 'null' ? c.instructorIntroduce : c.instructorName + ' 님이 진행하는 강의입니다.')}</p>`;
  } else if (k === 'curr') {
    const secs = c.curriculum || [];
    body.innerHTML = `<div class="d-h">커리큘럼 <span class="muted" style="font-size:14px">· 총 ${c.lectureCount}개 수업 · ${fmtDur(c.runtime)}</span></div>
      ${secs.length ? secs.map((s, i) => `
        <div class="curr-section ${i === 0 ? 'open' : ''}">
          <div class="s-head" onclick="this.parentElement.classList.toggle('open')">
            <span>${esc(s.title)}</span><span class="rt">${(s.lectures || []).length}개 · ${fmtDur(s.runtime)}</span>
          </div>
          <div class="units">${(s.lectures || []).map((u) => `
            <div class="unit" onclick="go('#/learn/${c.id}')">
              <span class="play">▶</span><span class="u-title">${esc(u.title)}</span>
              ${u.isPreview ? '<span class="prev">미리보기</span>' : ''}<span class="u-rt">${fmtDurShort(u.runtime)}</span>
            </div>`).join('')}</div>
        </div>`).join('') : '<div class="empty-box">커리큘럼 정보가 없습니다.</div>'}`;
  } else if (k === 'review') {
    const reviews = genReviews(c);
    body.innerHTML = `
      <div class="review-summary">
        <div style="text-align:center"><div class="big">${(c.rating || 0).toFixed(1)}</div><div class="stars">${stars(c.rating)}</div><div class="muted" style="font-size:13px;margin-top:4px">${(c.reviewCount || 0).toLocaleString()}개 수강평</div></div>
        <div style="flex:1">${[5, 4, 3, 2, 1].map((n) => { const pct = n === 5 ? 78 : n === 4 ? 15 : n === 3 ? 5 : 1; return `<div style="display:flex;align-items:center;gap:10px;margin:3px 0;font-size:13px"><span class="muted">${n}점</span><div class="progress" style="flex:1"><span style="width:${pct}%;background:var(--star)"></span></div><span class="muted num" style="width:36px">${pct}%</span></div>`; }).join('')}</div>
      </div>
      ${reviews.map((r) => `<div class="review-item"><div class="head"><span class="stars">${stars(r.rate)}</span><span class="who">${esc(r.who)}</span><span class="when">${r.when}</span></div><div style="font-size:14px;color:#40454d">${esc(r.text)}</div></div>`).join('')}`;
  } else if (k === 'community') {
    body.innerHTML = `<div id="qnaRoot"></div>`;
    loadQna(c.id);
  } else if (k === 'news') {
    body.innerHTML = `<div class="d-h">새소식</div>
      <div class="review-item"><div class="head"><span class="who">📢 강의 업데이트</span><span class="when">2026.06.20</span></div><div style="font-size:14px;color:#40454d">최신 버전에 맞춰 실습 자료와 예제 코드가 업데이트되었습니다.</div></div>
      <div class="review-item"><div class="head"><span class="who">🎉 수강생 이벤트</span><span class="when">2026.05.10</span></div><div style="font-size:14px;color:#40454d">수강평을 남겨주신 분들께 추가 학습 자료를 드립니다.</div></div>`;
  }
};

// ---------- 커뮤니티 · 질문&답변 ----------
const qna = { courseId: null, questions: [], canModerate: false, composing: false, replyTo: null };
function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
  return iso.slice(0, 10).replace(/-/g, '.');
}
function avatarText(name) { return String(name || '?').slice(0, 2); }

async function loadQna(courseId) {
  qna.courseId = courseId; qna.composing = false; qna.replyTo = null;
  const root = $('#qnaRoot'); if (!root) return;
  root.innerHTML = `<div class="d-h">커뮤니티 · 질문&답변</div><div class="empty-box" style="padding:40px"><div class="spinner"></div>질문을 불러오는 중…</div>`;
  try {
    const r = await fetch('/api/questions?courseId=' + encodeURIComponent(courseId));
    if (r.status === 401) { location.href = '/login'; return; }
    const j = await r.json();
    qna.questions = j.questions || [];
    qna.canModerate = !!j.canModerate;
  } catch (e) {
    qna.questions = []; qna.canModerate = false;
  }
  drawQna();
}

function drawQna() {
  const root = $('#qnaRoot'); if (!root) return;
  const qs = qna.questions;
  const total = qs.length;
  const answered = qs.filter((q) => (q.answers || []).length).length;
  root.innerHTML = `
    <div class="qna-head">
      <div class="d-h" style="margin:0">커뮤니티 · 질문&답변 <span class="muted" style="font-size:14px;font-weight:600">${total}</span></div>
      <button class="mini-btn" style="margin-top:0" onclick="toggleCompose()">✏️ 질문 작성하기</button>
    </div>
    <div class="qna-sub">궁금한 점을 남기면 <b>지식공유자(관리자)의 답변</b>을 받을 수 있어요. · 답변 완료 ${answered}건</div>
    <div id="qnaCompose">${qna.composing ? composeHtml() : ''}</div>
    ${total ? `<div class="qna-list">${qs.map(questionHtml).join('')}</div>`
      : `<div class="empty-box" style="margin-top:16px">아직 등록된 질문이 없어요.<br>이 강의의 <b>첫 질문</b>을 남겨보세요! 🙌</div>`}`;
}

function composeHtml() {
  return `<div class="qna-form">
    <input id="qTitle" class="qna-input" placeholder="질문 제목을 입력하세요 (예: 3강 예제 코드 오류 관련 문의)" maxlength="200" />
    <textarea id="qBody" class="qna-textarea" placeholder="질문 내용을 자세히 적어주시면 더 정확한 답변을 받을 수 있어요." rows="4" maxlength="4000"></textarea>
    <div class="qna-form-actions">
      <button class="btn-ghost-sm" onclick="toggleCompose()">취소</button>
      <button class="mini-btn" style="margin-top:0" onclick="submitQuestion()">질문 등록</button>
    </div>
  </div>`;
}

function questionHtml(q) {
  const mine = state.user && q.authorEmail === state.user.email;
  const canDel = mine || qna.canModerate;
  const answers = q.answers || [];
  return `<div class="qna-item">
    <div class="qna-q">
      <div class="qna-avatar">${esc(avatarText(q.authorName))}</div>
      <div class="qna-q-body">
        <div class="qna-q-title">Q. ${esc(q.title)}</div>
        ${q.body ? `<div class="qna-q-text">${esc(q.body).replace(/\n/g, '<br>')}</div>` : ''}
        <div class="qna-meta">
          <span class="qna-who">${esc(q.authorName || '익명')}</span>
          <span>·</span><span>${esc(relTime(q.createdAt))}</span>
          <span class="qna-badge ${answers.length ? 'ok' : 'wait'}">${answers.length ? `답변 ${answers.length}` : '답변 대기'}</span>
          ${canDel ? `<button class="qna-del" onclick="deleteQuestion(${q.id})">삭제</button>` : ''}
        </div>
      </div>
    </div>
    ${answers.length ? `<div class="qna-answers">${answers.map((a) => answerHtml(q, a)).join('')}</div>` : ''}
    <div class="qna-answer-actions">
      ${qna.replyTo === q.id ? answerFormHtml(q.id) : `<button class="btn-ghost-sm" onclick="toggleReply(${q.id})">💬 답변 달기</button>`}
    </div>
  </div>`;
}

function answerHtml(q, a) {
  const mine = state.user && a.authorEmail === state.user.email;
  const canDel = mine || qna.canModerate;
  return `<div class="qna-a ${a.isInstructor ? 'inst' : ''}">
    <div class="qna-avatar sm ${a.isInstructor ? 'inst' : ''}">${esc(avatarText(a.authorName))}</div>
    <div class="qna-a-body">
      <div class="qna-meta">
        <span class="qna-who">${esc(a.authorName || '익명')}</span>
        ${a.isInstructor ? '<span class="qna-inst-badge">지식공유자</span>' : ''}
        <span>·</span><span>${esc(relTime(a.createdAt))}</span>
        ${canDel ? `<button class="qna-del" onclick="deleteAnswer(${q.id},${a.id})">삭제</button>` : ''}
      </div>
      <div class="qna-a-text">${esc(a.body).replace(/\n/g, '<br>')}</div>
    </div>
  </div>`;
}

function answerFormHtml(qid) {
  return `<div class="qna-form reply">
    <textarea id="aBody_${qid}" class="qna-textarea" placeholder="답변을 입력하세요${qna.canModerate ? ' (관리자 답변은 지식공유자로 표시됩니다)' : ''}" rows="3" maxlength="4000"></textarea>
    <div class="qna-form-actions">
      <button class="btn-ghost-sm" onclick="toggleReply(${qid})">취소</button>
      <button class="mini-btn" style="margin-top:0" onclick="submitAnswer(${qid})">답변 등록</button>
    </div>
  </div>`;
}

window.toggleCompose = () => { qna.composing = !qna.composing; qna.replyTo = null; drawQna(); if (qna.composing) setTimeout(() => $('#qTitle')?.focus(), 30); };
window.toggleReply = (qid) => { qna.replyTo = qna.replyTo === qid ? null : qid; qna.composing = false; drawQna(); if (qna.replyTo === qid) setTimeout(() => $('#aBody_' + qid)?.focus(), 30); };

window.submitQuestion = async () => {
  const title = $('#qTitle')?.value.trim();
  const bodyText = $('#qBody')?.value.trim();
  if (!title) { toast('질문 제목을 입력해 주세요'); $('#qTitle')?.focus(); return; }
  try {
    const r = await fetch('/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: qna.courseId, title, body: bodyText }) });
    const j = await r.json();
    if (!r.ok) { toast('등록 실패: ' + (j.error || r.status)); return; }
    qna.questions.unshift(j.question);
    qna.composing = false;
    drawQna();
    toast('질문이 등록되었습니다 🙌');
  } catch (e) { toast('등록 실패: ' + e.message); }
};

window.submitAnswer = async (qid) => {
  const bodyText = $('#aBody_' + qid)?.value.trim();
  if (!bodyText) { toast('답변 내용을 입력해 주세요'); return; }
  try {
    const r = await fetch('/api/answers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionId: qid, body: bodyText }) });
    const j = await r.json();
    if (!r.ok) { toast('등록 실패: ' + (j.error || r.status)); return; }
    const i = qna.questions.findIndex((q) => q.id === qid);
    if (i >= 0) qna.questions[i] = j.question;
    qna.replyTo = null;
    drawQna();
    toast('답변이 등록되었습니다 💬');
  } catch (e) { toast('등록 실패: ' + e.message); }
};

window.deleteQuestion = async (qid) => {
  if (!confirm('이 질문을 삭제할까요? 달린 답변도 함께 삭제됩니다.')) return;
  try {
    const r = await fetch('/api/questions?id=' + qid, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast('삭제 실패: ' + (j.error || r.status)); return; }
    qna.questions = qna.questions.filter((q) => q.id !== qid);
    drawQna();
    toast('질문이 삭제되었습니다');
  } catch (e) { toast('삭제 실패: ' + e.message); }
};

window.deleteAnswer = async (qid, aid) => {
  if (!confirm('이 답변을 삭제할까요?')) return;
  try {
    const r = await fetch(`/api/answers?questionId=${qid}&answerId=${aid}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast('삭제 실패: ' + (j.error || r.status)); return; }
    const i = qna.questions.findIndex((q) => q.id === qid);
    if (i >= 0 && j.question) qna.questions[i] = j.question;
    drawQna();
    toast('답변이 삭제되었습니다');
  } catch (e) { toast('삭제 실패: ' + e.message); }
};

// ---------- 수강신청 승인 플로우 ----------
// 강의별 최신 신청 상태 (없으면 null)
function requestForCourse(courseId) {
  const rs = (state.myRequests || []).filter((r) => String(r.courseId) === String(courseId));
  if (!rs.length) return null;
  return rs.slice().sort((a, b) => (b.requestedAt || '').localeCompare(a.requestedAt || ''))[0];
}
// 이미 (실데이터로) 수강 중인 강의인지
function alreadyEnrolled(courseId) {
  return (state.my?.enrollments || []).some((e) => String(e.courseId) === String(courseId));
}
// 강의 상세 수강신청 버튼 (상태별)
function enrollBtnHtml(c) {
  const req = requestForCourse(c.id);
  if (alreadyEnrolled(c.id) || (req && req.status === 'approved')) {
    return `<button class="btn-enroll enrolled" onclick="go('#/learn/${c.id}')">▶ 학습하러 가기</button>
      <div class="enroll-note ok">✅ 수강신청이 승인되어 <b>내 학습</b>에 추가되었어요.</div>`;
  }
  if (req && req.status === 'pending') {
    return `<button class="btn-enroll pending" disabled>⏳ 수강신청 승인중</button>
      <div class="enroll-note pending">관리자 승인을 기다리고 있어요. 승인되면 ‘내 학습’에서 바로 학습할 수 있어요.</div>`;
  }
  const rejected = req && req.status === 'rejected'
    ? `<div class="enroll-note rejected">🚫 수강신청이 <b>승인 불가</b> 처리되었습니다.${req.reason ? `<br>사유: ${esc(req.reason)}` : ''}<br>필요하시면 다시 신청해 주세요.</div>`
    : '';
  return `<button class="btn-enroll" onclick="requestEnroll(${c.id})">바로 수강신청 하기</button>${rejected}`;
}
window.requestEnroll = async (id) => {
  const c = state.courseById.get(id) || window.__course || { id };
  const box = $('#enrollBox');
  try {
    const r = await fetch('/api/enrollments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: id, courseTitle: c.title, thumbnailUrl: c.thumbnailUrl }),
    });
    const j = await r.json();
    if (!r.ok) { toast('신청 실패: ' + (j.error || r.status)); return; }
    // 같은 강의의 이전(불가) 기록은 정리하고 최신 신청으로 교체
    state.myRequests = [j.request, ...(state.myRequests || []).filter((x) => String(x.courseId) !== String(id))];
    if (box) box.innerHTML = enrollBtnHtml(c);
    toast('수강신청이 접수되었습니다. 관리자 승인을 기다려 주세요 ⏳');
  } catch (e) { toast('신청 실패: ' + e.message); }
};
window.enroll = window.requestEnroll; // 하위 호환

window.shareCourse = (id) => {
  const url = location.origin + '/#/course/' + id;
  navigator.clipboard?.writeText(url).then(() => toast('강의 링크를 복사했어요 🔗')).catch(() => toast(url));
};
function splitLines(s) { return (s || '').split(/\r?\n|·|•|\|/).map((x) => x.trim()).filter((x) => x.length > 2).slice(0, 6); }
function genReviews(c) {
  const names = ['개발자J', '데이터러버', 'es_learner', '성장하는곰', '주니어K', '실무투입러'];
  const txts = [
    '실무에 바로 적용할 수 있는 내용이라 정말 만족스러웠어요. 설명이 군더더기 없이 깔끔합니다.',
    '개념부터 실습까지 체계적으로 구성되어 있어 초보자도 따라가기 좋았습니다.',
    '강사님의 설명이 이해하기 쉽고, 예제가 실제 업무와 맞닿아 있어서 도움이 많이 됐어요.',
    '어려운 내용을 쉽게 풀어주셔서 끝까지 완주할 수 있었습니다. 추천합니다!',
    '커리큘럼이 알차고 최신 트렌드를 잘 반영하고 있어요. 회사 동료들에게도 공유했습니다.',
  ];
  const n = Math.min(5, Math.max(2, Math.round((c.reviewCount || 10) / 40)));
  return Array.from({ length: n }, (_, i) => ({
    who: names[i % names.length], rate: i === 0 ? 5 : (4 + (i % 2)), when: `2026.0${(i % 6) + 1}.1${i}`,
    text: txts[i % txts.length],
  }));
}

// ================= 강의 재생 (플레이어) =================
const CAPTIONS = [
  { ko: '안녕하세요, 이번 강의에 오신 것을 환영합니다.', en: 'Hello, and welcome to this lecture.' },
  { ko: '오늘은 핵심 개념부터 차근차근 살펴보겠습니다.', en: "Today we'll walk through the core concepts step by step." },
  { ko: 'AI 기반 업무 혁신의 트렌드를 선도하고 있습니다.', en: 'We are leading the trend of AI-driven work innovation.' },
  { ko: '이 부분은 실무에서 특히 자주 사용됩니다.', en: 'This part is used very often in practice.' },
  { ko: '함께 코드를 작성하면서 이해해 보겠습니다.', en: "Let's write some code together to understand it." },
  { ko: '핵심은 반복이 아니라 원리를 이해하는 것입니다.', en: 'The key is understanding the principle, not repetition.' },
  { ko: '다음 수업에서는 응용 사례를 다루겠습니다.', en: "In the next lesson, we'll cover applied examples." },
];
const player = { course: null, units: [], curr: 0, sec: 0, dur: 288, playing: false, aiCaption: true, enCaption: false, capIdx: 0, tab: 'toc', notes: [], pip: false, timer: null };

async function renderPlayer(id) {
  setNav('');
  clearTimers();
  // 같은 강의로 복귀(PIP → 학습창 확대 포함) → 시청 지점 그대로 이어보기
  if (player.course && String(player.course.id) === String(id) && player.units?.length) {
    removePipEl();
    drawPlayer();
    updateBar();
    syncPlayState();
    runTicker();
    return;
  }
  if (player.pip) pipClose(); // 다른 강의 재생 시작 → 기존 PIP 시청 종료
  stopTicker();
  app().innerHTML = `<div class="loading-screen" style="background:#0d0f14;color:#aeb4c0;height:100vh"><div class="spinner"></div>학습창을 준비하는 중…</div>`;
  let c;
  try { c = await fetch('/api/course?id=' + id).then((r) => r.json()); } catch { c = null; }
  if (!c || c.error) { app().innerHTML = `<div class="loading-screen">강의를 찾을 수 없어요.</div>`; return; }
  player.course = c;
  player.notes = JSON.parse(localStorage.getItem('lms_notes_' + id) || '[]');
  // 전체 수업 평탄화
  player.units = [];
  (c.curriculum || []).forEach((s, si) => (s.lectures || []).forEach((u) => player.units.push({ ...u, section: s.title, si })));
  if (!player.units.length) player.units = [{ id: 0, title: c.title, runtime: c.runtime || 288, section: '강의' }];
  player.curr = 0; player.sec = 0; player.dur = player.units[0].runtime || 288; player.capIdx = 0;
  drawPlayer();
  startPlayback();
}

function drawPlayer() {
  const c = player.course, u = player.units[player.curr];
  app().innerHTML = `<div class="player-page">
    <div class="player-main">
      <div class="player-topbar">
        <button class="back" onclick="go('#/course/${c.id}')">✕ 학습창 닫기</button>
        <span>${esc(c.title)}</span>
        <span class="meta"><span>수강률 ${Math.round((player.curr / player.units.length) * 100)}%</span><span>진도 ${player.curr + 1}/${player.units.length}</span></span>
      </div>
      <div class="video-area" id="videoArea" onclick="togglePlay()">
        <img class="poster" src="${esc(c.thumbnailUrl || '')}" onerror="this.style.opacity=0">
        <div class="video-slide"><div class="kicker">CH.${player.curr + 1} · ${esc(u.section || '')}</div><h2>${esc(u.title)}</h2></div>
        <div class="play-overlay" id="playOverlay">▶</div>
        <div class="caption-bar" id="captionBar" ${player.aiCaption ? '' : 'style="display:none"'}></div>
      </div>
      <div class="player-controls">
        <button onclick="togglePlay()" id="ppBtn">⏸</button>
        <button onclick="seek(-10)">« 10</button><button onclick="seek(10)">10 »</button>
        <div class="bar" onclick="scrub(event)"><span id="pbar" style="width:0%"></span></div>
        <span class="time" id="ptime">00:00 / 00:00</span>
        <button class="pip-btn" onclick="pipOut()" title="PIP(Picture-in-Picture) 미니 플레이어로 전환 — 시청하면서 다른 콘텐츠를 둘러보세요">⧉ PIP</button>
      </div>
    </div>
    <div class="player-side">
      <div class="side-tabs">
        <button class="${player.tab === 'toc' ? 'on' : ''}" onclick="playerTab('toc')">강의목차</button>
        <button class="${player.tab === 'rel' ? 'on' : ''}" onclick="playerTab('rel')">연관 콘텐츠</button>
        <button class="${player.tab === 'code' ? 'on' : ''}" onclick="playerTab('code')">코드에디터</button>
        <button class="${player.tab === 'note' ? 'on' : ''}" onclick="playerTab('note')">강의노트 ${player.notes.length ? player.notes.length : ''}</button>
      </div>
      <div class="side-content" id="sideContent"></div>
    </div>
    <div class="player-dock">
      <button class="dock-btn" onclick="openMaterials()">📎 강의자료 <span class="cnt">${(c.lectureCount || 1)}</span></button>
      <button class="dock-btn" onclick="playerTab('note')">📝 강의노트 <span class="cnt">${player.notes.length}</span></button>
      <button class="dock-btn core ${player.aiCaption ? 'on' : ''}" id="aiBtn" onclick="toggleAICaption()">✨ AI 자막 자동생성 <span class="only">EST family Only</span></button>
      <button class="dock-btn" onclick="openRating()">⭐ 강의평가</button>
    </div>
  </div>`;
  drawSide();
  updateCaption();
}

function drawSide() {
  const box = $('#sideContent'); if (!box) return;
  const c = player.course;
  if (player.tab === 'toc') {
    box.innerHTML = (c.curriculum || []).map((s, si) => `
      <div class="toc-section">
        <div class="th"><span>${esc(s.title)}</span><span class="muted">${(s.lectures || []).length}</span></div>
        ${(s.lectures || []).map((u) => {
          const idx = player.units.findIndex((x) => x.id === u.id);
          return `<div class="toc-unit ${idx === player.curr ? 'on' : ''} ${idx < player.curr ? 'done' : ''}" onclick="playUnit(${idx})">
            <span class="n">${idx < player.curr ? '✓' : '▶'}</span><span>${esc(u.title)}</span><span class="rt">${fmtDurShort(u.runtime)}</span></div>`;
        }).join('')}
      </div>`).join('') || '<div class="muted" style="padding:14px">목차 정보 없음</div>';
  } else if (player.tab === 'rel') {
    const rel = relatedCourses(c, 12);
    box.innerHTML = `<div class="rel-sub">지금 시청 중인 콘텐츠와 이어서 학습하기 좋은 연관 콘텐츠예요.<br>다른 콘텐츠로 이동해도 시청 중인 영상은 <b>PIP 미니 플레이어</b>로 계속 재생됩니다.</div>
      ${rel.length ? rel.map((x, i) => `
      <div class="rel-item" onclick="go('#/course/${x.id}')">
        <span class="rel-no num">${i + 1}</span>
        <div class="rel-thumb"><img loading="lazy" src="${esc(x.thumbnailUrl || '')}" onerror="this.style.opacity=0"><span class="rel-rt">${fmtDurShort(x.runtime)}</span></div>
        <div class="rel-body">
          <div class="rel-title">${esc(x.title)}</div>
          <div class="rel-meta">★ ${(x.rating || 0).toFixed(1)} · ${(x.studentCount || 0).toLocaleString()}명${x.level ? ' · ' + esc(x.level) : ''}</div>
          <button class="rel-play" onclick="event.stopPropagation();playRelated(${x.id})">▶ 바로 재생</button>
        </div>
      </div>`).join('') : '<div class="muted" style="padding:14px">연관 콘텐츠가 없습니다.</div>'}`;
  } else if (player.tab === 'code') {
    box.innerHTML = `<div class="code-editor">
      <div style="font-size:12px;color:#8b93a1;margin-bottom:8px">설치 없이 바로 실습하세요 · JavaScript</div>
      <textarea id="codeArea" rows="10">// 강의 예제 코드를 작성하고 실행해 보세요
const nums = [1, 2, 3, 4, 5];
const total = nums.reduce((a, b) => a + b, 0);
console.log('합계:', total);</textarea>
      <button class="mini-btn" onclick="runCode()">▶ 실행</button>
      <div class="code-out" id="codeOut">실행 결과가 여기에 표시됩니다.</div>
    </div>`;
  } else if (player.tab === 'note') {
    box.innerHTML = `<div class="note-editor">
      <div class="ts">⏱ ${fmtTime(player.sec)} 지점에 노트 추가</div>
      <textarea id="noteArea" rows="3" placeholder="이 장면의 핵심 내용을 나만의 언어로 기록하세요"></textarea>
      <button class="mini-btn" onclick="addNote()">＋ 노트 저장</button>
      ${player.notes.length ? `<button class="mini-btn ghost" onclick="downloadNotes()">⬇ 전체 노트 다운로드</button>` : ''}
      <div style="margin-top:16px">${player.notes.map((n, i) => `<div class="note-card"><button class="del" onclick="delNote(${i})">🗑</button><div class="ts">⏱ ${fmtTime(n.ts)} · ${esc(n.unit)}</div><div>${esc(n.text)}</div></div>`).join('')}</div>
    </div>`;
  }
}

window.playerTab = (t) => { player.tab = t; document.querySelectorAll('.side-tabs button').forEach((b, i) => b.classList.toggle('on', ['toc', 'rel', 'code', 'note'][i] === t)); drawSide(); };
window.playUnit = (idx) => { player.curr = idx; player.sec = 0; player.dur = player.units[idx].runtime || 288; player.capIdx = 0; player.playing = true; drawPlayer(); startPlayback(); };
window.togglePlay = () => { player.playing = !player.playing; const b = $('#ppBtn'), o = $('#playOverlay'); if (b) b.textContent = player.playing ? '⏸' : '▶'; if (o) o.style.display = player.playing ? 'none' : 'grid'; };
window.seek = (d) => { player.sec = Math.max(0, Math.min(player.dur, player.sec + d)); updateBar(); };
window.scrub = (e) => { const r = e.currentTarget.getBoundingClientRect(); player.sec = Math.round(((e.clientX - r.left) / r.width) * player.dur); updateBar(); };

function startPlayback() {
  player.playing = true;
  syncPlayState();
  runTicker();
}
// 재생 티커 — state.timers와 별도로 관리해 라우트 전환(PIP 모드)에도 재생이 유지됨
function runTicker() {
  clearInterval(player.timer);
  player.timer = setInterval(tick, 1000);
}
function stopTicker() { clearInterval(player.timer); player.timer = null; }
function tick() {
  if (!player.playing) return;
  player.sec += 1;
  if (player.sec >= player.dur) {
    if (player.curr < player.units.length - 1) {
      // 다음 수업 자동 이어보기 (학습창/PIP 공통)
      player.curr += 1; player.sec = 0; player.dur = player.units[player.curr].runtime || 288; player.capIdx = 0;
      if (player.pip) { updatePipMeta(); }
      else if ($('#videoArea')) { drawPlayer(); syncPlayState(); }
      toast('다음 수업으로 이어집니다 ▶');
    } else {
      player.sec = player.dur; player.playing = false;
      syncPlayState();
      toast('강의를 모두 시청했어요 🎉');
    }
  }
  // 자막 인덱스 변경 (약 12초마다)
  const idx = Math.floor(player.sec / 12) % CAPTIONS.length;
  if (idx !== player.capIdx) { player.capIdx = idx; updateCaption(); }
  updateBar();
}
function syncPlayState() {
  const b = $('#ppBtn'); if (b) b.textContent = player.playing ? '⏸' : '▶';
  const o = $('#playOverlay'); if (o) o.style.display = player.playing ? 'none' : 'grid';
  const pp = $('#pipPp'); if (pp) pp.textContent = player.playing ? '⏸' : '▶';
  const pe = $('#pipPlayer'); if (pe) pe.classList.toggle('paused', !player.playing);
}
function updateBar() {
  const pb = $('#pbar'), pt = $('#ptime');
  if (pb) pb.style.width = (player.sec / player.dur * 100) + '%';
  if (pt) pt.textContent = `${fmtTime(player.sec)} / ${fmtTime(player.dur)}`;
  const xb = $('#pipBar'), xt = $('#pipTime');
  if (xb) xb.style.width = (player.sec / player.dur * 100) + '%';
  if (xt) xt.textContent = `${fmtTime(player.sec)} / ${fmtTime(player.dur)}`;
}
function updateCaption() {
  const cap = CAPTIONS[player.capIdx];
  const bar = $('#captionBar');
  if (bar) {
    if (!player.aiCaption) bar.style.display = 'none';
    else { bar.style.display = 'block'; bar.innerHTML = esc(cap.ko) + (player.enCaption ? `<span class="en">${esc(cap.en)}</span>` : ''); }
  }
  const pc = $('#pipCaption');
  if (pc) { pc.style.display = player.aiCaption ? 'block' : 'none'; pc.textContent = cap.ko; }
}
function fmtTime(s) { const m = Math.floor(s / 60), ss = Math.floor(s % 60); return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; }

// ---------- PIP(Picture-in-Picture) 미니 플레이어 ----------
// 재생 중 플레이어 영역이 가려지는 시점(=다른 화면으로 이동)부터 우하단 팝업 플레이어로 이어서 재생
function enterPip() {
  if (player.pip || !player.course) return;
  player.pip = true;
  const c = player.course, u = player.units[player.curr];
  const el = document.createElement('div');
  el.className = 'pip-player'; el.id = 'pipPlayer';
  el.innerHTML = `
    <div class="pip-video" id="pipVideo" title="클릭하면 학습창으로 돌아갑니다">
      <img class="pip-poster" src="${esc(c.thumbnailUrl || '')}" onerror="this.style.opacity=0">
      <div class="pip-slide"><div class="pip-kicker" id="pipKicker">CH.${player.curr + 1} · ${esc(u.section || '')}</div><div class="pip-title" id="pipTitle">${esc(u.title)}</div></div>
      <div class="pip-caption" id="pipCaption"></div>
      <button class="pip-pp" id="pipPp" onclick="pipTogglePlay(event)">${player.playing ? '⏸' : '▶'}</button>
      <div class="pip-actions">
        <button title="학습창으로 돌아가기" onclick="event.stopPropagation();pipExpand()">⤢</button>
        <button title="시청 종료" onclick="event.stopPropagation();pipClose()">✕</button>
      </div>
    </div>
    <div class="pip-progress"><span id="pipBar" style="width:${(player.sec / player.dur * 100)}%"></span></div>
    <div class="pip-foot">
      <span class="pip-badge">PIP</span>
      <span class="pip-course">${esc(c.title)}</span>
      <span class="pip-time num" id="pipTime">${fmtTime(player.sec)} / ${fmtTime(player.dur)}</span>
    </div>`;
  document.body.appendChild(el);
  el.classList.toggle('paused', !player.playing);
  makePipDraggable(el);
  updateCaption();
  runTicker(); // 화면 전환 후에도 재생 유지
}
function removePipEl() { const el = $('#pipPlayer'); if (el) el.remove(); player.pip = false; }
window.pipClose = () => { stopTicker(); player.playing = false; removePipEl(); };
window.pipExpand = () => { if (player.course) go('#/learn/' + player.course.id); };
// 학습창 내 PIP 버튼: 홈으로 이동하면 라우터가 자동으로 미니 플레이어를 띄움
window.pipOut = () => {
  player.playing = true;
  toast('PIP 모드로 전환 — 시청하면서 다른 콘텐츠를 둘러보세요 ⧉');
  go('#/');
};
window.pipTogglePlay = (e) => {
  e.stopPropagation();
  player.playing = !player.playing;
  syncPlayState();
};
function updatePipMeta() {
  const u = player.units[player.curr]; if (!u) return;
  const k = $('#pipKicker'), t = $('#pipTitle');
  if (k) k.textContent = `CH.${player.curr + 1} · ${u.section || ''}`;
  if (t) t.textContent = u.title;
}
// 드래그로 위치 이동, 클릭(이동 없음)하면 학습창으로 확대
function makePipDraggable(el) {
  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true; moved = false;
    const r = el.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    if (!moved) return;
    el.style.left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, ox + dx)) + 'px';
    el.style.top = Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, oy + dy)) + 'px';
    el.style.right = 'auto'; el.style.bottom = 'auto';
  });
  el.addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    if (!moved && e.target.closest('#pipVideo')) pipExpand();
  });
}

// ---------- 연관 콘텐츠 큐레이션 (태그·카테고리 유사도 기반) ----------
function relatedCourses(c, n = 10) {
  const tags = new Set(c.skillTags || []);
  return state.catalog.courses
    .filter((x) => x.id !== c.id)
    .map((x) => {
      let s = 0;
      for (const t of (x.skillTags || [])) if (tags.has(t)) s += 3;
      if (x.subCategory && x.subCategory === c.subCategory) s += 2;
      if (x.mainCategory && x.mainCategory === c.mainCategory) s += 1;
      return { x, s };
    })
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || b.x.studentCount - a.x.studentCount)
    .slice(0, n).map((r) => r.x);
}
window.playRelated = (id) => { go('#/learn/' + id); };

window.toggleAICaption = () => {
  player.aiCaption = !player.aiCaption;
  $('#aiBtn').classList.toggle('on', player.aiCaption);
  updateCaption();
  toast(player.aiCaption ? 'AI 자막 자동생성 ON — 실시간 자막을 표시합니다' : 'AI 자막 OFF');
  if (player.aiCaption) {
    // 영문 자막(글로벌) 옵션 안내
    setTimeout(() => {
      const bar = $('#captionBar');
      if (bar && !$('#enToggle')) {
        const btn = document.createElement('button');
        btn.id = 'enToggle'; btn.className = 'mini-btn ghost'; btn.style.cssText = 'position:absolute;bottom:140px;left:50%;transform:translateX(-50%);z-index:5';
        btn.textContent = player.enCaption ? '🌐 영문 자막 끄기' : '🌐 영문 자막 켜기 (글로벌)';
        btn.onclick = () => { player.enCaption = !player.enCaption; btn.textContent = player.enCaption ? '🌐 영문 자막 끄기' : '🌐 영문 자막 켜기 (글로벌)'; updateCaption(); };
        $('#videoArea').appendChild(btn);
      }
    }, 50);
  } else { const b = $('#enToggle'); if (b) b.remove(); }
};

window.runCode = () => {
  const code = $('#codeArea').value, out = $('#codeOut');
  const logs = [];
  const fakeConsole = { log: (...a) => logs.push(a.map((x) => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')) };
  try { new Function('console', code)(fakeConsole); out.style.color = '#7ee787'; out.textContent = logs.join('\n') || '(출력 없음)'; }
  catch (e) { out.style.color = '#ff7b72'; out.textContent = '⚠ ' + e.message; }
};
window.addNote = () => {
  const ta = $('#noteArea'); const text = ta.value.trim(); if (!text) { toast('노트 내용을 입력하세요'); return; }
  player.notes.unshift({ ts: player.sec, text, unit: player.units[player.curr].title });
  localStorage.setItem('lms_notes_' + player.course.id, JSON.stringify(player.notes));
  drawSide(); toast('강의노트를 저장했어요 📝');
};
window.delNote = (i) => { player.notes.splice(i, 1); localStorage.setItem('lms_notes_' + player.course.id, JSON.stringify(player.notes)); drawSide(); };
window.downloadNotes = () => {
  const c = player.course;
  const txt = `[${c.title}] 강의노트\n\n` + player.notes.map((n) => `⏱ ${fmtTime(n.ts)} | ${n.unit}\n${n.text}\n`).join('\n');
  const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${c.title}_노트.txt`; a.click();
  toast('노트를 다운로드했어요 ⬇');
};
window.openMaterials = () => {
  const c = player.course;
  const mats = [
    { n: '강의 슬라이드 (PDF)', s: '2.4MB' }, { n: '실습 예제 코드 (ZIP)', s: '860KB' },
    { n: '핵심 요약 노트 (PDF)', s: '1.1MB' }, { n: '추가 학습 자료 링크', s: 'URL' },
  ];
  modal(`<h3>강의 자료 <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="sub">강의에서 제공되는 자료를 저장하여 학습 후에도 활용하세요.</p>
    ${mats.map((m) => `<div class="mat-item"><span class="ic">📄</span><span>${m.n}</span><span class="muted" style="font-size:12px">${m.s}</span><button class="dl" onclick="toast('다운로드를 시작합니다')">다운로드</button></div>`).join('')}`);
};
window.openRating = () => {
  modal(`<h3>강의 평가 <button class="close" onclick="closeModal()">✕</button></h3>
    <p class="sub">학습 만족도를 평가하고 자유롭게 후기를 남겨주세요.</p>
    <div class="star-input" id="starInput">${[1, 2, 3, 4, 5].map((i) => `<span onclick="setStar(${i})" data-i="${i}">★</span>`).join('')}</div>
    <textarea id="reviewText" placeholder="이 강의의 좋았던 점, 아쉬웠던 점을 남겨주세요."></textarea>
    <button class="mini-btn" style="margin-top:14px;width:100%" onclick="submitRating()">평가 제출하기</button>`);
  window.__star = 0;
};
window.setStar = (i) => { window.__star = i; document.querySelectorAll('#starInput span').forEach((s) => s.classList.toggle('on', +s.dataset.i <= i)); };
window.submitRating = () => { if (!window.__star) { toast('별점을 선택해주세요'); return; } closeModal(); toast(`평가 완료! ${window.__star}점 감사합니다 ⭐`); };

function modal(html) {
  const back = document.createElement('div'); back.className = 'modal-back'; back.id = 'modalBack';
  back.innerHTML = `<div class="modal">${html}</div>`;
  back.onclick = (e) => { if (e.target === back) closeModal(); };
  document.body.appendChild(back);
}
window.closeModal = () => { const m = $('#modalBack'); if (m) m.remove(); };

// ================= 수강정보(마이) — 나의 학습 대시보드 =================
const myDash = { view: 'dash', year: null, table: false };

function renderMy() {
  setNav('my');
  const my = state.my, enr = myEnrollments();
  app().innerHTML = `<div class="wrap">
    <div class="dash-head"><div class="av">${(my?.email || 'ME')[0].toUpperCase()}</div>
      <div><h2>나의 학습</h2><div class="muted" style="font-size:13px">${esc(my?.email || '')} · UUID ${esc(my?.uuid || '-')}</div></div>
      <div class="dash-tabs">
        <button class="${myDash.view === 'dash' ? 'on' : ''}" onclick="myDash.view='dash';renderMy()">대시보드</button>
        <button class="${myDash.view === 'list' ? 'on' : ''}" onclick="myDash.view='list';renderMy()">학습 목록</button>
      </div>
    </div>
    ${myDash.view === 'dash' ? dashHtml(enr) : dashListHtml(enr)}
  </div>`;
  if (myDash.view === 'dash') bindDashChart();
}

// ---- 대시보드 본문 ----
function dashHtml(enr) {
  if (!enr.length) {
    return `<div class="empty-box">아직 수강 중인 강의가 없어요.<br><br>
      <button class="mini-btn" onclick="go('#/apply')">수강신청 하러 가기 →</button></div>`;
  }
  const s = myStats(enr);
  const totalSec = enr.reduce((a, e) => a + (e.runtime || 0) * (e.progressRate / 100), 0);
  const inProg = enr.filter(isInProgress)
    .sort((a, b) => (b.justApproved ? 1 : 0) - (a.justApproved ? 1 : 0) || (b.latestAccessedAt || '').localeCompare(a.latestAccessedAt || ''));
  const avgP = Math.round(s.avgProgress || 0);

  // 연도 목록 (수강 시작/수료 이력이 있는 연도)
  const years = [...new Set(enr.flatMap((e) => [e.learningStartedAt || e.createdAt, e.courseCompletedAt])
    .filter(Boolean).map((d) => String(d).slice(0, 4)))].sort().reverse();
  if (!years.length) years.push(String(new Date().getFullYear()));
  if (!myDash.year || !years.includes(myDash.year)) myDash.year = years[0];
  const ms = dashMonthlySeries(enr, myDash.year);

  return `
    <div class="dash-grid">
      <div class="dash-card"><h3>통합 학습 현황</h3>
        <div class="dash-overview">
          <div class="dash-kpis">
            <div class="dash-kpi"><div class="k">전체 과정</div><div class="v num">${s.enrollments || 0}<small> 개</small></div></div>
            <div class="dash-kpi"><div class="k">학습 중</div><div class="v num">${s.inProgress || 0}<small> 개</small></div></div>
            <div class="dash-kpi"><div class="k">수료 완료</div><div class="v num">${s.completed || 0}<small> 개</small></div></div>
            <div class="dash-kpi"><div class="k">누적 학습시간</div><div class="v num" style="font-size:17px">${fmtDurShort(totalSec)}</div></div>
            <div class="dash-kpi"><div class="k">수료증</div><div class="v num">${s.certificates || 0}<small> 장</small></div></div>
            <div class="dash-kpi"><div class="k">관심 강의</div><div class="v num">${state.bookmarks.size}<small> 개</small></div></div>
          </div>
          ${dashDonut(avgP)}
        </div>
      </div>
      <div class="dash-card"><h3>강의별 학습시간 TOP 5</h3>${dashTopCourses(enr)}</div>
    </div>

    <div class="section" style="margin:20px 0 16px">
      <div class="section-head" style="margin-bottom:12px"><h2 style="font-size:16.5px">진행 중인 학습 <span class="muted num" style="font-size:13px">${inProg.length}</span></h2></div>
      ${inProg.length
        ? `<div class="dash-prog-grid">${inProg.slice(0, 6).map((e) => `
          <div class="dash-prog-card">
            <div class="top">
              <img class="thumb" src="${esc(e.thumbnailUrl || '')}" onerror="this.style.opacity=0">
              <div class="t">${esc(e.catTitle || e.courseTitle)}${e.justApproved ? ' <span class="new-pill">신규 승인</span>' : ''}</div>
            </div>
            <div class="progress"><span style="width:${e.progressRate}%"></span></div>
            <div class="foot"><span>진도율 ${e.progressRate.toFixed(1)}%</span><span>${e.justApproved ? '승인 완료' : '최근 ' + esc((e.latestAccessedAt || '-').slice(0, 10))}</span>
              <button class="go" onclick="go('#/learn/${e.courseId}')">${e.justApproved ? '▶ 학습 시작' : '▶ 이어보기'}</button></div>
          </div>`).join('')}</div>`
        : '<div class="dash-empty">진행 중인 학습이 없어요. 새 강의를 시작해 보세요!</div>'}
    </div>

    <div class="dash-grid">
      <div class="dash-card"><h3>월별 학습 추이
        <span class="h-tools">
          <select class="dash-select" onchange="myDash.year=this.value;renderMy()">
            ${years.map((y) => `<option value="${y}" ${y === myDash.year ? 'selected' : ''}>${y}년</option>`).join('')}
          </select>
          <button class="dash-ghost-btn" onclick="myDash.table=!myDash.table;renderMy()">${myDash.table ? '차트로 보기' : '표로 보기'}</button>
        </span></h3>
        ${myDash.table ? dashMonthlyTable(ms) : dashColChart(ms)}
        <div class="dash-legend"><span><i class="sw-s"></i>수강 시작</span><span><i class="sw-d"></i>수료</span></div>
      </div>
      <div class="dash-card"><h3>학습 알림</h3>${dashAlerts(enr)}</div>
    </div>`;
}

// ---- 학습 목록 뷰 (기존 리스트) ----
function dashListHtml(enr) {
  const inProg = enr.filter(isInProgress)
    .sort((a, b) => (b.justApproved ? 1 : 0) - (a.justApproved ? 1 : 0) || (b.latestAccessedAt || '').localeCompare(a.latestAccessedAt || ''));
  const done = enr.filter((e) => e.completed);
  return `
    <div class="section-head"><h2 style="font-size:18px">학습 중인 강의</h2></div>
    ${inProg.length ? inProg.map((e) => myRow(e)).join('') : '<div class="empty-box">학습 중인 강의가 없어요.</div>'}
    <div class="section-head" style="margin-top:34px"><h2 style="font-size:18px">수료한 강의</h2></div>
    ${done.length ? done.slice(0, 20).map((e) => myRow(e)).join('') : '<div class="empty-box">아직 수료한 강의가 없어요.</div>'}`;
}

// ---- 월별 시작/수료 집계 ----
function dashMonthlySeries(enr, year) {
  const starts = Array(12).fill(0), dones = Array(12).fill(0);
  for (const e of enr) {
    const st = e.learningStartedAt || e.createdAt;
    if (st && String(st).slice(0, 4) === year) starts[+String(st).slice(5, 7) - 1]++;
    if (e.courseCompletedAt && String(e.courseCompletedAt).slice(0, 4) === year) dones[+String(e.courseCompletedAt).slice(5, 7) - 1]++;
  }
  return { starts, dones };
}

// ---- 컬럼 차트 (월별 추이) ----
function dashColChart(ms) {
  const raw = Math.max(1, ...ms.starts, ...ms.dones);
  // 축 최대값을 깔끔한 수로 (정수 눈금 유지)
  let max, divs;
  if (raw <= 2) { max = 2; divs = 2; }
  else if (raw <= 4) { max = 4; divs = 4; }
  else { max = Math.ceil(raw / 4) * 4; divs = 4; }
  const lines = Array.from({ length: divs + 1 }, (_, i) =>
    `<div class="dc-line ${i === 0 ? 'zero' : ''}" style="bottom:${i * 100 / divs}%"><span class="num">${Math.round(max * i / divs)}</span></div>`).join('');
  const cols = ms.starts.map((sv, i) => {
    const dv = ms.dones[i];
    return `<div class="dc-col" tabindex="0" role="img" aria-label="${i + 1}월: 수강 시작 ${sv}건, 수료 ${dv}건"
      data-m="${i + 1}" data-s="${sv}" data-d="${dv}">
      <div class="dc-bars">
        <span class="dcb s" style="height:${sv / max * 100}%"></span>
        <span class="dcb d" style="height:${dv / max * 100}%"></span>
      </div>
      <span class="dc-x">${i + 1}월</span>
    </div>`;
  }).join('');
  return `<div class="dc-plot" id="dashMonthly"><div class="dc-gridlines">${lines}</div><div class="dc-cols">${cols}</div></div>`;
}
function dashMonthlyTable(ms) {
  return `<table class="dash-table"><thead><tr><th>월</th><th>수강 시작</th><th>수료</th></tr></thead><tbody>
    ${ms.starts.map((sv, i) => `<tr><td>${i + 1}월</td><td class="num">${sv}</td><td class="num">${ms.dones[i]}</td></tr>`).join('')}
  </tbody></table>`;
}

// ---- 차트 툴팁 (호버/키보드 포커스) ----
function bindDashChart() {
  const plot = $('#dashMonthly'); if (!plot) return;
  let tip = $('#dashTip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'dashTip'; tip.className = 'dash-tip'; document.body.appendChild(tip); }
  const show = (col, x, y) => {
    tip.textContent = '';
    const tt = document.createElement('div'); tt.className = 'tt';
    tt.textContent = `${myDash.year}년 ${col.dataset.m}월`; tip.appendChild(tt);
    [['s', '수강 시작', col.dataset.s], ['d', '수료', col.dataset.d]].forEach(([cls, name, v]) => {
      const row = document.createElement('div'); row.className = 'tr';
      const key = document.createElement('span'); key.className = 'key ' + cls;
      const val = document.createElement('b'); val.textContent = v + '건';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = name;
      row.append(key, val, nm); tip.appendChild(row);
    });
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    let left = x + 14; if (left + r.width > innerWidth - 8) left = x - r.width - 14;
    tip.style.left = left + 'px'; tip.style.top = Math.max(8, y - r.height / 2) + 'px';
  };
  const hide = () => { tip.style.display = 'none'; };
  plot.querySelectorAll('.dc-col').forEach((col) => {
    col.addEventListener('pointermove', (ev) => show(col, ev.clientX, ev.clientY));
    col.addEventListener('pointerleave', hide);
    col.addEventListener('focus', () => { const r = col.getBoundingClientRect(); show(col, r.right, r.top + 20); });
    col.addEventListener('blur', hide);
  });
}

// ---- 진도율 도넛 ----
function dashDonut(pct) {
  const r = 34, c = 2 * Math.PI * r;
  return `<svg class="dash-donut" viewBox="0 0 84 84" role="img" aria-label="평균 진도율 ${pct}%">
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="var(--blue-soft)" stroke-width="9"/>
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="var(--blue)" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 42 42)"/>
    <text x="42" y="42" text-anchor="middle" class="dv">${pct}%</text>
    <text x="42" y="55" text-anchor="middle" class="dk">평균 진도율</text>
  </svg>`;
}

// ---- 강의별 학습시간 TOP 5 (가로 막대) ----
function dashTopCourses(enr) {
  const rows = enr.map((e) => ({ id: e.courseId, t: e.catTitle || e.courseTitle, sec: (e.runtime || 0) * (e.progressRate / 100) }))
    .filter((x) => x.sec > 0).sort((a, b) => b.sec - a.sec).slice(0, 5);
  if (!rows.length) return '<div class="dash-empty">아직 학습 기록이 없어요.</div>';
  const max = rows[0].sec;
  return rows.map((x) => `<div class="dh-row" onclick="go('#/learn/${x.id}')">
    <div class="dh-t">${esc(x.t)}</div>
    <div class="dh-bar"><div class="track"><span style="width:${(x.sec / max * 100).toFixed(1)}%"></span></div><em class="num">${fmtDurShort(x.sec)}</em></div>
  </div>`).join('');
}

// ---- 학습 알림 (수강기한/미시작/수료임박/수료증) ----
function dashAlerts(enr) {
  const alerts = [];
  const now = Date.now();
  // 수강신청 승인/불가 알림 (최우선 노출)
  (state.myRequests || []).forEach((r) => {
    if (r.status === 'pending') {
      alerts.push({ ic: '⏳', b: r.courseTitle || `강의 #${r.courseId}`, s: '수강신청 승인 대기중입니다', go: '#/course/' + r.courseId, w: 3 });
    } else if (r.status === 'rejected') {
      alerts.push({ ic: '🚫', b: r.courseTitle || `강의 #${r.courseId}`, s: '수강신청 승인 불가' + (r.reason ? ` — ${r.reason}` : ''), go: '#/course/' + r.courseId, w: 1, dismiss: r.id });
    }
  });
  enr.filter((e) => !e.completed && e.expiredAt).forEach((e) => {
    const days = Math.ceil((new Date(e.expiredAt) - now) / 864e5);
    if (days > 0 && days <= 30) alerts.push({ ic: '⏰', b: e.catTitle || e.courseTitle, s: `수강 기한이 ${days}일 남았어요 (D-${days})`, go: '#/learn/' + e.courseId, w: days });
  });
  enr.filter((e) => !e.completed && e.progressRate >= 80).forEach((e) => {
    alerts.push({ ic: '🎯', b: e.catTitle || e.courseTitle, s: `진도율 ${e.progressRate.toFixed(0)}% — 수료까지 조금 남았어요!`, go: '#/learn/' + e.courseId, w: 40 });
  });
  const notStarted = enr.filter((e) => !e.completed && e.progressRate === 0);
  if (notStarted.length) alerts.push({ ic: '📌', b: `아직 시작하지 않은 강의 ${notStarted.length}개`, s: notStarted.slice(0, 2).map((e) => e.catTitle || e.courseTitle).join(' · '), tab: 'list', w: 60 });
  enr.filter((e) => e.certificateUrl).sort((a, b) => (b.courseCompletedAt || '').localeCompare(a.courseCompletedAt || '')).slice(0, 2).forEach((e) => {
    alerts.push({ ic: '🏅', b: e.catTitle || e.courseTitle, s: '수료증이 발급되었어요', go: e.certificateUrl, ext: true, w: 80 });
  });
  if (!alerts.length) return '<div class="dash-empty">새로운 알림이 없어요 🎉</div>';
  return `<div class="dash-alerts">${alerts.sort((a, b) => a.w - b.w).slice(0, 6).map((a) => `
    <div class="dash-alert${a.dismiss ? ' rejected' : ''}" onclick="${a.ext ? `window.open('${esc(a.go)}','_blank')` : a.tab ? `myDash.view='${a.tab}';renderMy()` : `go('${esc(a.go)}')`}">
      <span class="ic">${a.ic}</span>
      <span class="tx"><b>${esc(a.b)}</b><small>${esc(a.s)}</small></span>
      ${a.dismiss ? `<button class="alert-x" title="알림 지우기" onclick="event.stopPropagation();dismissRequest(${a.dismiss})">✕</button>` : ''}
    </div>`).join('')}</div>`;
}
// 승인 불가 알림 지우기 (신청 기록 삭제)
window.dismissRequest = async (id) => {
  try {
    await fetch('/api/enrollments?id=' + id, { method: 'DELETE' });
    state.myRequests = (state.myRequests || []).filter((r) => r.id !== id);
    renderMy();
    toast('알림을 지웠어요');
  } catch (e) { toast('처리 실패: ' + e.message); }
};
function myRow(e) {
  return `<div class="result-item" onclick="go('#/learn/${e.courseId}')">
    <img class="thumb" src="${esc(e.thumbnailUrl || '')}" onerror="this.style.opacity=0">
    <div class="rbody">
      <div class="rt">${esc(e.catTitle || e.courseTitle)}${e.justApproved ? ' <span class="new-pill">신규 승인</span>' : ''}</div>
      <div class="progress" style="margin:8px 0 4px"><span style="width:${e.progressRate}%"></span></div>
      <div class="rmeta"><span>진도율 ${e.progressRate.toFixed(1)}%</span>${e.completed ? '<span style="color:var(--green)">✔ 수료 완료</span>' : ''}${e.certificateUrl ? `<a href="${esc(e.certificateUrl)}" target="_blank" onclick="event.stopPropagation()">🏅 수료증</a>` : ''}<span>최근 학습 ${e.justApproved ? '승인 완료' : (e.latestAccessedAt || '-')}</span></div>
    </div>
  </div>`;
}

// ================= 개별학습 (사외교육·자격증·학위) =================
const IL_TYPES = ['사외교육', '자격증', '학위'];
const IL_STATUS_LABEL = {
  in_progress: { t: '학습중', cls: 'ok' },
  completed: { t: '이수 완료', cls: 'done' },
  // 구버전(사전신청 플로우) 데이터 호환
  pre_pending: { t: '학습중', cls: 'ok' },
  pre_approved: { t: '학습중', cls: 'ok' },
  pre_rejected: { t: '반려', cls: 'no' },
  post_pending: { t: '학습중', cls: 'ok' },
  post_approved: { t: '이수 완료', cls: 'done' },
  post_rejected: { t: '반려', cls: 'no' },
};
const ilDone = (r) => r.status === 'completed' || r.status === 'post_approved';
const ilProg = (r) => ilDone(r) ? 100 : Math.min(100, Math.max(0, Number(r.progress) || 0));
const ilView = { form: false, records: [] };

async function loadIlRecords() {
  try {
    const j = await fetch('/api/individual-learning').then((r) => r.json());
    ilView.records = j.records || [];
  } catch { ilView.records = []; }
}

async function renderIllearn() {
  setNav('illearn');
  app().innerHTML = `<div class="wrap"><div class="loading-screen"><div class="spinner"></div>개별학습 내역을 불러오는 중…</div></div>`;
  await loadIlRecords();
  drawIllearn();
}

function drawIllearn() {
  const recs = ilView.records;
  const learning = recs.filter((r) => !ilDone(r)).length;
  const done = recs.filter(ilDone).length;
  app().innerHTML = `<div class="wrap">
    <div class="il-hero">
      <div>
        <h1>개별학습 <span class="il-hero-sub">사외교육 · 자격증 · 학위</span></h1>
        <p>사외 학습을 <b>등록</b>하고 학습률을 갱신하세요. <b>학습률 100% 달성 시 수료증</b>을 발급받을 수 있습니다.</p>
      </div>
      <button class="mini-btn" style="margin-top:0" onclick="toggleIlForm()">${ilView.form ? '✕ 등록 폼 닫기' : '＋ 개별학습 등록'}</button>
    </div>
    <div class="il-stat-row">
      <div class="il-stat"><div class="k">전체 등록</div><div class="v num">${recs.length}</div></div>
      <div class="il-stat"><div class="k">학습중</div><div class="v num">${learning}</div></div>
      <div class="il-stat"><div class="k">이수 완료 (수료증)</div><div class="v num">${done}</div></div>
    </div>
    <div id="ilFormBox">${ilView.form ? ilFormHtml() : ''}</div>
    <div class="section-head" style="margin:26px 0 14px"><h2 style="font-size:18px">내 개별학습 목록</h2></div>
    ${recs.length ? `<div class="il-list">${recs.map(ilCardHtml).join('')}</div>`
      : '<div class="empty-box">아직 등록한 개별학습이 없어요.<br>사외교육·자격증·학위를 <b>등록</b>해 보세요.</div>'}
  </div>`;
}

function ilFormHtml() {
  const today = new Date().toISOString().slice(0, 10);
  return `<div class="il-form">
    <h3>개별학습 등록 <span class="muted" style="font-size:12px;font-weight:500">— 등록 즉시 학습이 시작되며, 학습률 100% 달성 시 수료증이 발급됩니다</span></h3>
    <div class="il-grid">
      <label class="il-lb">개별학습유형 *
        <select id="ilType" class="il-input">${IL_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select></label>
      <label class="il-lb">카테고리
        <input id="ilCategory" class="il-input" placeholder="예: 개발 / AI / 리더십" /></label>
      <label class="il-lb" style="grid-column:1/-1">교육명 *
        <input id="ilTitle" class="il-input" placeholder="예: Real Summit 2024 AI 컨퍼런스" maxlength="200" /></label>
      <label class="il-lb">교육발령기관
        <input id="ilOrg" class="il-input" placeholder="예: 엘타컨퍼런스 코리아" /></label>
      <label class="il-lb">장소
        <input id="ilPlace" class="il-input" placeholder="예: 삼성동 COEX" /></label>
      <label class="il-lb">시작일
        <input id="ilStart" type="date" class="il-input" value="${today}" /></label>
      <label class="il-lb">종료일
        <input id="ilEnd" type="date" class="il-input" value="${today}" /></label>
      <label class="il-lb">수료(취득)일
        <input id="ilComplete" type="date" class="il-input" /></label>
      <label class="il-lb">학습인정시간 (h)
        <input id="ilHours" type="number" class="il-input" min="0" step="0.5" placeholder="8" /></label>
      <label class="il-lb">비용 (원)
        <input id="ilCost" type="number" class="il-input" min="0" step="1000" placeholder="360000" /></label>
      <label class="il-lb">교통보험
        <select id="ilInsurance" class="il-input"><option>해당없음</option><option>환급</option><option>미환급</option></select></label>
      <label class="il-lb" style="grid-column:1/-1">첨부파일 (교육안내·신청서 등)
        <input id="ilAttach" class="il-input" placeholder="파일명 입력 (데모)" /></label>
      <label class="il-lb" style="grid-column:1/-1">교육내용
        <textarea id="ilContent" class="il-input" rows="3" placeholder="교육 목적, 커리큘럼, 기대효과 등을 적어주세요."></textarea></label>
    </div>
    <div class="il-form-actions">
      <button class="btn-ghost-sm" onclick="toggleIlForm()">취소</button>
      <button class="mini-btn" style="margin-top:0" onclick="submitIlRequest()">등록하기</button>
    </div>
  </div>`;
}

function ilCardHtml(r) {
  const st = IL_STATUS_LABEL[r.status] || { t: r.status, cls: 'wait' };
  const done = ilDone(r);
  const prog = ilProg(r);
  const period = `${r.startDate || ''}${r.endDate ? ' ~ ' + r.endDate : ''}`;
  return `<div class="il-card">
    <div class="il-card-top">
      <span class="il-type">${esc(r.ltype)}</span>
      <span class="il-badge ${st.cls}">${st.t}</span>
      <span class="il-date muted">등록 ${esc((r.requestedAt || '').slice(0, 10))}</span>
    </div>
    <div class="il-title">${esc(r.title)}</div>
    <div class="il-meta">
      ${r.org ? `<span>🏢 ${esc(r.org)}</span>` : ''}
      ${r.place ? `<span>📍 ${esc(r.place)}</span>` : ''}
      ${period.trim() ? `<span>🗓 ${esc(period)}</span>` : ''}
      ${r.hours ? `<span>⏱ 인정 ${esc(String(r.hours))}시간</span>` : ''}
      ${r.cost ? `<span>💰 ${Number(r.cost).toLocaleString()}원</span>` : ''}
    </div>
    <div style="display:flex;align-items:center;gap:10px;margin-top:12px">
      <div class="progress" style="flex:1;margin:0"><span style="width:${prog}%"></span></div>
      <span class="num" style="font-size:12.5px;font-weight:700;min-width:44px;text-align:right">${prog}%</span>
      ${!done ? `<input id="ilProg${r.id}" type="number" min="0" max="100" step="5" value="${prog}" style="width:64px;padding:6px 8px;border:1px solid #d6dbe2;border-radius:8px;font-size:12.5px" />
        <button class="btn-ghost-sm" style="white-space:nowrap" onclick="updateIlProgress(${r.id})">학습률 갱신</button>` : ''}
    </div>
    ${done ? `<div class="il-note done">🎓 이수 완료 — 수료증이 발급되었습니다.${r.certNo ? ` <b>${esc(r.certNo)}</b>` : ''}${r.hours ? ` (인정시간 ${esc(String(r.hours))}h)` : ''}</div>`
      : prog >= 100 ? `<div class="il-note ok">✅ 학습률 100% 달성! 아래 버튼으로 <b>수료증을 발급</b>받으세요.</div>` : ''}
    <div class="il-card-actions">
      ${!done && prog >= 100 ? `<button class="mini-btn" style="margin-top:0" onclick="issueIlCert(${r.id})">🎓 수료증 발급</button>` : ''}
      ${done ? `<button class="mini-btn" style="margin-top:0" onclick="showIlCert(${r.id})">🏅 수료증 보기</button>` : ''}
      ${!done ? `<button class="btn-ghost-sm" onclick="cancelIl(${r.id})">등록 삭제</button>` : ''}
    </div>
  </div>`;
}

window.toggleIlForm = () => {
  ilView.form = !ilView.form;
  const box = $('#ilFormBox');
  if (box) box.innerHTML = ilView.form ? ilFormHtml() : '';
  // 버튼 라벨 갱신
  const btn = document.querySelector('.il-hero .mini-btn');
  if (btn) btn.textContent = ilView.form ? '✕ 등록 폼 닫기' : '＋ 개별학습 등록';
  if (ilView.form && box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.submitIlRequest = async () => {
  const payload = {
    ltype: $('#ilType').value,
    title: $('#ilTitle').value.trim(),
    category: $('#ilCategory').value.trim(),
    org: $('#ilOrg').value.trim(),
    place: $('#ilPlace').value.trim(),
    startDate: $('#ilStart').value || null,
    endDate: $('#ilEnd').value || null,
    completeDate: $('#ilComplete').value || null,
    hours: Number($('#ilHours').value) || 0,
    cost: Number($('#ilCost').value) || 0,
    insurance: $('#ilInsurance').value,
    attachment: $('#ilAttach').value.trim(),
    content: $('#ilContent').value.trim(),
  };
  if (!payload.title) { toast('교육명을 입력해 주세요'); $('#ilTitle')?.focus(); return; }
  try {
    const r = await fetch('/api/individual-learning', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const j = await r.json();
    if (!r.ok) { toast('신청 실패: ' + (j.error || r.status)); return; }
    ilView.records.unshift(j.record);
    ilView.form = false;
    drawIllearn();
    toast('개별학습이 등록되었습니다. 학습률 100% 달성 시 수료증을 발급받을 수 있어요 🎓');
  } catch (e) { toast('등록 실패: ' + e.message); }
};

window.updateIlProgress = async (id) => {
  const input = $('#ilProg' + id);
  const progress = Math.min(100, Math.max(0, Number(input?.value) || 0));
  try {
    const r = await fetch('/api/individual-learning/progress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, progress }),
    });
    const j = await r.json();
    if (!r.ok) { toast('갱신 실패: ' + (j.error || r.status)); return; }
    const i = ilView.records.findIndex((x) => x.id === id);
    if (i >= 0) ilView.records[i] = j.record;
    drawIllearn();
    toast(progress >= 100 ? '학습률 100% 달성! 수료증을 발급받으세요 🎓' : `학습률 ${progress}% 반영되었습니다`);
  } catch (e) { toast('갱신 실패: ' + e.message); }
};

window.issueIlCert = async (id) => {
  try {
    const r = await fetch('/api/individual-learning/certificate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const j = await r.json();
    if (!r.ok) { toast('발급 실패: ' + (j.error || r.status)); return; }
    const i = ilView.records.findIndex((x) => x.id === id);
    if (i >= 0) ilView.records[i] = j.record;
    drawIllearn();
    toast('🎓 수료증이 발급되었습니다!');
    showIlCert(id);
  } catch (e) { toast('발급 실패: ' + e.message); }
};

function ilCertHtml(r) {
  const period = `${r.startDate || ''}${r.endDate ? ' ~ ' + r.endDate : ''}`.trim();
  return `<div id="ilCertPaper" style="background:#fff;color:#1a1c1f;border:3px double #2a78d6;border-radius:12px;padding:34px 30px;text-align:center;font-family:inherit">
    <div style="font-size:12px;letter-spacing:4px;color:#5f676f">CERTIFICATE OF COMPLETION</div>
    <div style="font-size:30px;font-weight:800;margin:10px 0 4px;color:#1c5cab">수 료 증</div>
    <div style="font-size:12px;color:#8b93a1">${esc(r.certNo || '')}</div>
    <div style="margin:24px 0 6px;font-size:20px;font-weight:700">${esc(r.userName || state.user?.name || '')}</div>
    <div style="font-size:13px;color:#5f676f">${esc(r.dept || '')}</div>
    <div style="margin:20px auto;max-width:420px;border-top:1px solid #e4e8ee;border-bottom:1px solid #e4e8ee;padding:16px 6px;font-size:14.5px;line-height:1.8">
      <b>${esc(r.title)}</b><br>
      <span style="font-size:12.5px;color:#5f676f">${esc(r.ltype)}${r.org ? ' · ' + esc(r.org) : ''}${period ? ' · ' + esc(period) : ''}${r.hours ? ' · 인정시간 ' + esc(String(r.hours)) + 'h' : ''}</span>
    </div>
    <div style="font-size:13px;line-height:1.8;color:#40454d">위 사람은 상기 과정을 성실히 이수하여 (학습률 100%)<br>이 증서를 수여합니다.</div>
    <div style="margin-top:22px;font-size:13px;color:#5f676f">${esc((r.certIssuedAt || '').slice(0, 10))}</div>
    <div style="margin-top:8px;font-size:15px;font-weight:800">EST family LMS 교육담당자</div>
  </div>`;
}

window.showIlCert = (id) => {
  const r = ilView.records.find((x) => x.id === id);
  if (!r) return;
  modal(`<h3>수료증 <button class="close" onclick="closeModal()">✕</button></h3>
    ${ilCertHtml(r)}
    <button class="mini-btn" style="margin-top:14px;width:100%" onclick="printIlCert(${id})">🖨 인쇄 / PDF 저장</button>`);
};

window.printIlCert = (id) => {
  const r = ilView.records.find((x) => x.id === id);
  if (!r) return;
  const w = window.open('', '_blank', 'width=760,height=900');
  if (!w) { toast('팝업이 차단되었습니다. 팝업 허용 후 다시 시도해 주세요'); return; }
  w.document.write(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>수료증 - ${esc(r.title)}</title>
    <style>body{font-family:"Pretendard",-apple-system,"Malgun Gothic",sans-serif;background:#fff;margin:0;padding:40px;display:flex;justify-content:center}</style>
    </head><body><div style="max-width:640px;width:100%">${ilCertHtml(r)}</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
  w.document.close();
};

window.cancelIl = async (id) => {
  if (!confirm('이 개별학습 등록을 삭제할까요?')) return;
  try {
    const r = await fetch('/api/individual-learning?id=' + id, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast('삭제 실패: ' + (j.error || r.status)); return; }
    ilView.records = ilView.records.filter((x) => x.id !== id);
    drawIllearn();
    toast('등록을 삭제했습니다');
  } catch (e) { toast('삭제 실패: ' + e.message); }
};

// ================= 라우터 =================
function route() {
  clearTimers();
  closeModal();
  const hash = location.hash || '#/';
  const [pathPart, queryPart] = hash.slice(1).split('?');
  const params = new URLSearchParams(queryPart || '');
  const parts = pathPart.split('/').filter(Boolean); // e.g. ['course','123']
  window.scrollTo(0, 0);
  if (!state.catalog) { boot(); return; }

  // PIP 멀티태스킹: 재생 중 학습창을 벗어나(플레이어 영역이 가려지는 시점) 미니 플레이어로 이어서 시청
  const isLearn = parts[0] === 'learn';
  if (!isLearn && player.course && !player.pip) {
    if (player.playing) enterPip();
    else stopTicker(); // 일시정지 상태로 이탈 → 재생 위치만 보존
  }

  // 관리자는 사용자용 개인 화면(내 학습·개별학습·마이페이지) 접근 차단 → 홈으로
  if (state.user?.role === 'admin' && (parts[0] === 'my' || parts[0] === 'mypage' || parts[0] === 'illearn')) { go('#/'); return; }

  if (parts[0] === 'course' && parts[1]) return renderCourseDetail(parts[1]);
  if (parts[0] === 'learn' && parts[1]) return renderPlayer(parts[1]);
  if (parts[0] === 'courses') return renderCourses(params);
  if (parts[0] === 'search') { go('#/'); return; } // 검색 페이지 제거 → 홈(추천 배너)으로
  if (parts[0] === 'apply') return renderApply();
  if (parts[0] === 'recommend') return renderRecommend();
  if (parts[0] === 'my') return renderMy();
  if (parts[0] === 'illearn') return renderIllearn();
  if (parts[0] === 'mypage') return renderMypage();
  if (parts[0] === 'onboarding') { location.href = '/onboarding'; return; }
  return renderHome();
}

// 헤더 검색 → 전체강의(키워드 브라우즈)
window.headerSearch = (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) { saveRecent(v); go('#/courses?q=' + encodeURIComponent(v)); } } };

// ---------- 추천 검색어 (관리자 등록) — 헤더 검색창 제안 패널 + 플레이스홀더 로테이션 ----------
function saveRecent(q) {
  state.recent = [q, ...state.recent.filter((r) => r !== q)].slice(0, 6);
  localStorage.setItem('lms_recent', JSON.stringify(state.recent));
}
function initSearchSuggest() {
  const box = document.querySelector('.searchbox'); const input = $('#hdrSearch');
  if (!box || !input || box.querySelector('.search-suggest')) return;
  const panel = document.createElement('div');
  panel.className = 'search-suggest'; panel.style.display = 'none';
  box.appendChild(panel);
  const draw = () => {
    const kws = state.searchKeywords || [];
    const rec = state.recent || [];
    if (!kws.length && !rec.length) { panel.style.display = 'none'; return; }
    panel.innerHTML = `
      ${kws.length ? `<div class="ss-h">🔥 추천 검색어</div><div class="ss-chips">${kws.map((k) => `<button class="ss-chip" data-q="${esc(k)}">${esc(k)}</button>`).join('')}</div>` : ''}
      ${rec.length ? `<div class="ss-h">최근 검색어</div>${rec.map((r, i) => `<div class="ss-row" data-q="${esc(r)}"><span>🕘 ${esc(r)}</span><button class="ss-del" data-i="${i}">✕</button></div>`).join('')}` : ''}`;
    panel.style.display = 'block';
  };
  input.addEventListener('focus', draw);
  input.addEventListener('blur', () => setTimeout(() => { panel.style.display = 'none'; }, 150));
  panel.addEventListener('mousedown', (e) => {
    e.preventDefault(); // input blur 방지
    const del = e.target.closest('.ss-del');
    if (del) {
      state.recent.splice(Number(del.dataset.i), 1);
      localStorage.setItem('lms_recent', JSON.stringify(state.recent));
      draw(); return;
    }
    const it = e.target.closest('[data-q]');
    if (it) {
      const q = it.dataset.q;
      input.value = q; panel.style.display = 'none'; input.blur();
      saveRecent(q);
      go('#/courses?q=' + encodeURIComponent(q));
    }
  });
  // 노출 중인 추천 검색어를 플레이스홀더로 순환 표시
  const kws = state.searchKeywords || [];
  if (kws.length) {
    let i = 0;
    input.placeholder = `추천 검색어: ${kws[0]}`;
    setInterval(() => {
      i = (i + 1) % kws.length;
      if (document.activeElement !== input && !input.value) input.placeholder = `추천 검색어: ${kws[i]}`;
    }, 3500);
  }
}

// ================= 수강 신청 =================
const applyView = { q: '', selected: null, result: null };
function renderApply() {
  setNav('apply');
  drawApply();
}
function drawApply() {
  const sel = applyView.selected ? state.courseById.get(applyView.selected) : null;
  const matches = applyView.q
    ? state.catalog.courses.filter((c) => c.title.toLowerCase().includes(applyView.q.toLowerCase())).slice(0, 8) : [];
  app().innerHTML = `<div class="wrap">
    <div class="section-head" style="margin-top:26px"><h2>수강 신청</h2></div>
    <div class="apply-grid">
      <div class="apply-card">
        <h3>① 강의 선택 & 수강 가능여부 확인</h3>
        <input class="apply-input" placeholder="강의명으로 검색 (예: 쿠버네티스, RAG)" value="${esc(applyView.q)}"
          oninput="applyView.q=this.value;applyView.selected=null;drawApply();document.querySelector('.apply-input').focus();document.querySelector('.apply-input').setSelectionRange(this.value.length,this.value.length)">
        ${matches.length && !sel ? `<div class="apply-matches">${matches.map((c) => `<div onclick="applyView.selected=${c.id};applyView.q=${JSON.stringify(c.title).replace(/"/g, '&quot;')};drawApply()">${esc(c.title)} <small>${esc(c.level || '')}</small></div>`).join('')}</div>` : ''}
        ${sel ? `<div class="apply-sel">
            <img src="${esc(sel.thumbnailUrl || '')}" onerror="this.style.opacity=0">
            <div><b>${esc(sel.title)}</b><div class="muted" style="font-size:12px">${esc(sel.instructorName || '')} · ${esc(sel.level || '')} · ${priceLabel(sel.regularPrice)}</div></div>
          </div>
          <button class="mini-btn" onclick="checkEnroll(${sel.id})">수강 가능여부 확인</button>` : '<div class="muted" style="font-size:13px;margin-top:8px">강의를 검색해 선택하세요.</div>'}
        <div id="applyResult">${applyView.result || ''}</div>
      </div>
      <div class="apply-card">
        <h3>② 수강신청 (수강권 발급)</h3>
        <label class="apply-lb">수강 기간 (만료일 설정)</label>
        <select id="applyMonths" class="apply-input"><option value="3">3개월</option><option value="6" selected>6개월</option><option value="12">12개월</option></select>
        <label class="apply-lb">승인 방식</label>
        <select id="applyApprove" class="apply-input"><option value="auto" selected>자동승인</option><option value="manual">관리자 승인 후 수강</option></select>
        <button class="mini-btn" style="margin-top:12px" onclick="applyEnroll()">수강신청 하기</button>
        <div class="muted" style="font-size:12px;margin-top:10px">신청 내역은 [내 학습 → 내 수강권 목록]에서 확인합니다.</div>
      </div>
      <div class="apply-card">
        <h3>③ 수강코드 등록</h3>
        <div class="muted" style="font-size:13px;margin-bottom:8px">관리자에게 받은 수강코드가 있다면 등록하세요.</div>
        <input id="applyCode" class="apply-input" placeholder="예: EST-2026-XXXX">
        <button class="mini-btn" style="margin-top:10px" onclick="registerCode()">코드 등록</button>
      </div>
    </div>
    <div id="ccUserSec"></div>
    <div id="apprUserSec"></div>
  </div>`;
  drawApplyExtras();
  loadApplyExtras();
}

// ---- 사내 개설 과정 + 개별학습(사외교육) 요약 ----
async function loadApplyExtras() {
  if (state.customCourses && state.myIl) return;
  try {
    const [cc, il] = await Promise.all([
      fetch('/api/custom-courses').then((r) => r.json()),
      fetch('/api/individual-learning').then((r) => r.json()),
    ]);
    state.customCourses = cc.courses || [];
    state.myIl = il.records || [];
    drawApplyExtras();
  } catch { /* 서버 미지원 시 섹션 생략 */ }
}
async function reloadApplyExtras() {
  state.customCourses = null; state.myIl = null;
  await loadApplyExtras();
}

const upill = (s) => `<span class="upill ${s === '승인' || s === '수료' ? 'ok' : s === '반려' ? 'bad' : s === '취소' ? 'zero' : 'warn'}">${s}</span>`;

function drawApplyExtras() {
  const ccSec = $('#ccUserSec'), apSec = $('#apprUserSec');
  if (!ccSec || !apSec) return;

  // ① 사내 개설 과정 (운영중 과정 — 신청형은 즉시 입과, 선발형은 승인 후 입과)
  const list = (state.customCourses || []).filter((c) => c.status === '운영중');
  ccSec.innerHTML = list.length ? `
    <div class="section-head" style="margin-top:38px"><h2>사내 개설 과정 <span class="muted" style="font-size:13px">교육담당자가 개설한 자체 교육과정</span></h2></div>
    <div class="ccu-grid">${list.map((c) => {
      const resSum = {};
      (c.resources || []).forEach((r) => { resSum[r.type] = (resSum[r.type] || 0) + 1; });
      const m = c.mine;
      const action = !m
        ? `<button class="mini-btn" onclick="ccApply('${c.id}')">수강신청${c.entry === '선발형' ? ' (선발제)' : ''}</button>`
        : m.status === '신청대기' ? '<span class="upill warn">선발 승인 대기중</span>'
        : m.status === '수료' ? '<span class="upill ok">🏅 수료 완료</span>'
        : `<span class="upill warn">학습중 ${m.progress}%</span> <button class="mini-btn" style="padding:7px 12px" onclick="ccuProgress('${c.id}',${m.progress})">▶ 학습 진행 (데모)</button>`;
      return `<div class="ccu-card">
        <div class="ccu-badges"><span>${esc(c.type || '온라인')}</span><span>${esc(c.category || '')}</span><span>${esc(c.entry || '신청형')}</span></div>
        <div class="ccu-title">${esc(c.title)}</div>
        <div class="ccu-meta">${esc((c.startDate || '').slice(0, 10))} ~ ${esc((c.endDate || '상시').slice(0, 10))} · 학습인정 ${c.hours || 0}시간 · 수료기준 ${c.completeRate ?? 80}%</div>
        <div class="ccu-res">${Object.entries(resSum).map(([k, v]) => `<span>${esc(k)} ${v}</span>`).join('')}</div>
        ${c.desc ? `<div class="ccu-desc">${esc(c.desc)}</div>` : ''}
        <div class="ccu-foot">${action}<span class="muted" style="font-size:11.5px">수강 ${c.learnerCount}명 · 수료 ${c.completedCount}명</span></div>
      </div>`;
    }).join('')}</div>` : '';

  // ② 개별학습 (사외교육·자격증·학위) — 등록 → 학습률 100% → 수료증 발급
  const ilRecs = state.myIl || [];
  const ilLearning = ilRecs.filter((r) => !ilDone(r));
  const ilCompleted = ilRecs.filter(ilDone);
  apSec.innerHTML = `
    <div class="section-head" style="margin-top:38px"><h2>개별학습 <span class="muted" style="font-size:13px">사외교육·자격증·학위 — 등록 후 학습률 100% 달성 시 수료증 발급</span></h2></div>
    <div class="apply-grid" style="grid-template-columns:1fr 1.5fr">
      <div class="apply-card">
        <h3>개별학습 등록</h3>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">사전신청·승인 절차 없이 바로 등록하고 학습을 시작하세요. 학습률 100%가 되면 수료증을 발급받을 수 있습니다.</div>
        <div style="display:flex;gap:10px;margin:14px 0">
          <div style="flex:1;text-align:center;background:#f7f9fb;border:1px solid #e4e8ee;border-radius:10px;padding:12px 6px"><div class="muted" style="font-size:11.5px">전체 등록</div><b style="font-size:20px">${ilRecs.length}</b></div>
          <div style="flex:1;text-align:center;background:#f7f9fb;border:1px solid #e4e8ee;border-radius:10px;padding:12px 6px"><div class="muted" style="font-size:11.5px">학습중</div><b style="font-size:20px">${ilLearning.length}</b></div>
          <div style="flex:1;text-align:center;background:#f7f9fb;border:1px solid #e4e8ee;border-radius:10px;padding:12px 6px"><div class="muted" style="font-size:11.5px">수료증</div><b style="font-size:20px">${ilCompleted.length}</b></div>
        </div>
        <button class="mini-btn" style="width:100%" onclick="go('#/illearn')">＋ 개별학습 등록·관리 바로가기</button>
      </div>
      <div class="apply-card">
        <h3>내 개별학습 현황</h3>
        ${ilRecs.length ? `<table class="appr-table"><thead><tr><th>교육명</th><th>기간</th><th>학습률</th><th>수료증</th></tr></thead><tbody>
          ${ilRecs.slice(0, 6).map((r) => `<tr>
              <td><b>${esc(r.title)}</b><div class="muted" style="font-size:11px">${esc(r.ltype)}${r.org ? ' · ' + esc(r.org) : ''}</div></td>
              <td class="num" style="white-space:nowrap;font-size:11.5px">${esc((r.startDate || '-').slice(0, 10))}<br>~ ${esc((r.endDate || '-').slice(0, 10))}</td>
              <td class="num" style="white-space:nowrap">${ilProg(r)}%</td>
              <td>${ilDone(r) ? '<span class="upill ok">🏅 발급</span>' : ilProg(r) >= 100 ? '<span class="upill warn">발급 가능</span>' : '<span class="muted">-</span>'}</td>
            </tr>`).join('')}
        </tbody></table>` : '<div class="muted" style="font-size:13px;padding:20px 0;text-align:center">등록된 개별학습이 없습니다.<br>사외교육·자격증·학위를 등록해 보세요.</div>'}
        <div class="muted" style="font-size:11.5px;margin-top:10px">💡 학습률 100% 달성 시 <b>개별학습</b> 메뉴에서 수료증을 발급·인쇄할 수 있습니다.</div>
      </div>
    </div>`;
}

window.ccApply = async (courseId) => {
  try {
    const r = await fetch('/api/custom-courses/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId }) });
    const j = await r.json();
    if (!r.ok) { toast('신청 실패: ' + (j.error || r.status)); return; }
    toast(j.status === '신청대기' ? '신청 완료! 선발 승인 후 입과됩니다 📋' : '수강신청 완료! 바로 학습을 시작하세요 🎉');
    await reloadApplyExtras();
  } catch (e) { toast('신청 실패: ' + e.message); }
};
window.ccuProgress = async (courseId, cur) => {
  try {
    const r = await fetch('/api/custom-courses/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId, progress: Math.min(100, (cur || 0) + 25) }) });
    const j = await r.json();
    if (!r.ok) { toast(j.error || '진도 반영 실패'); return; }
    toast(j.learner.status === '수료' ? '🎓 수료 완료! 수료증이 발급되었습니다' : `진도 ${j.learner.progress}% 반영되었습니다`);
    await reloadApplyExtras();
  } catch (e) { toast('진도 반영 실패: ' + e.message); }
};
// (사전신청/결과보고 플로우 제거 — 개별학습은 등록 → 학습률 100% → 수료증 발급으로 단순화)
window.checkEnroll = async (courseId) => {
  const uuid = state.user?.uuid || 'es12';
  applyView.result = '<div class="muted" style="margin-top:10px">확인 중…</div>'; $('#applyResult').innerHTML = applyView.result;
  try {
    const r = await fetch(`/api/check-enrollment?uuid=${encodeURIComponent(uuid)}&courseId=${courseId}`).then((x) => x.json());
    const ok = r.code === 'SUCCESS';
    const detail = r.data ? Object.entries(r.data).map(([k, v]) => `${esc(k)}: ${esc(JSON.stringify(v))}`).join(' · ') : esc(r.message || '');
    applyView.result = `<div class="apply-res ${ok ? 'ok' : 'no'}">${ok ? '✅ 조회 성공' : '⚠ ' + esc(r.message || '조회 실패')}${detail ? `<div class="muted" style="font-size:12px;margin-top:4px">${detail}</div>` : ''}</div>`;
  } catch (e) { applyView.result = `<div class="apply-res no">⚠ ${esc(e.message)}</div>`; }
  drawApply();
};
window.applyEnroll = async () => {
  if (!applyView.selected) { toast('먼저 강의를 선택하세요'); return; }
  const c = state.courseById.get(applyView.selected);
  const existing = requestForCourse(applyView.selected);
  if (existing && existing.status === 'pending') { toast('이미 승인 대기 중인 신청이 있어요'); return; }
  if (existing && existing.status === 'approved' || alreadyEnrolled(applyView.selected)) { toast('이미 수강 중인 강의예요'); go('#/my'); return; }
  try {
    const r = await fetch('/api/enrollments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: applyView.selected, courseTitle: c?.title, thumbnailUrl: c?.thumbnailUrl }),
    });
    const j = await r.json();
    if (!r.ok) { toast('신청 실패: ' + (j.error || r.status)); return; }
    state.myRequests = [j.request, ...(state.myRequests || []).filter((x) => String(x.courseId) !== String(applyView.selected))];
    toast('수강신청이 접수되었습니다. 관리자 승인 후 학습을 시작할 수 있어요 ⏳');
  } catch (e) { toast('신청 실패: ' + e.message); }
};
window.registerCode = () => {
  const v = $('#applyCode').value.trim();
  if (!v) { toast('수강코드를 입력하세요'); return; }
  toast(`수강코드 [${v}] 등록 완료 (데모)`);
};

// ================= 추천강좌 (역량진단 맞춤) =================
function renderRecommend() {
  setNav('recommend');
  const diag = getDiagnosis();
  const rec = recommendCourses();
  const compName = (k) => state.recConfig?.comps?.[k] || k;
  if (!diag) {
    app().innerHTML = `<div class="wrap"><div class="rec-hero">
      <h1>✨ 역량진단 맞춤 추천강좌</h1>
      <p>AI 역량진단(약 5분)을 완료하면 약점 역량과 난이도에 맞는 강의를 추천해 드립니다.</p>
      <a class="mini-btn" href="/diagnosis" style="font-size:15px;padding:12px 22px">🧭 AI 역량진단 시작하기</a>
    </div></div>`;
    return;
  }
  const weak = diag.weak || [];
  const cards = (rec?.items || []).map((it) => {
    const c = state.courseById.get(it.id);
    return `<div class="rcm-card" onclick="go('#/course/${it.id}')">
      <div class="rcm-thumb"><img loading="lazy" src="${esc(c?.thumbnailUrl || '')}" onerror="this.style.opacity=0">
        <span class="rcm-comp">${esc(it.comp)} ${esc(compName(it.comp))} · ${esc(it.lv)}</span></div>
      <div class="rcm-body">
        <div class="rcm-title">${esc(c?.title || it.title)}</div>
        <div class="rcm-why">💡 ${esc(it.why)}${it.indirect ? ' · 간접' : ''}</div>
        ${c ? `<div class="rcm-meta"><span>${esc(c.instructorName || '')}</span><span>★ ${(c.rating || 0).toFixed(1)}</span><span>${(c.studentCount || 0).toLocaleString()}명</span></div>` : ''}
        <button class="mini-btn" style="margin-top:10px" onclick="event.stopPropagation();go('#/apply')">수강신청 →</button>
      </div></div>`;
  }).join('');
  app().innerHTML = `<div class="wrap">
    <div class="rec-hero">
      <h1>✨ ${esc(state.user?.name || '')}님 역량진단 맞춤 추천</h1>
      <div class="rec-chips">
        <span class="rb-lv">판정 레벨 · ${esc(diag.level)}</span>
        <span class="rb-lv" style="background:${weak.length ? '#ffecec;color:#c0353a' : '#dcf9ec'}">약점 ${weak.length ? weak.map((k) => k + ' ' + compName(k)).join(' · ') : '없음'}</span>
        <a class="rb-redo" href="/diagnosis" style="margin-left:6px">진단 다시 하기 ↻</a>
      </div>
      <div class="rec-scores">${['E', 'V', 'O', 'F'].map((k) => { const v = diag.avg?.[k] ?? 0; const wk = weak.includes(k); return `
        <div class="rec-score ${wk ? 'weak' : ''}"><span class="k">${k} ${esc(compName(k))}</span>
          <div class="progress"><span style="width:${v / 5 * 100}%"></span></div><span class="v num">${v.toFixed(1)}</span></div>`; }).join('')}</div>
    </div>
    <div class="section-head" style="margin-top:26px"><h2 style="font-size:18px">추천 강의 <span class="muted num">${rec?.items?.length || 0}</span></h2></div>
    ${cards ? `<div class="rcm-grid">${cards}</div>` : '<div class="empty-box">추천 강의가 없습니다.</div>'}
    ${rec?.notes?.length ? `<div class="rcm-notes"><b>추천 기준 안내</b>${rec.notes.map((n) => `<div>· ${esc(n)}</div>`).join('')}</div>` : ''}
  </div>`;
}

// ================= 마이페이지 =================
function renderMypage() {
  setNav('mypage');
  const u = state.user || {};
  const enr = myEnrollments();
  const diag = getDiagnosis();
  const rec = recommendCourses();
  const fmtD = (s) => s ? String(s).slice(0, 10) : '-';
  app().innerHTML = `<div class="wrap">
    <div class="my-head"><div class="av">${esc((u.name || 'ME')[0])}</div>
      <div><h2>${esc(u.name || '')} <small class="muted" style="font-size:13px">${u.role === 'admin' ? '관리자' : '사용자'}</small></h2>
      <div class="muted">${esc(u.email || '')} · 사번 ${esc(u.uuid || '-')}</div></div>
    </div>

    <div class="section-head"><h2 style="font-size:18px">내 정보 관리</h2></div>
    <div class="apply-grid">
      <div class="apply-card">
        <label class="apply-lb">이름</label><input id="pfName" class="apply-input" value="${esc(u.name || '')}">
        <label class="apply-lb">사번 (UUID)</label><input id="pfUuid" class="apply-input" value="${esc(u.uuid || '')}" placeholder="예: es12">
        <label class="apply-lb">소속</label><input id="pfDept" class="apply-input" value="${esc(u.dept || '')}">
        <button class="mini-btn" style="margin-top:12px" onclick="saveProfile()">저장</button>
      </div>
      <div class="apply-card">
        <h3>비밀번호 변경</h3>
        <label class="apply-lb">현재 비밀번호</label><input id="pwCur" type="password" class="apply-input">
        <label class="apply-lb">새 비밀번호</label><input id="pwNew" type="password" class="apply-input" placeholder="4자 이상">
        <button class="mini-btn" style="margin-top:12px" onclick="changePw()">비밀번호 변경</button>
        <div id="pwMsg" class="muted" style="font-size:12px;margin-top:8px"></div>
      </div>
      <div class="apply-card">
        <h3>AI 역량진단 결과</h3>
        ${diag ? `
          <div style="font-size:15px;font-weight:800;margin:6px 0">판정 레벨 · ${esc(diag.level)} <small class="muted">(${fmtD(diag.at)})</small></div>
          ${['E', 'V', 'O', 'F'].map((k) => { const v = diag.avg?.[k] ?? 0; const wk = (diag.weak || []).includes(k); return `
            <div style="display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0">
              <span style="width:110px">${k} ${esc(state.recConfig?.comps?.[k] || '')} ${wk ? '<b style="color:#e5484d">약점</b>' : ''}</span>
              <div class="progress" style="flex:1"><span style="width:${v / 5 * 100}%"></span></div><span class="num">${v.toFixed(1)}</span>
            </div>`; }).join('')}
          <a class="mini-btn ghost" href="/diagnosis" style="margin-top:10px;display:inline-block">진단 다시 하기 ↻</a>
          <a class="mini-btn" onclick="go('#/recommend')" style="margin-top:10px;display:inline-block">맞춤 추천 보기 →</a>`
      : `<div class="muted" style="font-size:13px">아직 진단 이력이 없습니다.</div>
          <a class="mini-btn" href="/diagnosis" style="margin-top:10px;display:inline-block">🧭 AI 역량진단 시작</a>`}
      </div>
    </div>

    ${rec && rec.items?.length ? `<div class="section-head" style="margin-top:30px"><h2 style="font-size:18px">역량 추천 강의</h2><a onclick="go('#/recommend')">전체보기 ›</a></div>
      ${carousel('rail-rec', rec.items.map((it) => { const c = state.courseById.get(it.id); return c ? courseCard(c, { badge: 'pick' }) : ''; }).filter(Boolean))}` : ''}

    <div class="section-head" style="margin-top:30px"><h2 style="font-size:18px">내 수강권 목록</h2></div>
    ${enr.length ? `<div class="table-like">
      <div class="tl-head"><span>강의명</span><span>상태</span><span>진도율</span><span>수강신청일</span><span>만료일</span></div>
      ${enr.map((e) => `<div class="tl-row" onclick="go('#/learn/${e.courseId}')">
        <span class="tl-title">${esc(e.catTitle || e.courseTitle)}</span>
        <span>${e.completed ? '<b style="color:var(--green)">수료</b>' : e.progressRate > 0 ? '<b style="color:#4f7cff">학습중</b>' : '<span class="muted">미시작</span>'}</span>
        <span class="num">${e.progressRate.toFixed(1)}%</span>
        <span class="muted">${fmtD(e.createdAt)}</span>
        <span class="muted">${e.expiredAt ? fmtD(e.expiredAt) : '무제한'}</span>
      </div>`).join('')}</div>` : '<div class="empty-box">수강권이 없습니다.</div>'}
  </div>`;
}
window.saveProfile = async () => {
  const body = { name: $('#pfName').value.trim(), uuid: $('#pfUuid').value.trim(), dept: $('#pfDept').value.trim() };
  const r = await fetch('/api/auth/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) { state.user = (await r.json()).user; applyHeader(); toast('내 정보가 저장되었습니다'); renderMypage(); }
  else toast('저장 실패: ' + ((await r.json()).error || r.status));
};
window.changePw = async () => {
  const r = await fetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ current: $('#pwCur').value, next: $('#pwNew').value }) });
  const j = await r.json().catch(() => ({}));
  $('#pwMsg').textContent = r.ok ? '✅ 비밀번호가 변경되었습니다' : '⚠ ' + (j.error || '변경 실패');
  if (r.ok) { $('#pwCur').value = ''; $('#pwNew').value = ''; }
};

// ---------- 추가 스타일 (추천 배너 / 수강신청 / 마이페이지 / 검색 필터·추천 검색어) ----------
const extraCss = document.createElement('style');
extraCss.textContent = `
.sf-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 18px}
.sf-bar select{padding:9px 12px;border:1px solid #d6dbe2;border-radius:8px;font-size:13px;background:#fff;color:#40454d;font-weight:600;max-width:210px;cursor:pointer}
.sf-bar select:hover{border-color:#9aa2ad}
.sf-bar select:focus{outline:none;border-color:#2b6ef2}
.sf-reset{border:1px solid #ffd4d6;background:#fff5f5;border-radius:8px;padding:9px 14px;font-size:13px;color:#e5484d;font-weight:700}
.sf-reset:hover{border-color:#e5484d}
.search-suggest{position:absolute;top:calc(100% + 8px);left:0;right:0;background:#fff;border:1px solid #e4e8ee;border-radius:14px;box-shadow:0 12px 32px rgba(20,30,60,.14);padding:14px;z-index:60;max-height:420px;overflow-y:auto}
.ss-h{font-size:12px;font-weight:800;color:#8b93a1;margin:6px 0 8px}
.ss-chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:6px}
.ss-chip{background:#f0f7ff;border:1px solid #cfe0ff;color:#2b6ef2;border-radius:999px;padding:6px 13px;font-size:12.5px;font-weight:700;cursor:pointer}
.ss-chip:hover{background:#2b6ef2;color:#fff}
.ss-row{display:flex;justify-content:space-between;align-items:center;padding:7px 9px;border-radius:8px;font-size:13px;color:#40454d;cursor:pointer}
.ss-row:hover{background:#f6f8fa}
.ss-del{background:none;border:none;color:#9aa2b1;font-size:11px;padding:2px 4px}
.ss-del:hover{color:#e5484d}
.quick-chip.kw{border-color:#cfe0ff;background:#f0f7ff;color:#2b6ef2;font-weight:700}
.quick-chip.kw:hover{border-color:#2b6ef2;color:#1b56cf}
.quick-chip.kw.on{background:#2b6ef2;border-color:#2b6ef2;color:#fff}
.qna-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-top:8px}
.qna-sub{font-size:13px;color:#6b7280;margin:6px 0 18px}
.qna-form{background:#f7f9fb;border:1px solid #e4e8ee;border-radius:12px;padding:16px;margin-bottom:16px}
.qna-form.reply{background:#fff;margin:8px 0 0}
.qna-input{width:100%;box-sizing:border-box;border:1px solid #d6dbe2;border-radius:8px;padding:11px 13px;font-size:14px;font-weight:600;margin-bottom:10px}
.qna-textarea{width:100%;box-sizing:border-box;border:1px solid #d6dbe2;border-radius:8px;padding:11px 13px;font-size:14px;font-family:inherit;line-height:1.6;resize:vertical}
.qna-input:focus,.qna-textarea:focus{outline:none;border-color:#2b6ef2}
.qna-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.btn-ghost-sm{background:#fff;border:1px solid #d6dbe2;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;color:#5f676f}
.btn-ghost-sm:hover{border-color:#9aa2ad;color:#1b1e22}
.qna-list{display:flex;flex-direction:column;gap:14px}
.qna-item{border:1px solid #e7e9ee;border-radius:14px;padding:18px;background:#fff}
.qna-item:hover{box-shadow:0 4px 16px rgba(20,30,60,.06)}
.qna-q{display:flex;gap:12px}
.qna-avatar{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#2b6ef2,#7aa2ff);color:#fff;display:grid;place-items:center;font-size:13px;font-weight:800;flex-shrink:0}
.qna-avatar.sm{width:32px;height:32px;font-size:12px}
.qna-avatar.inst{background:linear-gradient(135deg,#00a862,#3ddc97)}
.qna-q-body{flex:1;min-width:0}
.qna-q-title{font-size:16px;font-weight:800;line-height:1.4;color:#1a1c1f}
.qna-q-text{font-size:14px;color:#40454d;line-height:1.7;margin-top:7px;white-space:pre-wrap}
.qna-meta{display:flex;align-items:center;gap:8px;font-size:12px;color:#9aa2b1;margin-top:9px;flex-wrap:wrap}
.qna-who{font-weight:700;color:#5f676f}
.qna-badge{font-size:11px;font-weight:700;border-radius:999px;padding:2px 9px}
.qna-badge.ok{background:#eafff4;color:#00a05d}
.qna-badge.wait{background:#fff4e5;color:#d98800}
.qna-del{background:none;border:none;color:#c0353a;font-size:12px;font-weight:600;cursor:pointer;padding:2px 4px;margin-left:auto}
.qna-del:hover{text-decoration:underline}
.qna-answers{margin:14px 0 0;padding-left:14px;border-left:2px solid #eef1f5;display:flex;flex-direction:column;gap:12px}
.qna-a{display:flex;gap:10px}
.qna-a.inst .qna-a-body{background:#f2fbf6;border:1px solid #cdeede;border-radius:10px;padding:10px 13px}
.qna-a-body{flex:1;min-width:0}
.qna-a-text{font-size:14px;color:#40454d;line-height:1.7;margin-top:5px;white-space:pre-wrap}
.qna-inst-badge{background:#00a862;color:#fff;font-size:10px;font-weight:800;border-radius:5px;padding:2px 7px}
.qna-answer-actions{margin-top:12px}
.btn-enroll.pending{background:#f0f2f5;color:#8b93a1;cursor:not-allowed}
.btn-enroll.pending:hover{background:#f0f2f5}
.btn-enroll.enrolled{background:#2b6ef2}
.btn-enroll.enrolled:hover{background:#1b56cf}
.enroll-note{font-size:12.5px;line-height:1.6;border-radius:8px;padding:9px 12px;margin-top:10px}
.enroll-note.pending{background:#fff7e6;color:#a86300;border:1px solid #ffe0a3}
.enroll-note.rejected{background:#fff1f1;color:#c0353a;border:1px solid #ffd0d2}
.enroll-note.ok{background:#eafff4;color:#00794b;border:1px solid #cdeede}
.new-pill{display:inline-block;background:#2b6ef2;color:#fff;font-size:10px;font-weight:800;border-radius:5px;padding:1px 6px;vertical-align:middle}
.dash-alert{position:relative}
.dash-alert.rejected{background:#fff1f1;border-color:#ffd0d2}
.alert-x{background:none;border:none;color:#c0353a;font-size:12px;font-weight:700;padding:2px 6px;margin-left:auto;flex-shrink:0}
.alert-x:hover{color:#8f1f24}
.il-hero{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;background:linear-gradient(120deg,#eef4ff,#f7fbff);border:1px solid #d6e4fb;border-radius:16px;padding:22px 26px;margin-top:22px}
.il-hero h1{margin:0 0 8px;font-size:22px}
.il-hero-sub{font-size:13px;font-weight:700;color:#2b6ef2;background:#e3edff;border-radius:999px;padding:3px 12px;vertical-align:middle;margin-left:6px}
.il-hero p{color:#5f676f;font-size:14px;margin:0}
.il-stat-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:16px}
.il-stat{background:#f6f8fa;border:1px solid #e7e9ee;border-radius:12px;padding:14px 18px}
.il-stat .k{font-size:12.5px;color:#6b7280;margin-bottom:6px}
.il-stat .v{font-size:24px;font-weight:800}
.il-form{background:#fff;border:1px solid #d6e4fb;border-radius:14px;padding:20px 22px;margin-top:18px;box-shadow:0 6px 20px rgba(20,50,120,.06)}
.il-form h3{margin:0 0 16px;font-size:16px}
.il-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
@media (max-width:680px){.il-grid{grid-template-columns:1fr}.il-stat-row{grid-template-columns:1fr}}
.il-lb{display:flex;flex-direction:column;gap:5px;font-size:12.5px;font-weight:700;color:#5f676f}
.il-input{border:1px solid #d6dbe2;border-radius:8px;padding:10px 12px;font-size:14px;font-family:inherit;font-weight:400;color:#1a1c1f;width:100%;box-sizing:border-box}
.il-input:focus{outline:none;border-color:#2b6ef2}
textarea.il-input{resize:vertical}
.il-form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.il-list{display:flex;flex-direction:column;gap:14px}
.il-card{border:1px solid #e7e9ee;border-radius:14px;padding:18px 20px;background:#fff}
.il-card:hover{box-shadow:0 4px 16px rgba(20,30,60,.06)}
.il-card-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.il-type{font-size:11px;font-weight:800;color:#2b6ef2;background:#e3edff;border-radius:6px;padding:3px 9px}
.il-badge{font-size:11px;font-weight:800;border-radius:999px;padding:3px 10px}
.il-badge.wait{background:#fff4e5;color:#d98800}
.il-badge.ok{background:#e3edff;color:#1b56cf}
.il-badge.no{background:#fff1f1;color:#c0353a}
.il-badge.done{background:#eafff4;color:#00a05d}
.il-date{font-size:12px;margin-left:auto}
.il-title{font-size:16.5px;font-weight:800;line-height:1.4;color:#1a1c1f}
.il-meta{display:flex;flex-wrap:wrap;gap:14px;font-size:13px;color:#5f676f;margin-top:8px}
.il-note{font-size:12.5px;line-height:1.6;border-radius:8px;padding:9px 12px;margin-top:12px}
.il-note.wait{background:#fff7e6;color:#a86300;border:1px solid #ffe0a3}
.il-note.ok{background:#e3edff;color:#1b56cf;border:1px solid #c5d9fb}
.il-note.no{background:#fff1f1;color:#c0353a;border:1px solid #ffd0d2}
.il-note.done{background:#eafff4;color:#00794b;border:1px solid #cdeede}
.il-result{margin-top:12px;background:#f7f9fb;border:1px solid #e7e9ee;border-radius:10px;padding:12px 14px;font-size:13.5px;color:#40454d;line-height:1.7}
.il-result b{display:block;font-size:12px;color:#8b93a1;margin-bottom:4px}
.il-card-actions{display:flex;gap:8px;margin-top:14px}
.rec-banner{background:linear-gradient(120deg,#eafff4,#f0f7ff);border:1px solid #cdeede;border-radius:14px;padding:18px 20px;margin:18px 0}
.rec-banner.empty{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.rb-head{font-size:16px;font-weight:800;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rb-lv{font-size:12px;font-weight:700;color:#00a05d;background:#dcf9ec;border-radius:999px;padding:3px 10px}
.rb-redo{margin-left:auto;font-size:12px;color:#5f676f;text-decoration:none}
.rb-sub{font-size:13px;color:#5f676f}
.rb-rail{display:flex;gap:12px;overflow-x:auto;padding:12px 2px 4px}
.rb-card{flex:0 0 250px;background:#fff;border:1px solid #e4e8ee;border-radius:12px;overflow:hidden;cursor:pointer}
.rb-card img{width:100%;height:98px;object-fit:cover;display:block;background:#eef1f5}
.rb-body{padding:10px 12px}
.rb-tag{font-size:11px;font-weight:700;color:#00a05d;background:#eafff4;border-radius:6px;padding:2px 7px}
.rb-title{font-size:13px;font-weight:700;margin:7px 0 4px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.rb-why{font-size:11.5px;color:#8b93a1}
.rb-notes{font-size:12px;color:#7d8590;margin-top:8px;line-height:1.7}
.quick-chip.comp{border-color:#bfe9d6;background:#f4fdf9;color:#00794b;font-weight:700}
.quick-chip.comp.on{background:#00c471;border-color:#00c471;color:#fff}
.rec-hero{background:linear-gradient(120deg,#eafff4,#f0f7ff);border:1px solid #cdeede;border-radius:16px;padding:26px 28px;margin-top:22px}
.rec-hero h1{margin:0 0 10px;font-size:22px}
.rec-hero p{color:#5f676f;font-size:14px;margin:0 0 14px}
.rec-chips{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.rec-scores{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 22px}
.rec-score{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:600;color:#5f676f}
.rec-score .k{width:120px;flex-shrink:0}
.rec-score .progress{flex:1}
.rec-score.weak .k{color:#c0353a;font-weight:800}
.rcm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(255px,1fr));gap:16px}
.rcm-card{background:#fff;border:1px solid #e4e8ee;border-radius:14px;overflow:hidden;cursor:pointer;transition:box-shadow .15s,transform .15s}
.rcm-card:hover{box-shadow:0 10px 24px rgba(20,30,60,.1);transform:translateY(-2px)}
.rcm-thumb{position:relative}
.rcm-thumb img{width:100%;height:130px;object-fit:cover;display:block;background:#eef1f5}
.rcm-comp{position:absolute;left:10px;bottom:10px;font-size:11px;font-weight:800;color:#fff;background:rgba(0,150,90,.92);border-radius:6px;padding:3px 9px}
.rcm-body{padding:13px 15px 15px}
.rcm-title{font-size:14px;font-weight:700;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:39px}
.rcm-why{font-size:12px;color:#00794b;margin:7px 0 5px}
.rcm-meta{display:flex;gap:8px;font-size:12px;color:#8b93a1}
.rcm-notes{margin-top:20px;background:#f7f9fb;border:1px solid #e4e8ee;border-radius:12px;padding:14px 18px;font-size:12.5px;color:#5f676f;line-height:1.8}
.rcm-notes b{display:block;margin-bottom:4px;color:#40454d}
.apply-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.apply-card{background:#fff;border:1px solid #e4e8ee;border-radius:14px;padding:20px}
.apply-card h3{margin:0 0 12px;font-size:15px}
.apply-input{width:100%;box-sizing:border-box;border:1px solid #d6dbe2;border-radius:8px;padding:10px 12px;font-size:14px;margin-top:4px}
.apply-lb{display:block;font-size:12px;font-weight:600;color:#5f676f;margin-top:12px}
.apply-matches{border:1px solid #e4e8ee;border-radius:8px;margin-top:6px;overflow:hidden}
.apply-matches div{padding:9px 12px;font-size:13px;cursor:pointer;border-bottom:1px solid #f0f2f5}
.apply-matches div:hover{background:#f6f9fc}
.apply-sel{display:flex;gap:10px;align-items:center;margin:12px 0;font-size:14px}
.apply-sel img{width:84px;height:52px;object-fit:cover;border-radius:8px;background:#eef1f5}
.apply-res{margin-top:12px;font-size:13px;font-weight:600;padding:10px 12px;border-radius:8px}
.apply-res.ok{background:#eafff4;color:#00794b}
.apply-res.no{background:#fff1f1;color:#c0353a}
.table-like{border:1px solid #e4e8ee;border-radius:12px;overflow:hidden;background:#fff}
.tl-head,.tl-row{display:grid;grid-template-columns:1fr 80px 90px 110px 110px;gap:10px;padding:11px 16px;font-size:13px;align-items:center}
.tl-head{background:#f6f8fa;font-weight:700;color:#5f676f;font-size:12px}
.tl-row{border-top:1px solid #f0f2f5;cursor:pointer}
.tl-row:hover{background:#f8fafc}
.tl-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
document.head.appendChild(extraCss);

window.addEventListener('hashchange', route);
boot();
