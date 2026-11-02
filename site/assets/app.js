/* 番剧索引页逻辑
   数据分两份：
   data.json  { v, meta, items: [[id, 中文名, 原名, 年份, 评分×10, 排名, 平台码, nsfw, 名字长度, 首字]] }
   cast.json  { v, studios: [...], people: [...], items: [[id, 公司索引, [声优索引...]]] }  ← 首屏之后后台加载

   线路：本地 Pages 与 jsDelivr 同时发车，谁先到用谁（国内 Pages 常卡住）。 */

(() => {
  'use strict';

  const DATA_VERSION = 2;
  const PAGE_SIZE = 60;
  const PLATFORMS = ['TV', 'OVA', '剧场版', 'WEB', '其他'];
  const YEAR_MIN = 1900;
  const YEAR_MAX = 2030;
  const CDN_BASE = 'https://cdn.jsdelivr.net/gh/AoJnnn/AnimeInfo@c6b046e/site';

  const state = {
    q: '',
    year: null,
    score: null,
    len: null,
    first: '',
    sort: 'rank',
    nsfw: false,
    shown: PAGE_SIZE,
  };

  let rows = [];
  let filtered = [];

  const el = {
    panel: document.querySelector('.anime-panel'),
    list: document.getElementById('anime-list'),
    count: document.getElementById('anime-count'),
    more: document.getElementById('anime-more'),
    sortSelect: document.getElementById('sort-select'),
    q: document.getElementById('anime-q'),
    nsfw: document.getElementById('anime-nsfw'),
    toggle: document.getElementById('anime-filter-toggle'),
    filters: document.getElementById('anime-filters'),
    filterCount: document.getElementById('anime-filter-count'),
    year: document.getElementById('year-input'),
    score: document.getElementById('score-input'),
    len: document.getElementById('len-input'),
    firstInput: document.getElementById('first-input'),
  };

  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const fmt = (value) => value.toLocaleString('zh-CN');

  const firstChar = (name) => {
    const chars = Array.from(name);
    const ch = chars.length ? chars[0] : '';
    return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
  };

  const numOrNull = (value) => {
    const n = Number(String(value).trim());
    return String(value).trim() === '' || !Number.isFinite(n) ? null : n;
  };

  /* ---------- 加载 ---------- */

  function setStatus(text) {
    el.count.textContent = text;
  }

  // 两条线路并发，谁先响应头用谁；另一条立刻中止，不白下第二份数据
  async function loadRaced(name, timeouts = [30000, 12000]) {
    const urls = [`./${name}?v=${DATA_VERSION}`, `${CDN_BASE}/${name}`];
    const controllers = urls.map(() => new AbortController());
    const timers = urls.map((_, i) => setTimeout(() => controllers[i].abort(), timeouts[i]));

    const attempts = urls.map((url, i) =>
      fetch(url, { signal: controllers[i].signal }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { response, index: i };
      })
    );

    try {
      const winner = await Promise.any(attempts);
      controllers.forEach((controller, i) => {
        if (i !== winner.index) controller.abort();
      });

      const payload = await winner.response.json();
      if (!payload || payload.v !== DATA_VERSION) {
        // 版本对不上（例如浏览器/ CDN 缓存了旧版）：换带版本号的地址重取本地那份
        const fallback = await fetch(`./${name}?v=${DATA_VERSION}&t=${Date.now()}`).then((response) => response.json());
        if (!fallback || fallback.v !== DATA_VERSION) throw new Error('数据版本不匹配');
        return fallback;
      }
      return payload;
    } finally {
      timers.forEach(clearTimeout);
      controllers.forEach((controller) => controller.abort());
    }
  }

  async function boot() {
    const hints = [
      setTimeout(() => setStatus('网络有点慢，正在加载…'), 3500),
      setTimeout(() => setStatus('还在加载（约 1 MB），请再等一下…'), 8000),
    ];

    try {
      setStatus('正在读取数据…');
      const core = await loadRaced('data.json');
      hints.forEach(clearTimeout);

      hydrate(core);
      bindEvents();
      update(false);

      // 声优 / 制作公司晚一步到，不挡首屏
      loadRaced('cast.json', [10000, 14000])
        .then(applyCast)
        .catch(() => {});
    } catch (error) {
      hints.forEach(clearTimeout);
      showError(error);
    }
  }

  function showError(error) {
    const detail = error && error.message ? error.message : '网络异常';
    el.count.innerHTML = '数据加载失败 <button class="anime-reset" id="anime-retry" type="button">点此重试</button>';
    el.list.innerHTML = `<p class="anime-empty">没能下载数据（${esc(detail)}）。换一下网络后再试试，或刷新页面。</p>`;
    const retry = document.getElementById('anime-retry');
    if (retry) retry.addEventListener('click', () => location.reload());
  }

  function hydrate(payload) {
    rows = (payload.items || []).map((item) => {
      const [id, name, orig, year, scoreX10, rank, plat, nsfw, len, ch] = item;
      return {
        id,
        name,
        orig,
        year,
        score: scoreX10 / 10,
        rank,
        plat,
        nsfw,
        len,
        ch,
        studio: '',
        cvNames: [],
        hay: `${name} ${orig}`.toLowerCase(),
      };
    });
  }

  function applyCast(payload) {
    const studios = payload.studios || [''];
    const people = payload.people || [''];
    const index = new Map();
    for (const [sid, studioId, cvIds] of payload.items || []) index.set(sid, [studioId, cvIds]);

    for (const row of rows) {
      const entry = index.get(row.id);
      if (!entry) continue;
      const [studioId, cvIds] = entry;
      row.studio = studios[studioId] || '';
      const cvFull = (cvIds || []).map((i) => people[i] || '');
      row.cvNames = cvFull.map((name) => name.split('|')[0]).filter(Boolean);
      row.hay = `${row.name} ${row.orig} ${row.studio} ${cvFull
        .map((name) => name.replace('|', ' '))
        .join(' ')}`.toLowerCase();
    }

    if (state.q.trim()) update(false);
  }

  /* ---------- 筛选（定值） ---------- */

  function applyFilters() {
    const query = state.q.trim().toLowerCase();

    filtered = rows.filter((row) => {
      if (!state.nsfw && row.nsfw) return false;
      if (state.year !== null && row.year !== state.year) return false;
      if (state.score !== null && Math.abs(row.score - state.score) > 0.001) return false;
      if (state.len !== null && row.len !== state.len) return false;
      if (state.first && row.ch !== state.first) return false;
      if (query && !row.hay.includes(query)) return false;
      return true;
    });

    // 数据文件已按排名排好，默认排序无需再排
    if (state.sort !== 'rank') filtered.sort(comparators[state.sort]);
  }

  const unranked = (row) => (row.rank ? 0 : 1);

  const comparators = {
    score: (a, b) => b.score - a.score || unranked(a) - unranked(b) || a.rank - b.rank,
    year: (a, b) => b.year - a.year || unranked(a) - unranked(b) || a.rank - b.rank,
    len: (a, b) => b.len - a.len || unranked(a) - unranked(b) || a.rank - b.rank,
  };

  /* ---------- 渲染 ---------- */

  function matchHint(row) {
    const query = state.q.trim().toLowerCase();
    if (!query) return '';
    const parts = [];
    if (row.studio && row.studio.toLowerCase().includes(query)) {
      parts.push(`制作 ${esc(row.studio)}`);
    }
    const hits = row.cvNames.filter((name) => name.toLowerCase().includes(query)).slice(0, 3);
    if (hits.length) parts.push(`声优 ${hits.map(esc).join('、')}`);
    return parts.length ? `<p class="anime-hit">${parts.join('<i>·</i>')}</p>` : '';
  }

  function rowHtml(row) {
    const rankClass = row.rank && row.rank <= 3 ? ' is-top' : '';
    const scoreClass = row.score ? '' : ' is-empty';
    return `<article class="anime-row">
      <span class="anime-rank${rankClass}">${row.rank ? row.rank : '—'}</span>
      <div class="anime-main">
        <h3 class="anime-name"><a href="https://bgm.tv/subject/${row.id}" target="_blank" rel="noreferrer">${esc(
          row.name
        )}</a></h3>
        ${row.orig ? `<p class="anime-sub">${esc(row.orig)}</p>` : ''}
        ${matchHint(row)}
      </div>
      <div class="anime-meta"><span>${row.year || '年份未知'}</span><span>${PLATFORMS[row.plat] || '其他'}</span><span>${
        row.len
      } 字</span></div>
      <span class="anime-score${scoreClass}">${row.score ? row.score.toFixed(1) : '暂无'}</span>
    </article>`;
  }

  function renderList() {
    const visible = filtered.slice(0, state.shown);
    el.list.innerHTML = visible.length
      ? visible.map(rowHtml).join('')
      : '<p class="anime-empty">没有符合条件的番剧，试试放宽筛选。</p>';
    el.more.hidden = state.shown >= filtered.length;
  }

  function activeFilterCount() {
    let count = 0;
    if (state.year !== null) count += 1;
    if (state.score !== null) count += 1;
    if (state.len !== null) count += 1;
    if (state.first) count += 1;
    if (state.nsfw) count += 1;
    return count;
  }

  function renderCount() {
    const active = activeFilterCount();
    el.count.innerHTML =
      `共 <b>${fmt(rows.length)}</b> 部 · 当前 <b>${fmt(filtered.length)}</b> 部` +
      (active || state.q.trim() ? '<button class="anime-reset" id="anime-reset" type="button">清空筛选</button>' : '');
    el.filterCount.hidden = active === 0;
    el.filterCount.textContent = active ? String(active) : '';
  }

  function update(scrollBack) {
    applyFilters();
    state.shown = PAGE_SIZE;
    renderList();
    renderCount();

    if (scrollBack) {
      const top = el.list.getBoundingClientRect().top + window.scrollY - 96;
      if (window.scrollY > top) window.scrollTo({ top: Math.max(top, 0), behavior: 'smooth' });
    }
  }

  /* ---------- 控件 ---------- */

  function syncInputs() {
    el.year.value = state.year === null ? '' : String(state.year);
    el.score.value = state.score === null ? '' : String(state.score);
    el.len.value = state.len === null ? '' : String(state.len);
    el.firstInput.value = state.first;
  }

  function setSort(sort) {
    state.sort = sort;
    document.querySelectorAll('.anime-sort [data-sort]').forEach((item) => {
      const on = item.dataset.sort === sort;
      item.classList.toggle('is-on', on);
      item.setAttribute('aria-pressed', String(on));
    });
    if (el.sortSelect.value !== sort) el.sortSelect.value = sort;
  }

  function resetFilters() {
    state.q = '';
    el.q.value = '';
    state.year = null;
    state.score = null;
    state.len = null;
    state.first = '';
    state.nsfw = false;
    el.nsfw.classList.remove('is-on');
    el.nsfw.setAttribute('aria-pressed', 'false');
    syncInputs();
    update(true);
  }

  function debounce(fn, wait = 200) {
    let timer = 0;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  function bindEvents() {
    el.q.addEventListener(
      'input',
      debounce(() => {
        state.q = el.q.value;
        update(false);
      }, 160)
    );

    const applyYear = debounce(() => {
      let value = numOrNull(el.year.value);
      if (value !== null) value = Math.min(Math.max(Math.round(value), YEAR_MIN), YEAR_MAX);
      state.year = value;
      el.year.value = value === null ? '' : String(value);
      update(true);
    });
    el.year.addEventListener('input', applyYear);

    const applyScore = debounce(() => {
      let value = numOrNull(el.score.value);
      if (value !== null) value = Math.min(Math.max(value, 0), 10);
      state.score = value;
      el.score.value = value === null ? '' : String(value);
      update(true);
    });
    el.score.addEventListener('input', applyScore);

    const applyLen = debounce(() => {
      let value = numOrNull(el.len.value);
      if (value !== null) value = Math.max(1, Math.round(value));
      state.len = value;
      el.len.value = value === null ? '' : String(value);
      update(true);
    });
    el.len.addEventListener('input', applyLen);

    el.firstInput.addEventListener('input', () => {
      const value = firstChar(el.firstInput.value.trim());
      el.firstInput.value = value;
      state.first = value;
      update(true);
    });

    document.querySelector('.anime-sort').addEventListener('click', (event) => {
      const button = event.target.closest('[data-sort]');
      if (!button) return;
      setSort(button.dataset.sort);
      update(false);
    });

    el.sortSelect.addEventListener('change', () => {
      setSort(el.sortSelect.value);
      update(false);
    });

    el.nsfw.addEventListener('click', () => {
      state.nsfw = !state.nsfw;
      el.nsfw.classList.toggle('is-on', state.nsfw);
      el.nsfw.setAttribute('aria-pressed', String(state.nsfw));
      update(true);
    });

    el.more.addEventListener('click', () => {
      state.shown += PAGE_SIZE;
      renderList();
    });

    el.count.addEventListener('click', (event) => {
      if (event.target.closest('#anime-reset')) resetFilters();
    });

    el.toggle.addEventListener('click', () => {
      const open = el.panel.classList.toggle('is-open');
      el.toggle.setAttribute('aria-expanded', String(open));
    });
  }

  boot();
})();
