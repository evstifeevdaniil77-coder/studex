'use strict';

const MAX_SLOTS = 12;
const PAGE_SIZE = 20;
const STORAGE_KEY = 'mmt_12mest_sheet_v1';
const ABROAD_STORAGE_KEY = 'mmt_12mest_abroad_v1';

// Официальные 5 кластеров ММТ НТЦ (предметы для Компонента А и Б).
const CLUSTERS = {
  1: {
    code: '01',
    name: 'Естественный и технический',
    desc: 'IT, программирование, инженерия, энергетика, строительство, математика и физика.',
    compA: 'Математика, физика, химия (после 11 кл.)',
    compB: 'Математика, физика, основы информатики (после 9 кл.)',
  },
  2: {
    code: '02',
    name: 'Экономика и география',
    desc: 'Финансы, банковское дело, бухгалтерия, менеджмент, туризм, налоги и таможня.',
    compA: 'Математика, география, иностранный язык (после 11 кл.)',
    compB: 'Математика, география, обществоведение (после 9 кл.)',
  },
  3: {
    code: '03',
    name: 'Филология, педагогика и искусство',
    desc: 'Языки, преподавание, журналистика, дизайн, культура, музыка и хореография.',
    compA: 'Таджикский язык, литература, история / иностранный язык (после 11 кл.)',
    compB: 'Таджикский язык, литература, история (после 9 кл.)',
  },
  4: {
    code: '04',
    name: 'Обществоведение и право',
    desc: 'Юриспруденция, международные отношения, госуправление, история и психология.',
    compA: 'История, основы государства и права, иностранный язык (после 11 кл.)',
    compB: 'История, основы государства и права, таджикский язык (после 9 кл.)',
  },
  5: {
    code: '05',
    name: 'Медицина, биология и спорт',
    desc: 'Биология, химия, ветеринария, агрономия, экология и физическая культура.',
    compA: 'Химия, биология, физика (после 11 кл.)',
    compB: 'Химия, биология, естествознание (после 9 кл.)',
  },
};

const state = {
  mode: 'tj',        // 'tj' | 'abroad'
  screen: 'pick',    // 'pick' | 'sheet' | 'abroad' | 'clusters'
  prevScreen: 'pick',
  cluster: 1,
  level: 'ВУЗ',
  messenger: 'Telegram',
  pickData: null,
  pickShown: PAGE_SIZE,
  sheet: loadSheet(),
  abroadSaved: loadAbroadSaved(),
  csModalTab: 'mmt',
  worldLoaded: false,
  worldPage: 1,
  worldTotalPages: 1,
  worldFetchId: 0,
  pickFetchId: 0,
  clusterCounts: {},
  tgUser: null,
  botUsername: '',
};

const $ = (s) => document.querySelector(s);
const fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

function el(tag, attrs = {}, text) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}

function loadSheet() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw.slice(0, MAX_SLOTS) : [];
  } catch {
    return [];
  }
}

function saveSheet() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.sheet));
  } catch { /* ignore */ }
}

function loadAbroadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(ABROAD_STORAGE_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveAbroadSaved() {
  try {
    localStorage.setItem(ABROAD_STORAGE_KEY, JSON.stringify(state.abroadSaved));
  } catch { /* ignore */ }
}

function inAbroadSaved(openalexId) {
  return state.abroadSaved.some((x) => x.openalex_id === openalexId);
}

function updateFloatBar() {
  const mmtN = state.sheet.length;
  const abN = state.abroadSaved.length;
  $('#cs-float-counts').textContent = 'ММТ: ' + mmtN + '/' + MAX_SLOTS + ' · ЗАРУБЕЖ: ' + abN;
  $('#cs-tab-mmt-n').textContent = String(mmtN);
  $('#cs-tab-abroad-n').textContent = String(abN);
}

// ---------- Статусы «Светофор» (обязательно с текстовой подписью) ----------
function statusInfo(chance) {
  if (chance === 'high')    return { text: 'Проходите',         cls: 'st-pass', seg: 'is-pass', color: '#1E5631' };
  if (chance === 'working') return { text: 'Рискованно',        cls: 'st-risk', seg: 'is-risk', color: '#9A5B13' };
  if (chance === 'risk')    return { text: 'Не хватает баллов', cls: 'st-low',  seg: 'is-low',  color: '#9B2C2C' };
  return { text: 'Баллы ожидаются', cls: 'st-wait', seg: 'is-pending', color: '#6B645C' };
}

// ---------- Полоска из 12 сегментов (на каждом экране) ----------
function updateStrip() {
  updateFloatBar();
  const segs = document.querySelectorAll('#strip-12 .seg');
  const bar = $('#strip-12');
  const title = $('#strip-title');
  const hint = $('#strip-hint');

  if (state.screen === 'abroad') {
    const cert = $('#ab-cert-type').value;
    const raw = Number($('#ab-cert-score').value.replace(',', '.'));
    const targetIelts = 6.5;
    let filled = 0;
    let segClass = 'is-low';

    if (cert === 'IELTS' && Number.isFinite(raw) && raw > 0) {
      filled = Math.min(12, Math.round((raw / 9) * 12));
      segClass = raw >= targetIelts ? 'is-pass' : raw >= 5.5 ? 'is-risk' : 'is-low';
      title.textContent = 'ТВОЙ IELTS: ' + fmt.format(raw) + ' ИЗ 9.0';
      hint.textContent = raw >= targetIelts ? '● ПРОЙДЁШЬ' : raw >= 5.5 ? '■ РИСК' : '▲ МАЛО';
    } else if (cert === 'TOEFL' && Number.isFinite(raw) && raw > 0) {
      filled = Math.min(12, Math.round((raw / 120) * 12));
      segClass = raw >= 80 ? 'is-pass' : raw >= 60 ? 'is-risk' : 'is-low';
      title.textContent = 'ТВОЙ TOEFL: ' + fmt.format(raw) + ' ИЗ 120';
      hint.textContent = raw >= 80 ? '● ПРОЙДЁШЬ' : raw >= 60 ? '■ РИСК' : '▲ МАЛО';
    } else {
      title.textContent = 'ТВОЙ IELTS ИЗ НУЖНЫХ';
      hint.textContent = cert === 'NONE' ? 'БЕЗ СЕРТИФИКАТА' : 'ВВЕДИ БАЛЛ';
    }

    bar.setAttribute('aria-valuenow', String(filled));
    segs.forEach((s, i) => {
      s.className = 'seg' + (i < filled ? ' ' + segClass : '');
    });
    return;
  }

  // Режим Таджикистан: заполняется цветами статусов выбранных мест 1–12
  const count = state.sheet.length;
  bar.setAttribute('aria-valuenow', String(count));
  title.textContent = 'БЛАНК НТЦ · ' + count + ' ИЗ ' + MAX_SLOTS;
  hint.textContent = count === 0 ? 'ПУСТО' : count === MAX_SLOTS ? 'ГОТОВО' : 'ЕЩЁ ' + (MAX_SLOTS - count);
  $('#nav-sheet-count').textContent = count + '/' + MAX_SLOTS;

  segs.forEach((s, i) => {
    const item = state.sheet[i];
    if (!item) { s.className = 'seg'; return; }
    s.className = 'seg ' + statusInfo(item.chance).seg;
  });
  updateFloatBar();
}

// ---------- Навигация по 4 экранам ----------
function showScreen(name) {
  if (state.screen !== 'clusters') state.prevScreen = state.screen;
  state.screen = name;
  state.mode = name === 'abroad' ? 'abroad' : 'tj';

  for (const id of ['pick', 'sheet', 'abroad', 'clusters']) {
    $('#screen-' + id).hidden = id !== name;
  }

  $('#tab-tj').setAttribute('aria-selected', String(state.mode === 'tj'));
  $('#tab-abroad').setAttribute('aria-selected', String(state.mode === 'abroad'));
  $('#tj-subtabs').hidden = state.mode !== 'tj';
  $('#nav-pick').setAttribute('aria-pressed', String(name === 'pick'));
  $('#nav-sheet').setAttribute('aria-pressed', String(name === 'sheet'));

  if (name === 'sheet') renderSheet();
  if (name === 'abroad' && !state.worldLoaded) {
    state.worldLoaded = true;
    fetchWorld(1);
  }
  updateStrip();
  window.scrollTo({ top: 0 });
}

$('#brand-home').addEventListener('click', () => showScreen('pick'));
$('#tab-tj').addEventListener('click', () => showScreen(state.screen === 'sheet' ? 'sheet' : 'pick'));
$('#tab-abroad').addEventListener('click', () => showScreen('abroad'));
$('#nav-pick').addEventListener('click', () => showScreen('pick'));
$('#nav-sheet').addEventListener('click', () => showScreen('sheet'));
$('#goto-sheet-inline').addEventListener('click', () => showScreen('sheet'));
$('#open-clusters-btn').addEventListener('click', () => showScreen('clusters'));
$('#ci-more-btn').addEventListener('click', () => showScreen('clusters'));
$('#clusters-back-btn').addEventListener('click', () => showScreen(state.prevScreen || 'pick'));

// ---------- Экран 1: Кластеры + описание ----------
function updateClusterCard() {
  const c = CLUSTERS[state.cluster];
  const cnt = state.clusterCounts[state.cluster];
  $('#ci-kicker').textContent = 'КЛАСТЕР ' + c.code + (cnt ? ' · ' + cnt + ' ПРОГРАММ' : '');
  $('#ci-name').textContent = c.name;
  $('#ci-subjects').textContent = state.level === 'Колледж'
    ? 'Предметы (Б): ' + c.compB
    : 'Предметы (А): ' + c.compA;
}

for (const btn of document.querySelectorAll('#cluster-squares .sq-btn')) {
  btn.addEventListener('click', () => {
    state.cluster = Number(btn.dataset.cluster);
    for (const b of document.querySelectorAll('#cluster-squares .sq-btn')) {
      b.setAttribute('aria-checked', String(b === btn));
    }
    updateClusterCard();
    if (!$('#pick-results-section').hidden) fetchPrograms();
  });
}

for (const btn of document.querySelectorAll('#screen-pick .level-toggle .toggle-btn')) {
  btn.addEventListener('click', () => {
    state.level = btn.dataset.level;
    for (const b of document.querySelectorAll('#screen-pick .level-toggle .toggle-btn')) {
      b.setAttribute('aria-checked', String(b === btn));
    }
    updateClusterCard();
    if (!$('#pick-results-section').hidden) fetchPrograms();
  });
}

// ---------- Экран 1: Загрузка программ из БД ----------
async function fetchPrograms() {
  const myId = ++state.pickFetchId;
  const params = new URLSearchParams({
    cluster: String(state.cluster),
    level: state.level,
  });
  const city = $('#pick-city').value;
  const budgetRaw = $('#pick-budget').value.trim();
  const scoreRaw = $('#pick-score').value.trim().replace(',', '.');

  if (city) params.set('city', city);
  if (budgetRaw !== '') {
    const bNum = Number(budgetRaw);
    if (bNum === 0) params.set('budget_only', '1');
    else if (Number.isFinite(bNum) && bNum > 0) params.set('max_price', String(bNum));
  }
  if (scoreRaw) params.set('score', scoreRaw);

  $('#pick-results-section').hidden = false;
  $('#pick-count').textContent = 'ЗАГРУЗКА…';

  try {
    const r = await fetch('/api/specialties?' + params);
    const data = await r.json();
    if (myId !== state.pickFetchId) return;
    if (!r.ok) {
      $('#pick-count').textContent = data.error || 'ОШИБКА';
      $('#pick-list').replaceChildren();
      return;
    }
    state.pickData = data;
    state.pickShown = PAGE_SIZE;
    renderPickList();
  } catch {
    if (myId !== state.pickFetchId) return;
    $('#pick-count').textContent = 'НЕТ СВЯЗИ С СЕРВЕРОМ';
  }
}

function inSheet(comboId) {
  return state.sheet.some((x) => x.combo_id === comboId);
}

function toggleSlot(row, btn) {
  const idx = state.sheet.findIndex((x) => x.combo_id === row.combo_id);
  const priceText = row.tuition_type === 'budget'
    ? 'Бюджет · 0 TJS'
    : (row.price_tjs ? fmt.format(row.price_tjs) + ' TJS / год' : '');

  if (idx >= 0) {
    state.sheet.splice(idx, 1);
    syncRemoveSaved('mmt', String(row.combo_id));
  } else {
    if (state.sheet.length >= MAX_SLOTS) {
      btn.textContent = 'ЛИМИТ 12';
      setTimeout(() => renderPickButtons(), 1000);
      return;
    }
    state.sheet.push({
      combo_id: row.combo_id,
      cluster: row.cluster,
      code: row.code,
      specialty: row.specialty,
      university: row.university,
      city: row.city,
      tuition_type: row.tuition_type,
      price_tjs: row.price_tjs,
      chance: row.chance,
      min_score_prev: row.min_score_prev,
    });
    syncAddSaved({
      item_type: 'mmt',
      item_id: String(row.combo_id),
      title: row.specialty,
      institution: row.university,
      price_info: priceText,
    });
  }
  saveSheet();
  updateStrip();
  renderPickButtons();
}

function syncAddSaved(item) {
  if (!state.tgUser?.id) return;
  fetch('/api/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telegram_id: state.tgUser.id,
      username: state.tgUser.username || '',
      ...item,
    }),
  }).catch(() => {});
}

