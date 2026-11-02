/* 番剧索引页逻辑
   数据格式（site/data.json）：
   { meta: {...}, items: [[id, 中文名, 原名, 年份, 评分×10, 排名, 平台码, nsfw], ...] } */

(() => {
  'use strict';

  const PAGE_SIZE = 60;
  const PLATFORMS = ['TV', 'OVA', '剧场版', 'WEB', '其他'];
  const LEN_RANGES = { 1: [1, 4], 2: [5, 8], 3: [9, 12], 4: [13, Infinity] };
  const TOP_CHARS = 18;

  const state = {
    q: '',
    yearFrom: 0,
    yearTo: 0,
    minScore: 0,
    len: 0,
    first: '',
    sort: 'rank',
    nsfw: false,
    shown: PAGE_SIZE,
  };

  let rows = [];
  let filtered = [];
  let minYear = 0;
  let maxYear = 0;

  const el = {
    list: document.getElementById('anime-list'),
    count: document.getElementById('anime-count'),
    more: document.getElementById('anime-more'),
    q: document.getElementById('anime-q'),
    nsfw: document.getElementById('anime-nsfw'),
    yearFrom: document.getElementById('year-from'),
    yearTo: document.getElementById('year-to'),
    yearHint: document.getElementById('year-hint'),
    scoreChips: document.getElementById('score-chips'),
    lenChips: document.getElementById('len-chips'),
    firstChips: document.getElementById('first-chips'),
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

  /* ---------- 数据 ---------- */

  async function boot() {
    try {
      const response = await fetch('./data.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      hydrate(payload.items || []);
      buildYearSelects();
      buildFirstChips();
      bindEvents();
      update(false);
    } catch (error) {
      el.count.textContent = '数据读取失败，请刷新页面重试。';
      el.list.innerHTML = '<p class="anime-empty">没能加载 data.json。</p>';
      console.error(error);
    }
  }

  function hydrate(items) {
    rows = items.map(([id, name, orig, year, scoreX10, rank, plat, nsfw]) => ({
      id,
      name,
      orig,
      year,
      score: scoreX10 / 10,
      rank,
      plat,
      nsfw,
      len: Array.from(name).length,
      ch: firstChar(name),
      hay: `${name} ${orig}`.toLowerCase(),
    }));

    const years = rows.map((row) => row.year).filter((year) => year > 0);
    minYear = years.length ? Math.min(...years) : 1900;
    maxYear = years.length ? Math.max(...years) : 2030;
    state.yearFrom = minYear;
    state.yearTo = maxYear;
  }

  function buildYearSelects() {
    const years = [...new Set(rows.map((row) => row.year).filter((year) => year > 0))].sort((a, b) => a - b);
    const options = (selected) =>
      ['<option value="">不限</option>']
        .concat(years.map((year) => `<option value="${year}"${String(selected) === String(year) ? ' selected' : ''}>${year}</option>`))
        .join('');
    el.yearFrom.innerHTML = options('');
    el.yearTo.innerHTML = options('');
  }

  function buildFirstChips() {
    const counts = new Map();
    for (const row of rows) {
      if (!row.ch) continue;
      counts.set(row.ch, (counts.get(row.ch) || 0) + 1);
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_CHARS)
      .map(([ch]) => ch);

    el.firstChips.insertAdjacentHTML(
      'beforeend',
      top
        .map(
          (ch) =>
            `<button class="chip" type="button" data-first="${esc(ch)}" aria-pressed="false" title="${
              counts.get(ch)
            } 部">${esc(ch)}</button>`
        )
        .join('')
    );
  }

  /* ---------- 筛选 ---------- */

  function applyFilters() {
    const query = state.q.trim().toLowerCase();
    const limited = yearLimited();
    const bucket = state.len ? LEN_RANGES[state.len] : null;

    filtered = rows.filter((row) => {
      if (!state.nsfw && row.nsfw) return false;
      if (row.year === 0) {
        if (limited) return false;
      } else if (row.year < state.yearFrom || row.year > state.yearTo) {
        return false;
      }
      if (state.minScore && row.score < state.minScore) return false;
      if (bucket && (row.len < bucket[0] || row.len > bucket[1])) return false;
      if (state.first && row.ch !== state.first) return false;
      if (query && !row.hay.includes(query)) return false;
      return true;
    });

    filtered.sort(comparators[state.sort]);
  }

  const unranked = (row) => (row.rank ? 0 : 1);

  const yearLimited = () => state.yearFrom > minYear || state.yearTo < maxYear;

  const comparators = {
    rank: (a, b) => unranked(a) - unranked(b) || a.rank - b.rank || b.score - a.score,
    score: (a, b) => b.score - a.score || unranked(a) - unranked(b) || a.rank - b.rank,
    year: (a, b) => b.year - a.year || unranked(a) - unranked(b) || a.rank - b.rank,
    len: (a, b) => b.len - a.len || unranked(a) - unranked(b) || a.rank - b.rank,
  };

  /* ---------- 渲染 ---------- */

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

  function renderCount() {
    const active = state.q.trim() || state.minScore || state.len || state.first || state.nsfw || yearLimited();
    el.count.innerHTML =
      `共 <b>${fmt(rows.length)}</b> 部 · 当前 <b>${fmt(filtered.length)}</b> 部` +
      (active ? '<button class="anime-reset" id="anime-reset" type="button">清空筛选</button>' : '');
    el.yearHint.textContent = yearLimited() ? `${state.yearFrom}–${state.yearTo}` : '不选则不限';
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

  /* ---------- 交互 ---------- */

  function setPressed(group, activeButton) {
    group.querySelectorAll('[aria-pressed]').forEach((button) => {
      const on = button === activeButton;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    });
  }

  function resetFilters() {
    state.q = '';
    el.q.value = '';
    state.minScore = 0;
    setPressed(el.scoreChips, el.scoreChips.querySelector('[data-score="0"]'));
    state.len = 0;
    setPressed(el.lenChips, el.lenChips.querySelector('[data-len="0"]'));
    state.first = '';
    el.firstInput.value = '';
    syncFirstChips();
    state.nsfw = false;
    el.nsfw.classList.remove('is-on');
    el.nsfw.setAttribute('aria-pressed', 'false');
    state.yearFrom = minYear;
    state.yearTo = maxYear;
    el.yearFrom.value = '';
    el.yearTo.value = '';
    update(true);
  }

  function bindEvents() {
    let timer = 0;
    el.q.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = el.q.value;
        update(false);
      }, 160);
    });

    el.scoreChips.addEventListener('click', (event) => {
      const button = event.target.closest('[data-score]');
      if (!button) return;
      state.minScore = Number(button.dataset.score);
      setPressed(el.scoreChips, button);
      update(true);
    });

    el.lenChips.addEventListener('click', (event) => {
      const button = event.target.closest('[data-len]');
      if (!button) return;
      state.len = Number(button.dataset.len);
      setPressed(el.lenChips, button);
      update(true);
    });

    el.firstChips.addEventListener('click', (event) => {
      const button = event.target.closest('[data-first]');
      if (!button) return;
      const value = button.dataset.first;
      state.first = state.first === value ? '' : value;
      el.firstInput.value = state.first;
      syncFirstChips();
      update(true);
    });

    el.firstInput.addEventListener('input', () => {
      const value = firstChar(el.firstInput.value.trim());
      el.firstInput.value = value;
      state.first = value;
      syncFirstChips();
      update(true);
    });

    document.querySelector('.anime-sort').addEventListener('click', (event) => {
      const button = event.target.closest('[data-sort]');
      if (!button) return;
      state.sort = button.dataset.sort;
      setPressed(button.parentElement, button);
      update(false);
    });

    el.nsfw.addEventListener('click', () => {
      state.nsfw = !state.nsfw;
      el.nsfw.classList.toggle('is-on', state.nsfw);
      el.nsfw.setAttribute('aria-pressed', String(state.nsfw));
      update(true);
    });

    el.yearFrom.addEventListener('change', () => {
      const value = el.yearFrom.value ? Number(el.yearFrom.value) : minYear;
      state.yearFrom = value;
      if (state.yearFrom > state.yearTo) {
        state.yearTo = state.yearFrom;
        el.yearTo.value = String(state.yearFrom);
      }
      update(true);
    });

    el.yearTo.addEventListener('change', () => {
      const value = el.yearTo.value ? Number(el.yearTo.value) : maxYear;
      state.yearTo = value;
      if (state.yearTo < state.yearFrom) {
        state.yearFrom = state.yearTo;
        el.yearFrom.value = String(state.yearFrom);
      }
      update(true);
    });

    el.more.addEventListener('click', () => {
      state.shown += PAGE_SIZE;
      renderList();
    });

    el.count.addEventListener('click', (event) => {
      if (event.target.closest('#anime-reset')) resetFilters();
    });
  }

  function syncFirstChips() {
    el.firstChips.querySelectorAll('[data-first]').forEach((button) => {
      const on = button.dataset.first === state.first;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-pressed', String(on));
    });
  }

  boot();
})();
