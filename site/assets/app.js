/* 番剧索引页逻辑
   数据分两份：
   data.json  { v, meta, items: [[id, 中文名, 年份, 评分×10, 排名, 平台码, nsfw, 名字长度, 首字]] }
   cast.json  { v, studios: [...], people: [...], items: [[id, 公司索引, [声优索引...]]] }  ← 首屏之后后台加载

   线路：本地 Pages 与 jsDelivr 同时发车，谁先到用谁（国内 Pages 常卡住）。 */

(() => {
  'use strict';

  const DATA_VERSION = 3;
  const PAGE_SIZE = 100;
  const PLATFORMS = ['TV', 'OVA', '剧场版', 'WEB', '其他'];
  const YEAR_MIN = 1900;
  const YEAR_MAX = 2030;
  const CDN_BASE = 'https://cdn.jsdelivr.net/gh/AoJnnn/AnimeInfo@1eaf3fb/site';

  const state = {
    q: '',
    year: null,
    score: null,
    len: null,
    first: '',
    sort: 'rank',
    nsfw: false,
  };

  let rows = [];
  let filtered = [];
  let rendered = 0;
  let observer = null;
  let castReady = false;
  let bound = false;
  let ready = false;
  let totalCount = 0;

  const el = {
    panel: document.querySelector('.anime-panel'),
    list: document.getElementById('anime-list'),
    count: document.getElementById('anime-count'),
    progress: document.getElementById('anime-progress'),
    sentinel: document.getElementById('anime-sentinel'),
    q: document.getElementById('anime-q'),
    nsfw: document.getElementById('anime-nsfw'),
    toggle: document.getElementById('anime-filter-toggle'),
    filters: document.getElementById('anime-filters'),
    filterCount: document.getElementById('anime-filter-count'),
    year: document.getElementById('year-input'),
    score: document.getElementById('score-input'),
    len: document.getElementById('len-input'),
    firstInput: document.getElementById('first-input'),
    sortSelect: document.getElementById('sort-select'),
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

  // 先走本地 Pages；2.2 秒还没回，再并行发 CDN，谁先完整返回用谁（慢的那条会被中止）
  async function loadHedged(name, options = {}) {
    const { firstTimeout = 30000, hedgeDelay = 2200, hedgeTimeout = 12000 } = options;
    const urls = [`./${name}?v=${DATA_VERSION}`, `${CDN_BASE}/${name}`];
    const controllers = [new AbortController(), new AbortController()];
    const timers = [];

    const begin = (index, delay) =>
      new Promise((resolve, reject) => {
        const fire = () => {
          fetch(urls[index], { signal: controllers[index].signal })
            .then((response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return response.json();
            })
            .then((payload) => {
              if (!payload || payload.v !== DATA_VERSION) throw new Error('数据版本不匹配');
              resolve(payload);
            })
            .catch(reject);
        };
        if (delay) timers.push(setTimeout(fire, delay));
        else fire();
      });

    timers.push(setTimeout(() => controllers[0].abort(), firstTimeout));
    timers.push(setTimeout(() => controllers[1].abort(), hedgeDelay + hedgeTimeout));

    try {
      return await Promise.any([begin(0, 0), begin(1, hedgeDelay)]);
    } finally {
      timers.forEach(clearTimeout);
      controllers.forEach((controller) => controller.abort());
    }
  }

  async function boot() {
    const hints = [
      setTimeout(() => setStatus('网络有点慢，正在加载…'), 3500),
      setTimeout(() => setStatus('还在加载（约 0.6 MB），请再等一下…'), 8000),
    ];

    try {
      setStatus('正在读取数据…');

      // 第一步：先拿 600 条「头部数据」（约 12 KB gzip），秒开首屏
      const head = await loadHedged('head.json', { firstTimeout: 8000, hedgeDelay: 1200, hedgeTimeout: 8000 }).catch(
        () => null
      );
      if (head && head.items && head.items.length) {
        hydrate(head);
        totalCount = head.count || head.items.length;
        ready = head.items.length >= totalCount;
        bindOnce();
        observe();
        setFiltersEnabled(ready);
        update(false);
      }

      // 第二步：全量数据（约 0.64 MB gzip），到货后替换并启用筛选
      const core = await loadHedged('data.json');
      hints.forEach(clearTimeout);

      hydrate(core);
      totalCount = (core.items || []).length;
      ready = true;
      bindOnce();
      observe();
      setFiltersEnabled(true);
      update(false);

      // 声优 / 制作公司再晚一步
      loadHedged('cast.json', { hedgeDelay: 1200 })
        .then(applyCast)
        .catch(() => {});
    } catch (error) {
      hints.forEach(clearTimeout);
      showError(error);
    }
  }

  function bindOnce() {
    if (bound) return;
    bound = true;
    bindEvents();
  }

  function setFiltersEnabled(on) {
    [el.year, el.score, el.len, el.firstInput, el.nsfw].forEach((node) => {
      node.disabled = !on;
    });
    el.panel.classList.toggle('is-busy', !on);
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
      const [id, name, year, scoreX10, rank, plat, nsfw, len, ch] = item;
      return {
        id,
        name,
        year,
        score: scoreX10 / 10,
        rank,
        plat,
        nsfw,
        len,
        ch,
        studio: '',
        cvNames: [],
        hay: name.toLowerCase(),
      };
    });
  }

  function applyCast(payload) {
    castReady = true;
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
      row.hay = `${row.name} ${row.studio} ${cvFull.map((name) => name.replace('|', ' ')).join(' ')}`.toLowerCase();
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
        ${matchHint(row)}
      </div>
      <div class="anime-meta"><span>${row.year || '年份未知'}</span><span>${PLATFORMS[row.plat] || '其他'}</span><span>${
        row.len
      } 字</span></div>
      <span class="anime-score${scoreClass}">${row.score ? row.score.toFixed(1) : '暂无'}</span>
    </article>`;
  }

  function renderNext() {
    if (rendered >= filtered.length) {
      updateProgress();
      return;
    }
    const end = Math.min(rendered + PAGE_SIZE, filtered.length);
    el.list.insertAdjacentHTML('beforeend', filtered.slice(rendered, end).map(rowHtml).join(''));
    rendered = end;
    updateProgress();
  }

  function updateProgress() {
    const total = filtered.length;
    if (!total) {
      el.progress.hidden = true;
      return;
    }
    el.progress.hidden = false;

    if (!ready) {
      el.progress.textContent = '正在载入全部数据…（先显示前 ' + fmt(total) + ' 部）';
      return;
    }

    const waiting = !castReady && state.q.trim() ? ' · 声优/公司数据还在加载，稍后自动补上' : '';
    el.progress.textContent =
      (rendered >= total ? `已显示全部 ${fmt(total)} 部` : `已显示 ${fmt(rendered)} / ${fmt(total)} 部，继续下滑自动加载`) +
      waiting;
  }

  // 首屏/换条件后，先把视口填满，避免底部大片空白
  function fillViewport() {
    let guard = 0;
    while (rendered < filtered.length && guard < 20) {
      const bottom = el.progress.getBoundingClientRect().top;
      if (bottom > window.innerHeight + 300) break;
      renderNext();
      guard += 1;
    }
  }

  function observe() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (!('IntersectionObserver' in window)) {
      window.addEventListener('scroll', () => {
        if (window.innerHeight + window.scrollY > document.body.offsetHeight - 600) renderNext();
      });
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          renderNext();
          fillViewport();
        }
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(el.sentinel);
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
    if (!ready) {
      el.count.innerHTML = `正在载入全部数据…（已显示前 <b>${fmt(rows.length)}</b> 部 / 共 ${fmt(
        totalCount
      )} 部）`;
      el.filterCount.hidden = true;
      return;
    }
    const active = activeFilterCount();
    el.count.innerHTML =
      `共 <b>${fmt(rows.length)}</b> 部 · 当前 <b>${fmt(filtered.length)}</b> 部` +
      (active || state.q.trim() ? '<button class="anime-reset" id="anime-reset" type="button">清空筛选</button>' : '');
    el.filterCount.hidden = active === 0;
    el.filterCount.textContent = active ? String(active) : '';
  }

  function update(scrollBack) {
    applyFilters();
    rendered = 0;
    el.list.innerHTML = '';

    if (!filtered.length) {
      el.list.innerHTML = '<p class="anime-empty">没有符合条件的番剧，试试放宽筛选。</p>';
      el.progress.hidden = true;
    } else {
      renderNext();
      fillViewport();
    }

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
