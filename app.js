/* arXiv Swipe — arXiv 신착 논문을 SNS 피드처럼 넘겨보는 정적 웹앱 */
(() => {
  'use strict';

  const DATA_URL = 'data/papers.json';
  const SAVED_KEY = 'arxiv-swipe:saved:v1';
  const HINT_KEY = 'arxiv-swipe:hint-seen';

  // 방문자 카운터 (정적 호스팅이라 외부 카운터 API를 쓴다)
  const COUNTER_API = 'https://abacus.jasoncameron.dev';
  const COUNTER_NS = 'arxiv-swipe-spacekorean';
  const VISIT_KEY = 'arxiv-swipe:counted';

  // 분야별 색상(HSL 색상각). 세부 카테고리가 없으면 아카이브 단위로 떨어진다.
  const HUE = {
    'cs.AI': 265, 'cs.CL': 152, 'cs.CV': 328, 'cs.LG': 214,
    'cs.RO': 24, 'cs.CR': 352, 'cs.HC': 190,
    'astro-ph': 232, 'quant-ph': 288, 'gr-qc': 205, 'cond-mat': 168,
    'hep-th': 305, 'hep-ph': 312, 'hep-ex': 318, 'hep-lat': 298,
    'nucl-th': 8, 'nucl-ex': 14,
    physics: 45, math: 250, 'math-ph': 244, 'q-bio': 118,
    'q-fin': 88, econ: 72, eess: 196, stat: 42, cs: 260,
  };

  function hueOf(cat) {
    if (!cat) return 250;
    if (HUE[cat] != null) return HUE[cat];
    return HUE[cat.split('.')[0]] ?? 250;
  }

  // 논문이 어떤 주제에 속하는지는 접두사로 판정한다.
  // (astro-ph.GA 는 astro-ph 주제에, stat.ML 은 stat 과 cs.LG 주제 양쪽에 걸린다)
  function inTopic(paper, topic) {
    return paper.cats.some((c) =>
      topic.match.some((m) => c === m || c.startsWith(`${m}.`)));
  }

  const topicById = (id) => DATA.categories.find((t) => t.id === id);

  const $ = (sel) => document.querySelector(sel);
  const feedEl = $('#feed');
  const tabsEl = $('#tabs');
  const tabsRowEl = $('#tabsrow');
  const savedTabEl = $('#savedTab');
  const barEl = $('#progressBar');
  const hintEl = $('#hint');
  const toastEl = $('#toast');
  const sheetEl = $('#sheet');

  let DATA = { papers: [], categories: [], updated: null };
  let saved = loadSaved();
  let activeCat = 'all';
  let view = [];          // 현재 탭에 보이는 논문 목록
  let index = 0;

  /* ─────────── 저장(북마크) ─────────── */
  function loadSaved() {
    try {
      const raw = JSON.parse(localStorage.getItem(SAVED_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch { return {}; }
  }
  function persistSaved() {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(saved)); } catch { /* 사파리 프라이빗 모드 */ }
  }

  /* ─────────── 유틸 ─────────── */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // arXiv 제목·초록에는 LaTeX가 섞여 있다. 렌더링은 안 하되 눈에 거슬리는 마크업은 벗겨낸다.
  function deTeX(s) {
    return String(s ?? '')
      .replace(/\\(?:emph|textit|textbf|textsc|texttt|text|mathrm|mathbf|mathcal|boldsymbol)\{([^{}]*)\}/g, '$1')
      .replace(/\$\$?([^$]*)\$\$?/g, '$1')
      .replace(/\\(?:%|&|_|#|\$)/g, (m) => m[1])
      .replace(/\\\\/g, ' ')
      .replace(/[{}]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function relTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const min = Math.round((Date.now() - t) / 60000);
    if (min < 60) return `${Math.max(min, 1)}분 전`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}시간 전`;
    const day = Math.round(hr / 24);
    if (day === 1) return '어제';
    if (day < 8) return `${day}일 전`;
    return new Date(t).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
  }

  function authorLine(authors) {
    if (!authors || !authors.length) return '';
    if (authors.length <= 3) return authors.join(' · ');
    return `${authors.slice(0, 3).join(' · ')} 외 ${authors.length - 3}명`;
  }

  // 카드 배경에 깔리는 글리프용 짧은 라벨
  function labelOf(primary) {
    const hit = DATA.categories.find((t) => inTopic({ cats: [primary] }, t));
    return hit ? hit.label : primary.split('.')[0];
  }

  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1700);
  }

  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* 미지원 */ } };

  /* ─────────── 렌더링 ─────────── */
  function renderTabs() {
    const tabs = [
      { id: 'all', label: '전체', n: DATA.papers.length },
      ...DATA.categories.map((t) => ({
        id: t.id,
        label: t.ko,
        n: DATA.papers.filter((p) => inTopic(p, t)).length,
      })),
    ];

    tabsEl.innerHTML = tabs.map((t) => `
      <button class="tab" role="tab" data-cat="${esc(t.id)}"
              aria-selected="${t.id === activeCat}">
        ${esc(t.label)}<span class="tab__n">${t.n}</span>
      </button>`).join('');

    // 저장 탭은 스크롤 밖으로 밀려나지 않도록 따로 고정해 둔다
    savedTabEl.setAttribute('aria-selected', String(activeCat === 'saved'));
    $('#savedCount').textContent = Object.keys(saved).length;
    markTabsEnd();
  }

  // 가로로 더 볼 게 남았을 때만 오른쪽 페이드를 유지한다
  function markTabsEnd() {
    const atEnd = tabsEl.scrollLeft + tabsEl.clientWidth >= tabsEl.scrollWidth - 2;
    tabsEl.classList.toggle('is-end', atEnd);
  }
  tabsEl.addEventListener('scroll', markTabsEnd, { passive: true });
  addEventListener('resize', markTabsEnd);

  function papersFor(cat) {
    if (cat === 'saved') {
      return Object.values(saved).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    }
    if (cat === 'all') return DATA.papers;
    const topic = topicById(cat);
    return topic ? DATA.papers.filter((p) => inTopic(p, topic)) : DATA.papers;
  }

  function cardHTML(p) {
    const h = hueOf(p.primary);
    const isSaved = !!saved[p.id];
    const extra = p.cats.filter((c) => c !== p.primary).slice(0, 2);

    return `
    <article class="card" style="--h:${h}" data-id="${esc(p.id)}" data-glyph="${esc(labelOf(p.primary))}">
      <div class="card__meta">
        <span class="chip">${esc(p.primary)}</span>
        ${extra.map((c) => `<span class="chip chip--ghost">${esc(c)}</span>`).join('')}
        <span class="sep">·</span>
        <time datetime="${esc(p.published)}">${esc(relTime(p.published))}</time>
        <span class="sep">·</span>
        <span>arXiv:${esc(p.id)}</span>
      </div>

      <div class="card__body">
        <h2 class="card__title">${esc(deTeX(p.title))}</h2>
        <p class="card__authors">${esc(authorLine(p.authors))}</p>
        <p class="card__abstract">${esc(deTeX(p.summary))}</p>
        <span class="card__more"><span>초록 전체 보기</span></span>
        ${p.comment ? `<p class="card__comment">💬 ${esc(deTeX(p.comment))}</p>` : ''}
      </div>

      <div class="card__rail">
        <button class="rail js-save" aria-pressed="${isSaved}" aria-label="저장">
          <i><svg viewBox="0 0 24 24"><path d="M6 4h12v16l-6-4.2L6 20z"/></svg></i>저장
        </button>
        <button class="rail js-share" aria-label="공유">
          <i><svg viewBox="0 0 24 24"><path d="M12 15V4M8.5 7.2 12 3.6l3.5 3.6"/><path d="M5 13v6.5h14V13"/></svg></i>공유
        </button>
        <button class="rail js-copy" aria-label="인용 복사">
          <i><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5.5 15H4.8A.8.8 0 0 1 4 14.2V4.8A.8.8 0 0 1 4.8 4h9.4a.8.8 0 0 1 .8.8v.7"/></svg></i>인용
        </button>
      </div>

      <div class="card__actions">
        <a class="btn btn--primary" href="${esc(p.abs)}" target="_blank" rel="noopener">원문 보기</a>
        <a class="btn" href="${esc(p.pdf)}" target="_blank" rel="noopener">PDF</a>
      </div>

      <div class="card__heart">♥</div>
    </article>`;
  }

  function render(resetScroll = true) {
    view = papersFor(activeCat);

    if (!view.length) {
      feedEl.innerHTML = `
        <div class="empty">
          <b>${activeCat === 'saved' ? '저장한 논문이 없어요' : '이 분야의 논문이 없어요'}</b>
          <span>${activeCat === 'saved'
            ? '카드를 더블탭하거나 저장 버튼을 누르면 여기에 모입니다.'
            : '다른 분야 탭을 눌러보세요.'}</span>
        </div>`;
      barEl.style.width = '0%';
      return;
    }

    feedEl.innerHTML = view.map(cardHTML).join('');
    if (resetScroll) { feedEl.scrollTop = 0; index = 0; }
    updateProgress();
  }

  function updateProgress() {
    const total = view.length || 1;
    barEl.style.width = `${((index + 1) / total) * 100}%`;
    const p = view[index];
    if (p) barEl.style.setProperty('--h', hueOf(p.primary));
  }

  /* ─────────── 현재 카드 추적 ─────────── */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || e.intersectionRatio <= 0.55) continue;

      const i = [...feedEl.children].indexOf(e.target);
      if (i >= 0 && i !== index) { index = i; updateProgress(); }

      // 잘리지 않은 짧은 초록에는 '전체 보기'를 띄우지 않는다.
      // content-visibility 때문에 화면에 들어온 뒤에야 크기를 잴 수 있다.
      const more = e.target.querySelector('.card__more');
      const abs = e.target.querySelector('.card__abstract');
      if (more && abs && !more.dataset.checked) {
        more.dataset.checked = '1';
        if (abs.scrollHeight <= abs.clientHeight + 2) more.hidden = true;
      }
    }
  }, { root: feedEl, threshold: [0.56] });

  const mo = new MutationObserver(() => {
    io.disconnect();
    for (const el of feedEl.querySelectorAll('.card')) io.observe(el);
  });
  mo.observe(feedEl, { childList: true });

  /* ─────────── 동작 ─────────── */
  function paperById(id) {
    return saved[id] || DATA.papers.find((p) => p.id === id);
  }

  function toggleSave(id, cardEl, { forceOn = false } = {}) {
    const p = paperById(id);
    if (!p) return;
    const willSave = forceOn || !saved[id];

    if (willSave) {
      saved[id] = { ...p, savedAt: Date.now() };
      buzz(12);
    } else {
      delete saved[id];
    }
    persistSaved();

    cardEl?.querySelector('.js-save')?.setAttribute('aria-pressed', String(willSave));

    // 저장 탭을 보고 있을 땐 목록에서 바로 빼준다
    if (activeCat === 'saved' && !willSave) {
      const at = feedEl.scrollTop;
      render(false);
      feedEl.scrollTop = Math.min(at, feedEl.scrollHeight);
    }
    renderTabs();
    toast(willSave ? '저장했어요 ★' : '저장을 해제했어요');
    return willSave;
  }

  function heartPop(cardEl) {
    const h = cardEl.querySelector('.card__heart');
    if (!h) return;
    h.classList.remove('pop');
    void h.offsetWidth;
    h.classList.add('pop');
  }

  async function share(p) {
    const title = deTeX(p.title);
    const data = { title, text: `${title} — arXiv:${p.id}`, url: p.abs };
    try {
      if (navigator.share) { await navigator.share(data); return; }
      await navigator.clipboard.writeText(`${title}\n${p.abs}`);
      toast('링크를 복사했어요');
    } catch (err) {
      if (err?.name !== 'AbortError') toast('공유할 수 없어요');
    }
  }

  async function copyCitation(p) {
    const year = (p.published || '').slice(0, 4);
    const key = `${(p.authors[0] || 'anon').split(' ').pop().toLowerCase()}${year}`;
    const bib = `@misc{${key},
  title  = {${deTeX(p.title)}},
  author = {${p.authors.join(' and ')}},
  year   = {${year}},
  eprint = {${p.id}},
  archivePrefix = {arXiv},
  primaryClass  = {${p.primary}},
  url    = {${p.abs}}
}`;
    try {
      await navigator.clipboard.writeText(bib);
      toast('BibTeX를 복사했어요');
    } catch {
      toast('복사할 수 없어요');
    }
  }

  /* ─────────── 이벤트 ─────────── */
  tabsRowEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    activeCat = tab.dataset.cat;
    renderTabs();
    render();
    if (tab !== savedTabEl) {
      tab.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  });

  let lastTap = 0;
  let lastTapId = '';

  feedEl.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    const p = paperById(id);
    if (!p) return;

    if (e.target.closest('.js-save')) { toggleSave(id, card); return; }
    if (e.target.closest('.js-share')) { share(p); return; }
    if (e.target.closest('.js-copy')) { copyCitation(p); return; }
    if (e.target.closest('a')) return;              // 원문 / PDF 링크

    // 더블탭 → 저장
    const now = Date.now();
    if (now - lastTap < 320 && lastTapId === id) {
      lastTap = 0;
      if (!saved[id]) { toggleSave(id, card, { forceOn: true }); heartPop(card); }
      else { toggleSave(id, card); }
      return;
    }
    lastTap = now;
    lastTapId = id;

    // 단일 탭 → 초록 펼치기 (더블탭과 겹치지 않게 지연)
    setTimeout(() => {
      if (lastTap !== now) return;
      card.classList.toggle('is-open');
      const more = card.querySelector('.card__more span');
      if (more) more.textContent = card.classList.contains('is-open') ? '' : '초록 전체 보기';
    }, 300);
  });

  // 힌트는 첫 스크롤에서 사라진다
  feedEl.addEventListener('scroll', () => {
    if (!hintEl.hidden) {
      hintEl.hidden = true;
      try { localStorage.setItem(HINT_KEY, '1'); } catch { /* noop */ }
    }
  }, { passive: true, once: true });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === 'j') {
      e.preventDefault(); go(1);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'k') {
      e.preventDefault(); go(-1);
    } else if (e.key === 's') {
      const card = feedEl.children[index];
      if (card?.dataset.id) toggleSave(card.dataset.id, card);
    } else if (e.key === 'Escape') {
      sheetEl.hidden = true;
    }
  });

  function go(delta) {
    const next = Math.min(Math.max(index + delta, 0), view.length - 1);
    feedEl.children[next]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#aboutBtn').addEventListener('click', () => {
    $('#sheetMeta').textContent = DATA.updated
      ? `논문 ${DATA.papers.length}편 · 마지막 수집 ${new Date(DATA.updated).toLocaleString('ko-KR')}`
      : '';
    sheetEl.hidden = false;
  });
  $('#sheetClose').addEventListener('click', () => { sheetEl.hidden = true; });
  sheetEl.addEventListener('click', (e) => {
    if (e.target === sheetEl) sheetEl.hidden = true;
  });

  /* ─────────── 새로고침 ─────────── */
  // arXiv API는 CORS 헤더를 주지 않아 브라우저에서 직접 못 부른다.
  // 수집은 GitHub Actions가 맡고, 여기서는 갱신된 JSON을 다시 받아온다.
  const refreshBtn = $('#refreshBtn');
  refreshBtn.addEventListener('click', async () => {
    if (refreshBtn.classList.contains('is-busy')) return;
    refreshBtn.classList.add('is-busy');
    try {
      const added = await reloadData();
      renderTabs();
      render();
      toast(added ? `새 논문 ${added}편을 불러왔어요` : '이미 최신이에요');
    } catch {
      toast('새로고침에 실패했어요');
    } finally {
      refreshBtn.classList.remove('is-busy');
    }
  });

  async function reloadData() {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'reload' });
    if (!res.ok) throw new Error(String(res.status));
    const next = await res.json();
    if (!Array.isArray(next.papers)) throw new Error('bad payload');

    const known = new Set(DATA.papers.map((p) => p.id));
    const added = next.papers.filter((p) => !known.has(p.id)).length;
    DATA = next;
    return added;
  }

  /* ─────────── 방문자 수 ─────────── */
  // 하루 단위 키는 한국시간 기준으로 끊는다.
  function dayKey() {
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    return `d-${kst.toISOString().slice(0, 10).replace(/-/g, '')}`;
  }

  async function countVisit() {
    let counted = false;
    try { counted = sessionStorage.getItem(VISIT_KEY) === '1'; } catch { /* noop */ }

    // 같은 세션에서 새로고침해도 중복 집계되지 않도록 두 번째부터는 읽기만 한다
    const verb = counted ? 'get' : 'hit';
    const read = (key) =>
      fetch(`${COUNTER_API}/${verb}/${COUNTER_NS}/${key}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (typeof j?.value === 'number' ? j.value : null))
        .catch(() => null);

    const [day, total] = await Promise.all([read(dayKey()), read('total')]);
    if (!counted) {
      try { sessionStorage.setItem(VISIT_KEY, '1'); } catch { /* noop */ }
    }
    if (day === null && total === null) return;   // 카운터가 죽어 있으면 조용히 감춘다

    const fmt = (n) => (n === null ? '–' : n.toLocaleString('ko-KR'));
    $('#visitDay').textContent = fmt(day);
    $('#visitTotal').textContent = fmt(total);
    $('#visits').hidden = false;
  }

  /* ─────────── 시작 ─────────── */
  async function boot() {
    // 브라우저의 스크롤 위치 복원이 피드 렌더링 뒤에 끼어들어
    // 엉뚱한 카드로 튀고 힌트까지 지워버리므로 끈다.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

    countVisit();   // 논문 로딩과 무관하게 진행

    feedEl.innerHTML = '<div class="empty"><div class="spinner"></div><span>오늘의 논문을 불러오는 중…</span></div>';
    try {
      const res = await fetch(DATA_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(String(res.status));
      DATA = await res.json();
    } catch {
      feedEl.innerHTML = `
        <div class="empty">
          <b>논문을 불러오지 못했어요</b>
          <span>data/papers.json 을 읽을 수 없습니다. 잠시 후 새로고침해 주세요.</span>
        </div>`;
      return;
    }

    renderTabs();
    render();

    let seen = null;
    try { seen = localStorage.getItem(HINT_KEY); } catch { /* noop */ }
    if (!seen && view.length) hintEl.hidden = false;
  }

  boot();
})();