function syncRemoveSaved(itemType, itemId) {
  if (!state.tgUser?.id) return;
  const qs = new URLSearchParams({
    telegram_id: String(state.tgUser.id),
    item_type: itemType,
    item_id: itemId,
  });
  fetch('/api/saved?' + qs, { method: 'DELETE' }).catch(() => {});
}

function renderPickButtons() {
  for (const btn of document.querySelectorAll('.btn-slot[data-id]')) {
    const added = inSheet(Number(btn.dataset.id));
    btn.classList.toggle('is-in', added);
    btn.textContent = added ? '✓ В БЛАНКЕ' : '+ В БЛАНК';
  }
}

function renderPickList() {
  const data = state.pickData;
  const list = $('#pick-list');
  const moreBtn = $('#pick-more-btn');
  list.replaceChildren();

  const total = data.results.length;
  $('#pick-count').textContent = 'НАЙДЕНО: ' + fmt.format(total);

  if (total === 0) {
    list.append(el('li', { class: 'brutal-card' }, 'Нет программ по выбранным фильтрам. Измени город или бюджет.'));
    moreBtn.hidden = true;
    return;
  }

  for (const r of data.results.slice(0, state.pickShown)) {
    const li = el('li', { class: 'brutal-card' });
    const st = statusInfo(r.chance);

    const top = el('div', { class: 'prog-card-top' });
    top.append(
      el('div', { class: 'card-kicker' }, r.level + (r.city ? ' · ' + r.city : '') + ' · Код ' + r.code),
      el('span', { class: 'st-badge ' + st.cls }, st.text),
    );

    const priceText = r.tuition_type === 'budget'
      ? 'Бюджет · 0 TJS'
      : (r.price_tjs ? fmt.format(r.price_tjs) + ' TJS / год' : 'Цена не указана');
    const scoreTxt = r.min_score_prev !== null ? fmt.format(r.min_score_prev) + ' б.' : 'Ожидается';

    const grid = el('div', { class: 'card-metrics-grid' });
    const c1 = el('div', { class: 'metric-cell' });
    c1.append(
      el('span', { class: 'metric-label' }, 'Оплата · Места'),
      el('span', { class: 'metric-val' + (r.tuition_type === 'budget' ? ' is-grant' : '') },
        priceText + (r.vacant_seats !== null ? ' · ' + r.vacant_seats + ' мест' : '')),
    );
    const c2 = el('div', { class: 'metric-cell' });
    c2.append(
      el('span', { class: 'metric-label' }, 'Проходной · Форма'),
      el('span', { class: 'metric-val' }, scoreTxt + (r.study_form ? ' · ' + r.study_form : '')),
    );
    grid.append(c1, c2);

    const foot = el('div', { class: 'prog-foot' });
    foot.append(el('span', { class: 'prog-code' }, 'ID ' + r.combo_id));

    const added = inSheet(r.combo_id);
    const btn = el('button', {
      type: 'button',
      class: 'btn-slot' + (added ? ' is-in' : ''),
      'data-id': String(r.combo_id),
    }, added ? '✓ В бланке' : '+ В шпаргалку');
    btn.addEventListener('click', () => toggleSlot(r, btn));
    foot.append(btn);

    li.append(
      top,
      el('p', { class: 'prog-name' }, r.specialty),
      el('p', { class: 'prog-uni' }, r.university),
      grid,
      foot,
    );
    list.append(li);
  }

  const rest = total - state.pickShown;
  moreBtn.hidden = rest <= 0;
  if (rest > 0) moreBtn.textContent = 'ПОКАЗАТЬ ЕЩЁ (' + rest + ')';
}

$('#build-sheet-btn').addEventListener('click', async () => {
  await fetchPrograms();
  $('#pick-results-section').scrollIntoView({ block: 'start' });
});
$('#pick-more-btn').addEventListener('click', () => {
  state.pickShown += PAGE_SIZE;
  renderPickList();
});
$('#pick-city').addEventListener('change', () => fetchPrograms());
$('#pick-budget').addEventListener('input', () => { clearTimeout(window._bt); window._bt = setTimeout(fetchPrograms, 250); });
$('#pick-score').addEventListener('input', () => { clearTimeout(window._st); window._st = setTimeout(fetchPrograms, 250); });

