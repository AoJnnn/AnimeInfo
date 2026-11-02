/* 番剧索引页逻辑
   数据格式（site/data.json）：
   {
     meta: {...},
     studios: ["", "MAPPA", ...],
     people:  ["", "水树奈奈|水樹奈々", ...],
     items:   [[id, 中文名, 原名, 年份, 评分×10, 排名, 平台码, nsfw, 制作公司索引, [声优索引...]], ...]
   } */

(() => {
  'use strict';

  const PAGE_SIZE = 60;
  const PLATFORMS = ['TV', 'OVA', '剧场版', 'WEB', '其他'];
  const LEN_PRESETS = { 1: [1, 4], 2: [5, 8], 3: [9, 12], 4: [13, null] };
  const YEAR_MIN = 1900;
  const YEAR_MAX = 2030;

  const state = {
    q: '',
    yearFrom: null,
    yearTo: null,
    scoreMin: 0,
    lenMin: null,
    lenMax: null,
    first: '',
    sort: 'rank',
    nsfw: false,
    shown: PAGE_SIZE,
  };

  let STUDIOS = [''];
  let PEOPLE = [''];
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
    yearFrom: document.getElementById('year-from'),
    yearTo: document.getElementById('year-to'),
    scoreMin: document.getElementById('score-min'),
    lenMin: document.getElementById('len-min'),
    lenMax: document.getElementById('len-max'),
    scoreChips: document.getElementById('score-chips'),
    lenChips: document.getElementById('len-chips'),
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

  /* ---------- 数据 ---------- */

  async function boot() {
    try {
      const response = await fetch('./data.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      hydrate(payload);
      bindEvents();
      update(false);
    } catch (error) {
      el.count.textContent = '数据读取失败，请刷新页面重试。';
      el.list.innerHTML = '<p class="anime-empty">没能加载 data.json。</p>';
      console.error(error);
    }
  }

  function hydrate(payload) {
    STUDIOS = payload.studios && payload.studios.length ? payload.studios : [''];
    PEOPLE = payload.people && payload.people.length ? payload.people : [''];

    rows = (payload.items || []).map((item) => {
      const [id, name, orig, year, scoreX10, rank, plat, nsfw, studioId, cvIds] = item;
      const studio = STUDIOS[studioId] || '';
      const cvs = (cvIds || []).map((index) => PEOPLE[index]).filter(Boolean);
      const shortCvs = cvs.map((entry) => entry.split('|')[0]);
      return {
        id,
        name,
        orig,
        year,
        score: scoreX10 / 10,
        rank,
        plat,
        nsfw,
        studio,
        cvNames: shortCvs,
        len: Array.from(name).length,
        ch: firstChar(name),
        hay: [name, orig, studio, ...cvs.map((entry) => entry.replace('|', ' '))].join(' ').toLowerCase(),
      };
    });

    const years = rows.map((row) => row.year).filter((year) => year > 0);
    if (years.length) {
      // 输入框的合法范围提示用，不参与筛选
      el.yearFrom.max = String(Math.max(...years));
      el.yearTo.max = String(Math.max(...years));
    }
  }

  /* ---------- 筛选 ---------- */

  const yearActive = () => state.yearFrom !== null || state.yearTo !== null;

  function applyFilters() {
    const query = state.q.trim().toLowerCase();
    const hasYear = yearActive();
    const hasLen = state.lenMin !== null || state.lenMax !== null;

    filtered = rows.filter((row) => {
      if (!state.nsfw && row.nsfw) return false;

      if (hasYear) {
        if (!row.year) return false;
        if (state.yearFrom !== null && row.year < state.yearFrom) return false;
        if (state.yearTo !== null && row.year > state.yearTo) return false;
      }

      if (state.scoreMin && row.score < state.scoreMin) return false;

      if (hasLen) {
        if (state.lenMin !== null && row.len < state.lenMin) return false;
        if (state.lenMax !== null && row.len > state.lenMax) return false;
      }

      if (state.first && row.ch !== state.first) return false;
      if (query && !row.hay.includes(query)) return false;
      return true;
    });

    filtered.sort(comparators[state.sort]);
  }

  const unranked = (row) => (row.rank ? 0 : 1);

  const comparators = {
    rank: (a, b) => unranked(a) - unranked(b) || a.rank - b.rank || b.score - a.score,
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
    if (yearActive()) count += 1;
    if (state.scoreMin) count += 1;
    if (state.lenMin !== null || state.lenMax !== null) count += 1;
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

  /* ---------- 控件同步 ---------- */

  function syncInputs() {
    el.yearFrom.value = state.yearFrom === null ? '' : String(state.yearFrom);
    el.yearTo.value = state.yearTo === null ? '' : String(state.yearTo);
    el.scoreMin.value = state.scoreMin ? String(state.scoreMin) : '';
    el.lenMin.value = state.lenMin === null ? '' : String(state.lenMin);
    el.lenMax.value = state.lenMax === null ? '' : String(state.lenMax);
    el.firstInput.value = state.first;
  }

  function syncChips() {
    el.scoreChips.querySelectorAll('[data-score]').forEach((button) => {
      const on = Number(button.dataset.score) === state.scoreMin;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    });

    el.lenChips.querySelectorAll('[data-len]').forEach((button) => {
      const preset = LEN_PRESETS[Number(button.dataset.len)];
      const on = preset
        ? state.lenMin === preset[0] && (state.lenMax === preset[1] || (preset[1] === null && state.lenMax === null))
        : state.lenMin === null && state.lenMax === null;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    });
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
    state.yearFrom = null;
    state.yearTo = null;
    state.scoreMin = 0;
    state.lenMin = null;
    state.lenMax = null;
    state.first = '';
    state.nsfw = false;
    el.nsfw.classList.remove('is-on');
    el.nsfw.setAttribute('aria-pressed', 'false');
    syncInputs();
    syncChips();
    update(true);
  }

  /* ---------- 交互 ---------- */

  function debounce(fn, wait = 220) {
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
      let from = numOrNull(el.yearFrom.value);
      let to = numOrNull(el.yearTo.value);
      if (from !== null) from = Math.min(Math.max(from, YEAR_MIN), YEAR_MAX);
      if (to !== null) to = Math.min(Math.max(to, YEAR_MIN), YEAR_MAX);
      if (from !== null && to !== null && from > to) to = from;
      state.yearFrom = from;
      state.yearTo = to;
      el.yearFrom.value = from === null ? '' : String(from);
      el.yearTo.value = to === null ? '' : String(to);
      update(true);
    });
    el.yearFrom.addEventListener('input', applyYear);
    el.yearTo.addEventListener('input', applyYear);

    const applyScore = debounce(() => {
      let value = numOrNull(el.scoreMin.value) || 0;
      value = Math.min(Math.max(value, 0), 10);
      state.scoreMin = value;
      el.scoreMin.value = value ? String(value) : '';
      syncChips();
      update(true);
    });
    el.scoreMin.addEventListener('input', applyScore);

    const applyLen = debounce(() => {
      let min = numOrNull(el.lenMin.value);
      let max = numOrNull(el.lenMax.value);
      if (min !== null) min = Math.max(1, Math.round(min));
      if (max !== null) max = Math.max(1, Math.round(max));
      if (min !== null && max !== null && min > max) max = min;
      state.lenMin = min;
      state.lenMax = max;
      el.lenMin.value = min === null ? '' : String(min);
      el.lenMax.value = max === null ? '' : String(max);
      syncChips();
      update(true);
    });
    el.lenMin.addEventListener('input', applyLen);
    el.lenMax.addEventListener('input', applyLen);

    el.firstInput.addEventListener('input', () => {
      const value = firstChar(el.firstInput.value.trim());
      el.firstInput.value = value;
      state.first = value;
      update(true);
    });

    el.scoreChips.addEventListener('click', (event) => {
      const button = event.target.closest('[data-score]');
      if (!button) return;
      state.scoreMin = Number(button.dataset.score);
      syncInputs();
      syncChips();
      update(true);
    });

    el.lenChips.addEventListener('click', (event) => {
      const button = event.target.closest('[data-len]');
      if (!button) return;
      const preset = LEN_PRESETS[Number(button.dataset.len)];
      state.lenMin = preset ? preset[0] : null;
      state.lenMax = preset ? preset[1] : null;
      syncInputs();
      syncChips();
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