// ---------- Экран 2: Шпаргалка НТЦ (01–12 + Скачать картинкой) ----------
function renderSheet() {
  const ol = $('#sheet-rows');
  ol.replaceChildren();
  $('#sheet-status').hidden = true;

  for (let i = 0; i < MAX_SLOTS; i++) {
    const num = String(i + 1).padStart(2, '0');
    const item = state.sheet[i];

    if (!item) {
      const li = el('li', { class: 'sheet-row is-empty' });
      li.append(el('span', { class: 'sheet-num' }, num));
      const addBtn = el('button', { type: 'button', class: 'sheet-add-btn' }, '+ МЕСТО');
      addBtn.addEventListener('click', () => showScreen('pick'));
      li.append(addBtn);
      ol.append(li);
      continue;
    }

    const st = statusInfo(item.chance);
    const li = el('li', { class: 'sheet-row' });
    li.append(el('span', { class: 'sheet-num' }, num));

    const body = el('div', { class: 'sheet-body' });
    body.append(
      el('span', { class: 'sheet-prog' }, item.university + ' · ' + item.specialty),
      el('span', { class: 'sheet-sub' }, 'ID ' + item.combo_id + ' · Код ' + item.code + ' · Кластер ' + item.cluster),
    );
    const stWrap = el('div');
    stWrap.append(el('span', { class: 'st-badge ' + st.cls }, st.text));
    body.append(stWrap);

    const del = el('button', { type: 'button', class: 'sheet-del-btn', 'aria-label': 'Убрать место ' + num }, '✕');
    del.addEventListener('click', () => {
      const [removed] = state.sheet.splice(i, 1);
      if (removed) syncRemoveSaved('mmt', String(removed.combo_id));
      saveSheet();
      updateStrip();
      renderSheet();
    });

    li.append(body, del);
    ol.append(li);
  }
}

$('#sheet-clear-btn').addEventListener('click', () => {
  state.sheet = [];
  saveSheet();
  updateStrip();
  renderSheet();
});

function showSheetMsg(text, isErr = false) {
  const msg = $('#sheet-status');
  msg.textContent = text;
  msg.classList.toggle('is-err', isErr);
  msg.hidden = false;
}

function collectAllSavedItems() {
  return [
    ...state.sheet.map((it) => ({
      item_type: 'mmt',
      item_id: String(it.combo_id),
      title: it.specialty,
      institution: it.university,
      price_info: it.tuition_type === 'budget'
        ? 'Бюджет · 0 TJS'
        : (it.price_tjs ? fmt.format(it.price_tjs) + ' TJS / год' : ''),
    })),
    ...state.abroadSaved.map((u) => ({
      item_type: 'abroad',
      item_id: u.openalex_id,
      title: u.name,
      institution: [u.country, u.city].filter(Boolean).join(', '),
      price_info: [u.base_tuition_usd ? u.base_tuition_usd + ' USD/год' : '', u.min_ielts ? 'IELTS ' + u.min_ielts : ''].filter(Boolean).join(' · '),
    })),
  ];
}

async function syncAllToTelegramBot(btn, statusEl) {
  const items = collectAllSavedItems();
  if (!items.length) {
    statusEl.className = 'status-msg is-err';
    statusEl.textContent = 'Шпаргалка пуста. Добавь хотя бы одну программу или вуз.';
    statusEl.hidden = false;
    return;
  }

  saveSheet();
  saveAbroadSaved();
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'СОХРАНЯЕМ…';

  try {
    // 1) Внутри Telegram Mini App — сохраняем напрямую по telegram_id
    if (state.tgUser?.id) {
      const r = await fetch('/api/saved/sync-telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegram_id: state.tgUser.id,
          username: state.tgUser.username || '',
          items,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      statusEl.className = 'status-msg';
      statusEl.textContent = data.telegramSent
        ? 'Сохранено в боте · список отправлен в чат (/saved)'
        : 'Сохранено в боте · доступно по команде /saved';
      statusEl.hidden = false;
      return;
    }

    // 2) В обычном браузере — создаём временный черновик и перенаправляем в Telegram Deep Link
    const r = await fetch('/api/shpar/create-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);

    statusEl.className = 'bot-handoff';
    statusEl.replaceChildren(
      el('p', {}, 'Шпаргалка подготовлена (' + data.count + ' поз.). Нажми «Start» в Telegram-боте, чтобы получить список в личку:'),
      el('a', {
        class: 'btn-primary',
        href: data.deep_link,
        target: '_blank',
        rel: 'noopener noreferrer',
      }, 'ПЕРЕЙТИ В TELEGRAM'),
    );
    statusEl.hidden = false;

    const popup = window.open(data.deep_link, '_blank', 'noopener,noreferrer');
    if (!popup) window.location.href = data.deep_link;
  } catch (err) {
    statusEl.className = 'status-msg is-err';
    statusEl.textContent = err.message || 'Ошибка сохранения. Попробуйте ещё раз.';
    statusEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

$('#sync-tg-btn').addEventListener('click', () => syncAllToTelegramBot($('#sync-tg-btn'), $('#sheet-status')));

$('#copy-sheet-btn').addEventListener('click', async () => {
  if (!state.sheet.length) return showSheetMsg('ШПАРГАЛКА ПУСТА', true);
  const lines = state.sheet.map((it, i) =>
    `${String(i + 1).padStart(2, '0')}. ID ${it.combo_id} | Код ${it.code} | ${it.university} · ${it.specialty}`,
  );
  try {
    await navigator.clipboard.writeText('12 МЕСТ — ШПАРГАЛКА НТЦ:\n' + lines.join('\n'));
    showSheetMsg('СКОПИРОВАНО В БУФЕР');
  } catch {
    showSheetMsg('НЕ УДАЛОСЬ СКОПИРОВАТЬ', true);
  }
});

// Экспорт бланка 01–12 в PNG (тёплый песок и терракота)
$('#download-png-btn').addEventListener('click', () => {
  const W = 780, H = 1320;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#FAF7F2';
  ctx.fillRect(0, 0, W, H);

  // Шапка
  ctx.fillStyle = '#B45309';
  ctx.fillRect(32, 34, 56, 56);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 28px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('12', 60, 64);

  ctx.textAlign = 'left';
  ctx.fillStyle = '#1F2937';
  ctx.font = 'bold 30px Georgia, serif';
  ctx.fillText('Studex · Шпаргалка НТЦ (12 мест)', 106, 64);

  // 12 строк
  let y = 122;
  for (let i = 0; i < MAX_SLOTS; i++) {
    const num = String(i + 1).padStart(2, '0');
    const item = state.sheet[i];
    ctx.fillStyle = item ? '#FFFDF9' : '#FAF7F2';
    ctx.fillRect(32, y, W - 64, 82);
    ctx.strokeStyle = item ? '#E8E1D5' : '#D6CCBC';
    ctx.lineWidth = 2;
    ctx.strokeRect(32, y, W - 64, 82);

    ctx.fillStyle = item ? '#B45309' : '#6B645C';
    ctx.font = 'bold 22px Georgia, serif';
    ctx.fillText(num, 50, y + 46);

    if (item) {
      const st = statusInfo(item.chance);
      const label = (item.university + ' · ' + item.specialty).slice(0, 52);
      ctx.fillStyle = '#1F2937';
      ctx.font = '600 19px sans-serif';
      ctx.fillText(label, 98, y + 34);
      ctx.fillStyle = '#6B645C';
      ctx.font = '16px sans-serif';
      ctx.fillText('ID ' + item.combo_id + ' · Код ' + item.code + ' · Кластер ' + item.cluster, 98, y + 62);
      ctx.fillStyle = st.color;
      ctx.font = '600 15px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(st.text, W - 48, y + 62);
      ctx.textAlign = 'left';
    } else {
      ctx.fillStyle = '#6B645C';
      ctx.font = '500 18px sans-serif';
      ctx.fillText('+ пустое место', 98, y + 46);
    }
    y += 94;
  }

  ctx.fillStyle = '#6B645C';
  ctx.font = '15px sans-serif';
  ctx.fillText('Studex · 12 мест · ntc.tj', 32, H - 24);

  const link = document.createElement('a');
  link.download = '12-mest-ntc.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
  showSheetMsg('Картинка 12-mest-ntc.png сохранена');
});

// ---------- Экран 3: За рубежом (OpenAlex 10 000 + агентство) ----------
let worldTimer = null;
function scheduleWorld(delay = 0) {
  clearTimeout(worldTimer);
  if (delay === 0) fetchWorld(1);
  else worldTimer = setTimeout(() => fetchWorld(1), delay);
}

$('#ab-cert-type').addEventListener('change', () => {
  const v = $('#ab-cert-type').value;
  $('#ab-score-wrap').hidden = v === 'NONE';
  const inp = $('#ab-cert-score');
  if (v === 'IELTS') {
    $('#ab-score-label').textContent = 'ТВОЙ IELTS';
    inp.max = '9'; inp.step = '0.5'; inp.placeholder = 'Например: 6.5';
  } else if (v === 'TOEFL') {
    $('#ab-score-label').textContent = 'ТВОЙ TOEFL iBT';
    inp.max = '120'; inp.step = '1'; inp.placeholder = 'Например: 90';
  }
  updateStrip();
  scheduleWorld(0);
});
$('#ab-cert-score').addEventListener('input', () => { updateStrip(); scheduleWorld(200); });
$('#ab-gpa').addEventListener('input', () => scheduleWorld(200));
$('#ab-budget').addEventListener('input', () => scheduleWorld(200));
$('#ab-country').addEventListener('change', () => scheduleWorld(0));
$('#ab-search').addEventListener('input', () => scheduleWorld(220));
$('#ab-show-all').addEventListener('change', () => scheduleWorld(0));
$('#ab-prev').addEventListener('click', () => { if (state.worldPage > 1) fetchWorld(state.worldPage - 1); });
$('#ab-next').addEventListener('click', () => { if (state.worldPage < state.worldTotalPages) fetchWorld(state.worldPage + 1); });

function abroadBadgeClass(status) {
  if (status === 'high') return 'st-pass';
  if (status === 'medium') return 'st-risk';
  if (status === 'low') return 'st-low';
  return 'st-wait';
}

async function fetchWorld(page) {
  const myId = ++state.worldFetchId;
  const params = new URLSearchParams({ page: String(page), limit: '10' });
  const certType = $('#ab-cert-type').value;
  const certScore = $('#ab-cert-score').value.trim().replace(',', '.');
  const gpa = $('#ab-gpa').value.trim().replace(',', '.');
  const budget = $('#ab-budget').value.trim();
  const country = $('#ab-country').value;
  const q = $('#ab-search').value.trim();

  if (certType === 'IELTS' && certScore) params.set('ielts', certScore);
  if (certType === 'TOEFL' && certScore) params.set('toefl', certScore);
  if (gpa) params.set('gpa', gpa);
  if (budget !== '') params.set('budget', budget);
  if (country) params.set('country', country);
  if (q) params.set('query', q);
  if ($('#ab-show-all').checked) params.set('show_all', '1');

  $('#ab-count').textContent = 'ЗАГРУЗКА…';
  try {
    const r = await fetch('/api/abroad/search?' + params);
    const data = await r.json();
    if (myId !== state.worldFetchId) return;
    state.worldPage = data.page;
    state.worldTotalPages = data.totalPages;

    const list = $('#abroad-list');
    list.replaceChildren();
    const hiddenNote = data.hiddenCount ? ' (скрыто неподходящих: ' + fmt.format(data.hiddenCount) + ')' : '';
    $('#ab-count').textContent = 'ВУЗОВ: ' + fmt.format(data.total) + hiddenNote;
    $('#ab-pager').hidden = data.total <= 10;
    $('#ab-page-num').textContent = data.page + '/' + data.totalPages;
    $('#ab-prev').disabled = data.page <= 1;
    $('#ab-next').disabled = data.page >= data.totalPages;

    if (data.total === 0) {
      list.append(el('li', { class: 'brutal-card' }, 'По этим параметрам вузов не найдено. Попробуй изменить фильтр или включить «Показать все вузы».'));
      return;
    }

    for (const u of data.results) {
      const li = el('li', { class: 'brutal-card' });
      const adm = u.admission_chance || { status: 'unknown', badge: 'Требования уточняются', label: 'Уточняется' };
      const grant = u.grant_chance || { label: 'Грант: проверка по анкете', summary: 'По запросу', highlight: false };

      // 1) Верхняя строка: мета + название + бейдж Светофора
      const top = el('div', { class: 'prog-card-top' });
      top.append(
        el('div', { class: 'card-kicker' }, u.institution_type + ' · ' + u.country + (u.city ? ' · ' + u.city : '')),
        el('span', { class: 'st-badge ' + abroadBadgeClass(adm.status) }, adm.badge),
      );
      li.append(top, el('h2', { class: 'prog-name' }, u.name));

      // 2) Средний блок: 2 показателя в ряд (Шанс поступления | Грант / Стоимость)
      const grid = el('div', { class: 'card-metrics-grid' });
      const m1 = el('div', { class: 'metric-cell' });
      m1.append(
        el('span', { class: 'metric-label' }, 'Шанс поступления'),
        el('span', { class: 'metric-val' }, adm.label),
      );
      const m2 = el('div', { class: 'metric-cell' });
      m2.append(
        el('span', { class: 'metric-label' }, 'Грант / Стоимость'),
        el('span', { class: 'metric-val' + (grant.highlight ? ' is-grant' : '') }, grant.summary || grant.label),
      );
      grid.append(m1, m2);
      li.append(grid);

      // Плашка гранта + короткое объяснение в 1 строку
      li.append(el('div', { class: 'grant-pill' + (grant.highlight ? '' : ' is-muted') }, grant.label));
      if (u.reason) li.append(el('p', { class: 'card-reason' }, u.reason));

      if (u.official_url) {
        const linkP = el('p', { class: 'card-desc' });
        linkP.append(el('a', { href: u.official_url, target: '_blank', rel: 'noopener noreferrer' }, 'Официальный сайт →'));
        li.append(linkP);
      }

      // 3) Нижняя строка: + В шпаргалку | Подобрать грант
      const actions = el('div', { class: 'card-actions-row' });
      const saved = inAbroadSaved(u.openalex_id);
      const saveBtn = el('button', {
        type: 'button',
        class: 'btn-save-abroad' + (saved ? ' is-in' : ''),
        'data-abroad-id': u.openalex_id,
      }, saved ? '✓ В списке' : '+ В шпаргалку');
      saveBtn.addEventListener('click', () => toggleAbroadSaved(u));

      const btn = el('button', { type: 'button', class: 'btn-primary' }, 'Подобрать грант');
      btn.addEventListener('click', () => openAgencyDialog(u.name + ' (' + u.country + ')'));
      actions.append(saveBtn, btn);
      li.append(actions);
      list.append(li);
    }
  } catch {
    if (myId !== state.worldFetchId) return;
    $('#ab-count').textContent = 'НЕТ СВЯЗИ С СЕРВЕРОМ';
  }
}

// ---------- Зарубежная шпаргалка (без лимита 12) + модальное окно с 2 отсеками ----------
function toggleAbroadSaved(u) {
  const idx = state.abroadSaved.findIndex((x) => x.openalex_id === u.openalex_id);
  const priceParts = [];
  if (u.base_tuition_usd) priceParts.push(u.base_tuition_usd + ' USD/год');
  if (u.min_ielts) priceParts.push('IELTS ' + u.min_ielts);
  const priceInfo = priceParts.join(' · ');

  if (idx >= 0) {
    state.abroadSaved.splice(idx, 1);
    syncRemoveSaved('abroad', u.openalex_id);
  } else {
    state.abroadSaved.push({
      openalex_id: u.openalex_id,
      name: u.name,
      country: u.country,
      city: u.city || '',
      institution_type: u.institution_type,
      min_ielts: u.min_ielts || null,
      min_toefl_ibt: u.min_toefl_ibt || null,
      base_tuition_usd: u.base_tuition_usd || null,
      scholarships_grants: u.scholarships_grants || null,
    });
    syncAddSaved({
      item_type: 'abroad',
      item_id: u.openalex_id,
      title: u.name,
      institution: [u.country, u.city].filter(Boolean).join(', '),
      price_info: priceInfo,
    });
  }
  saveAbroadSaved();
  updateFloatBar();
  renderAbroadSaveButtons();
  if ($('#cheatsheet-dialog').open) renderCheatsheetModal();
}

function renderAbroadSaveButtons() {
  for (const btn of document.querySelectorAll('.btn-save-abroad[data-abroad-id]')) {
    const added = inAbroadSaved(btn.dataset.abroadId);
    btn.classList.toggle('is-in', added);
    btn.textContent = added ? '✓ В СПИСКЕ' : '+ В ШПАРГАЛКУ';
  }
}

const csModal = $('#cheatsheet-dialog');

function selectCsTab(tab) {
  state.csModalTab = tab;
  $('#cs-tab-mmt').setAttribute('aria-selected', String(tab === 'mmt'));
  $('#cs-tab-abroad').setAttribute('aria-selected', String(tab === 'abroad'));
  $('#cs-modal-action').textContent = tab === 'mmt'
    ? 'СКОПИРОВАТЬ ДЛЯ БЛАНКА'
    : 'ПОДОБРАТЬ ГРАНТ ПО СПИСКУ';
  renderCheatsheetModal();
}

function renderCheatsheetModal() {
  const body = $('#cs-modal-body');
  const status = $('#cs-modal-status');
  status.hidden = true;
  body.replaceChildren();
  updateFloatBar();

  if (state.csModalTab === 'mmt') {
    if (!state.sheet.length) {
      body.append(el('p', { class: 'screen-sub' },
        'Бланк ММТ пуст. Добавь до 12 программ Таджикистана кнопкой «+ В БЛАНК».'));
      return;
    }
    const ul = el('ol', { class: 'cs-modal-list' });
    state.sheet.forEach((item, i) => {
      const li = el('li', { class: 'sheet-row' });
      li.append(el('span', { class: 'sheet-num' }, String(i + 1).padStart(2, '0')));
      const info = el('div', { class: 'sheet-body' });
      const price = item.tuition_type === 'budget'
        ? 'Бюджет · 0 TJS'
        : (item.price_tjs ? fmt.format(item.price_tjs) + ' TJS/год' : '[цена]');
      info.append(
        el('span', { class: 'sheet-prog' }, item.specialty),
        el('span', { class: 'sheet-sub' }, item.university + ' · ID ' + item.combo_id + ' · Код ' + item.code + ' · ' + price),
      );
      const del = el('button', { type: 'button', class: 'sheet-del-btn', 'aria-label': 'Удалить' }, '✕');
      del.addEventListener('click', () => {
        const [rem] = state.sheet.splice(i, 1);
        if (rem) syncRemoveSaved('mmt', String(rem.combo_id));
        saveSheet();
        updateStrip();
        renderPickButtons();
        if (state.screen === 'sheet') renderSheet();
        renderCheatsheetModal();
      });
      li.append(info, del);
      ul.append(li);
    });
    body.append(ul);
    return;
  }

  // Вкладка «Зарубежные вузы» (без лимита)
  if (!state.abroadSaved.length) {
    body.append(el('p', { class: 'screen-sub' },
      'Зарубежные вузы ещё не добавлены. Открой вкладку «ЗА РУБЕЖОМ» и нажми «+ В ШПАРГАЛКУ» на нужных вузах (без лимита).'));
    return;
  }
  const ul = el('ol', { class: 'cs-modal-list' });
  state.abroadSaved.forEach((u, i) => {
    const li = el('li', { class: 'sheet-row' });
    li.append(el('span', { class: 'sheet-num' }, String(i + 1).padStart(2, '0')));
    const info = el('div', { class: 'sheet-body' });
    const loc = [u.country, u.city].filter(Boolean).join(', ');
    const details = [
      u.min_ielts ? 'IELTS ' + u.min_ielts : (u.min_toefl_ibt ? 'TOEFL ' + u.min_toefl_ibt : 'IELTS: [балл]'),
      u.base_tuition_usd ? u.base_tuition_usd + ' USD/год' : 'Цена/грант: [по запросу]',
    ].join(' · ');
    info.append(
      el('span', { class: 'sheet-prog' }, u.name),
      el('span', { class: 'sheet-sub' }, loc + ' · ' + details),
    );
    const del = el('button', { type: 'button', class: 'sheet-del-btn', 'aria-label': 'Удалить' }, '✕');
    del.addEventListener('click', () => {
      const [rem] = state.abroadSaved.splice(i, 1);
      if (rem) syncRemoveSaved('abroad', rem.openalex_id);
      saveAbroadSaved();
      updateFloatBar();
      renderAbroadSaveButtons();
      renderCheatsheetModal();
    });
    li.append(info, del);
    ul.append(li);
  });
  body.append(ul);
}

function showCsStatus(text, isErr = false) {
  const st = $('#cs-modal-status');
  st.textContent = text;
  st.classList.toggle('is-err', isErr);
  st.hidden = false;
}

$('#cs-float-open').addEventListener('click', () => {
  selectCsTab(state.screen === 'abroad' ? 'abroad' : 'mmt');
  csModal.showModal();
});
$('#cs-tab-mmt').addEventListener('click', () => selectCsTab('mmt'));
$('#cs-tab-abroad').addEventListener('click', () => selectCsTab('abroad'));

$('#cs-modal-action').addEventListener('click', async () => {
  if (state.csModalTab === 'mmt') {
    if (!state.sheet.length) return showCsStatus('БЛАНК ММТ ПУСТ', true);
    const lines = state.sheet.map((it, i) =>
      `${String(i + 1).padStart(2, '0')}. ID ${it.combo_id} | Код ${it.code} | ${it.university} · ${it.specialty}`,
    );
    try {
      await navigator.clipboard.writeText('ШПАРГАЛКА ММТ (' + state.sheet.length + '/12):\n' + lines.join('\n'));
      showCsStatus('СПИСОК ММТ СКОПИРОВАН');
    } catch {
      showCsStatus('НЕ УДАЛОСЬ СКОПИРОВАТЬ', true);
    }
  } else {
    if (!state.abroadSaved.length) return showCsStatus('СПИСОК ВУЗОВ ПУСТ', true);
    const names = state.abroadSaved.map((u) => u.name + ' (' + u.country + ')').join('; ');
    csModal.close();
    openAgencyDialog(names.slice(0, 200));
  }
});

$('#cs-modal-sync-bot').addEventListener('click', () =>
  syncAllToTelegramBot($('#cs-modal-sync-bot'), $('#cs-modal-status')));

// Fallback light-dismiss для csModal (Safari)
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, d) => {
    const r = d.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let csDownOut = false;
  csModal.addEventListener('pointerdown', (e) => { csDownOut = outside(e, csModal); });
  csModal.addEventListener('pointerup', (e) => { if (csDownOut && outside(e, csModal)) csModal.close(); });
}

// ---------- Модальное окно заявки агентству ----------
const agencyDialog = $('#agency-dialog');

function openAgencyDialog(uniLabel) {
  $('#ag-target-uni').value = uniLabel;
  $('#agency-target').textContent = uniLabel;
  $('#agency-msg').hidden = true;
  $('#agency-matches').hidden = true;
  $('#agency-matches').replaceChildren();
  for (const e of agencyDialog.querySelectorAll('.field-err')) { e.textContent = ''; e.hidden = true; }
  agencyDialog.showModal();
}

// Fallback light-dismiss для Safari (без closedBy)
if (!('closedBy' in HTMLDialogElement.prototype)) {
  const outside = (e, d) => {
    const r = d.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let downOut = false;
  agencyDialog.addEventListener('pointerdown', (e) => { downOut = outside(e, agencyDialog); });
  agencyDialog.addEventListener('pointerup', (e) => { if (downOut && outside(e, agencyDialog)) agencyDialog.close(); });
}

for (const btn of document.querySelectorAll('#agency-form [data-messenger]')) {
  btn.addEventListener('click', () => {
    state.messenger = btn.dataset.messenger;
    for (const b of document.querySelectorAll('#agency-form [data-messenger]')) {
      b.setAttribute('aria-checked', String(b === btn));
    }
  });
}

$('#agency-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#agency-msg');
  msg.hidden = true;
  for (const er of agencyDialog.querySelectorAll('.field-err')) { er.textContent = ''; er.hidden = true; }

  const payload = {
    certificate: $('#ab-cert-type').value,
    certificate_score: $('#ab-cert-score').value.trim().replace(',', '.'),
    gpa: $('#ab-gpa').value.trim().replace(',', '.'),
    region: $('#ag-region').value,
    budget_usd: $('#ab-budget').value.trim() || '0',
    name: $('#ag-name').value.trim(),
    phone: $('#ag-phone').value.trim(),
    messenger: state.messenger,
    target_university: $('#ag-target-uni').value,
    website: $('#ag-website').value,
  };

  const btn = agencyDialog.querySelector('.dialog-submit');
  btn.disabled = true;
  btn.textContent = 'ОТПРАВЛЯЕМ…';
  try {
    const r = await fetch('/api/abroad-leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) {
      if (data.fields) {
        for (const [k, v] of Object.entries(data.fields)) {
          const box = document.getElementById('err-' + k);
          if (box) { box.textContent = v; box.hidden = false; }
        }
      }
      throw new Error(data.error);
    }
    msg.textContent = 'ЗАЯВКА ПРИНЯТА И ПЕРЕДАНА ПАРТНЁРАМ · СВЯЖЕМСЯ В ' + state.messenger.toUpperCase();
    msg.classList.remove('is-err');
    msg.hidden = false;

    const mBox = $('#agency-matches');
    mBox.replaceChildren();
    if (Array.isArray(data.matches) && data.matches.length) {
      mBox.append(el('p', { class: 'block-label', style: 'margin: 12px 0 8px' }, 'АВТОПОДБОР ПО ТВОЕМУ РЕГИОНУ (OPENALEX):'));
      const ul = el('ul', { class: 'prog-list' });
      for (const u of data.matches) {
        const li = el('li', { class: 'sheet-row' });
        const b = el('div', { class: 'sheet-body' });
        b.append(
          el('span', { class: 'sheet-prog' }, u.name),
          el('span', { class: 'sheet-sub' }, u.country + (u.city ? ' · ' + u.city : '') + ' · ' + u.institution_type),
        );
        li.append(b);
        ul.append(li);
      }
      mBox.append(ul);
      mBox.hidden = false;
    }
  } catch (err) {
    msg.textContent = (err.message || 'ОШИБКА ОТПРАВКИ').toUpperCase();
    msg.classList.add('is-err');
    msg.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'ОТПРАВИТЬ ЗАЯВКУ';
  }
});

// ---------- Экран 4: 5 карточек «Что значит кластер» ----------
function renderClustersDetail() {
  const wrap = $('#clusters-detail-list');
  wrap.replaceChildren();
  for (const [idStr, c] of Object.entries(CLUSTERS)) {
    const id = Number(idStr);
    const card = el('article', { class: 'brutal-card' });
    const cnt = state.clusterCounts[id];
    card.append(
      el('div', { class: 'card-kicker' }, 'КЛАСТЕР ' + c.code + (cnt ? ' · ' + cnt + ' ПРОГРАММ В БАЗЕ' : '')),
      el('h2', { class: 'card-title' }, c.name),
      el('p', { class: 'card-desc' }, c.desc),
    );
    const bA = el('div', { class: 'comp-block' });
    bA.append(el('strong', {}, 'КОМПОНЕНТ А (ПОСЛЕ 11 КЛ.)'), el('span', {}, c.compA));
    const bB = el('div', { class: 'comp-block' });
    bB.append(el('strong', {}, 'КОМПОНЕНТ Б (ПОСЛЕ 9 КЛ.)'), el('span', {}, c.compB));
    const choose = el('button', { type: 'button', class: 'btn-secondary' }, 'ВЫБРАТЬ КЛАСТЕР ' + id);
    choose.addEventListener('click', () => {
      state.cluster = id;
      for (const b of document.querySelectorAll('#cluster-squares .sq-btn')) {
        b.setAttribute('aria-checked', String(Number(b.dataset.cluster) === id));
      }
      updateClusterCard();
      showScreen('pick');
    });
    card.append(bA, bB, choose);
    wrap.append(card);
  }
}

// ---------- Инициализация Telegram Mini App ----------
function initTelegramWebApp() {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
    if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor('#FFFDF9');
    if (typeof tg.setBackgroundColor === 'function') tg.setBackgroundColor('#FAF7F2');
    if (tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id) {
      state.tgUser = {
        id: tg.initDataUnsafe.user.id,
        username: tg.initDataUnsafe.user.username || '',
      };
    }
  } catch { /* вне Telegram */ }
}

// ---------- Инициализация справочников ----------
async function init() {
  initTelegramWebApp();
  updateClusterCard();
  renderClustersDetail();
  updateStrip();

  try {
    const statsUrl = state.tgUser?.id ? '/api/stats?telegram_id=' + state.tgUser.id : '/api/stats';
    const r = await fetch(statsUrl);
    const s = await r.json();
    state.botUsername = s.botUsername || '';
    $('#db-counter').textContent = 'БАЗА: ' + fmt.format(s.specialties) + ' ММТ';
    for (const c of (s.clusters || [])) state.clusterCounts[c.id] = c.n;
    updateClusterCard();
    renderClustersDetail();

    for (const city of (s.cities || [])) $('#pick-city').append(el('option', { value: city }, city));
    for (const reg of (s.regions || [])) $('#ag-region').append(el('option', { value: reg }, reg));
    for (const wc of (s.worldCountries || [])) {
      $('#ab-country').append(el('option', { value: wc.country }, wc.country + ' (' + fmt.format(wc.n) + ')'));
    }
    if (s.ads?.courses) $('#sheet-ad-text').textContent = 'Реклама · ' + s.ads.courses;
  } catch {
    $('#db-counter').textContent = 'ОФЛАЙН';
  }
  fetchPrograms();
}

init();
