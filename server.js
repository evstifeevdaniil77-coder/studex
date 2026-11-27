// Навигатор поступления — сервер без внешних зависимостей.
// Требуется Node.js 22.13+ (встроенный модуль node:sqlite и fetch).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

if (fs.existsSync(path.join(ROOT, '.env'))) {
  process.loadEnvFile(path.join(ROOT, '.env'));
}

const PORT = Number(process.env.PORT || 8000);
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || 'data/navigator.db');
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const PARTNER_CHANNEL_ID = process.env.PARTNER_CHANNEL_ID || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const WEBAPP_URL = (process.env.WEBAPP_URL || 'https://studex-4myq.onrender.com').trim();
let BOT_USERNAME = (process.env.BOT_USERNAME || '').replace(/^@/, '').trim();

let ALLOWED_ORIGIN = '';
if (WEBAPP_URL) {
  try { ALLOWED_ORIGIN = new URL(WEBAPP_URL).origin; } catch { /* ignore invalid URL */ }
}

function isOriginAllowed(origin, req) {
  if (!origin) return true;
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) return true;
  const host = req?.headers?.host;
  if (host && (origin === `https://${host}` || origin === `http://${host}`)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!isOriginAllowed(origin, req)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return true;
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function makeRateLimiter(maxPerMinute = 10) {
  const store = new Map();
  const windowMs = 60_000;
  return (ip) => {
    const now = Date.now();
    if (store.size > 2000) {
      for (const [k, list] of store) {
        if (!list.some((t) => now - t < windowMs)) store.delete(k);
      }
    }
    const hits = (store.get(ip) || []).filter((t) => now - t < windowMs);
    hits.push(now);
    store.set(ip, hits);
    return hits.length > maxPerMinute;
  };
}

const limitLeads = makeRateLimiter(10);
const limitShpar = makeRateLimiter(10);

async function resolveBotUsername() {
  if (!BOT_TOKEN) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    if (d.ok && d.result?.username) {
      BOT_USERNAME = d.result.username;
      console.log(`Telegram-бот: @${BOT_USERNAME}`);
    }
  } catch (e) {
    console.error('Telegram getMe:', e.message);
  }
}
// Курс задаёт администратор. Если не задан — цены в USD не показываются.
const USD_TJS_RATE = Number(process.env.USD_TJS_RATE) > 0 ? Number(process.env.USD_TJS_RATE) : null;
// Насколько баллов ниже проходного на договор ещё считается «риском».
const RISK_MARGIN = Number(process.env.RISK_MARGIN) >= 0 && process.env.RISK_MARGIN !== undefined
  ? Number(process.env.RISK_MARGIN) : 15;
const AD_COURSES_TEXT = process.env.AD_COURSES_TEXT || '';
const AD_PRIVATE_TEXT = process.env.AD_PRIVATE_TEXT || '';

// ---------- База данных ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8'));
// Безопасные миграции для существующих БД.
const leadCols = db.prepare('PRAGMA table_info(abroad_leads)').all().map((c) => c.name);
const leadMigrations = [
  ['target_university', "TEXT NOT NULL DEFAULT ''"],
  ['status', "TEXT NOT NULL DEFAULT 'new'"],
  ['claimed_by_id', 'INTEGER'],
  ['claimed_by_username', "TEXT NOT NULL DEFAULT ''"],
  ['claimed_at', 'TEXT'],
  ['partner_message_id', 'INTEGER'],
];
for (const [col, def] of leadMigrations) {
  if (!leadCols.includes(col)) {
    db.exec(`ALTER TABLE abroad_leads ADD COLUMN ${col} ${def}`);
  }
}

// Авторазворачивание базы каталога на чистом сервере (Render и т.п.) из data/seed_catalog.json.gz.
function seedDatabaseIfEmpty() {
  const specCount = db.prepare('SELECT COUNT(*) AS n FROM specialties').get().n;
  const worldCount = db.prepare('SELECT COUNT(*) AS n FROM world_institutions').get().n;
  if (specCount > 0 && worldCount > 0) return;

  const seedPath = path.join(ROOT, 'data', 'seed_catalog.json.gz');
  if (!fs.existsSync(seedPath)) {
    console.warn(`Сид каталога не найден: ${seedPath}`);
    return;
  }

  const t0 = Date.now();
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(seedPath)).toString('utf8'));
  db.exec('BEGIN');
  try {
    if (specCount === 0) {
      const insCluster = db.prepare('INSERT OR IGNORE INTO clusters (id, name) VALUES (?, ?)');
      for (const c of data.clusters || []) insCluster.run(c.id, c.name);

      const insInst = db.prepare(
        'INSERT OR IGNORE INTO institutions (type, region, name, address, phone) VALUES (?, ?, ?, ?, ?)'
      );
      for (const i of data.institutions || []) {
        insInst.run(i.type, i.region || '', i.name, i.address || '', i.phone || '');
      }

      const insSpec = db.prepare(
        `INSERT OR IGNORE INTO specialties
          (combo_id, level, cluster, code, specialty, university, city, study_form,
           tuition_type, price_tjs, language, vacant_seats, min_score_prev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const s of data.specialties || []) {
        insSpec.run(
          s.combo_id, s.level, s.cluster, s.code, s.specialty, s.university,
          s.city || '', s.study_form || '', s.tuition_type, s.price_tjs ?? null,
          s.language || '', s.vacant_seats ?? null, s.min_score_prev ?? null
        );
      }
    }

    if (worldCount === 0) {
      const insWorld = db.prepare(
        `INSERT OR IGNORE INTO world_institutions
          (openalex_id, ror_id, name, institution_type, country_code, country, city,
           official_url, research_works_count, cited_by_count, global_ranking,
           instruction_language, min_ielts, min_toefl_ibt, base_tuition_usd,
           tuition_entry_details, scholarships_grants)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const w of data.world_institutions || []) {
        insWorld.run(
          w.openalex_id, w.ror_id ?? null, w.name, w.institution_type, w.country_code,
          w.country, w.city || '', w.official_url ?? null, w.research_works_count || 0,
          w.cited_by_count || 0, w.global_ranking ?? null, w.instruction_language ?? null,
          w.min_ielts ?? null, w.min_toefl_ibt ?? null, w.base_tuition_usd ?? null,
          w.tuition_entry_details ?? null, w.scholarships_grants ?? null
        );
      }
    }
    db.exec('COMMIT');
    console.log(
      `База развернута из сида за ${Date.now() - t0} мс ` +
      `(ММТ: ${db.prepare('SELECT COUNT(*) AS n FROM specialties').get().n}, ` +
      `вузов мира: ${db.prepare('SELECT COUNT(*) AS n FROM world_institutions').get().n})`
    );
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Ошибка разворачивания сида:', err);
  }
}
seedDatabaseIfEmpty();

// Базовые официальные пороги для топ-100 мировых вузов (IELTS 7.0) и проверенных
// популярных направлений (только если поля ещё NULL — не перезаписывают импорт из Excel).
function applyAbroadBaselines() {
  const curated = [
    // [openalex_id, min_ielts, min_toefl_ibt, base_tuition_usd, scholarships_grants, instruction_language]
    ['I181397559', '5.0', '46', '6500', 'Merit Scholarship (до 30%)', 'English'],                      // APU Malaysia
    ['I204275683', '5.0', '46', '3000', 'Гос. гранты РК и скидки', 'English / Russian'],               // Satbayev University
    ['I185571130', '5.5', '60', '3500', 'Стипендии для граждан СНГ', 'English / Russian'],             // Al-Farabi KazNU
    ['I60559429',  '6.0', '79', '0',    'Full Grant (Abay Kunanbayev / NU)', 'English'],               // Nazarbayev University
    ['I4210143550','5.5', '46', '9500', 'Taylor’s Excellence Award', 'English'],                       // Taylor's University
    ['I130343225', '5.5', '60', '4200', 'MIS Malaysia Scholarship', 'English'],                        // Universiti Putra Malaysia
    ['I132735039', '5.5', '66', '6500', 'Stipendium Hungaricum (Full Grant)', 'English'],              // University of Debrecen
    ['I106118109', '5.5', '66', '5000', 'Stipendium Hungaricum (Full Grant)', 'English'],              // Eötvös Loránd University
    ['I4654613',   '6.0', '79', '3600', 'NAWA / Banach Scholarship', 'English / Polish'],              // University of Warsaw
    ['I201799495', null,  '75', '1800', 'Türkiye Bursları (Full Grant)', 'English'],                   // METU (Только TOEFL 75+)
    ['I48912391',  null,  '75', '1600', 'Türkiye Bursları (Full Grant)', 'English'],                   // ITU (Только TOEFL 75+)
    ['I4405392',   null,  '79', '2000', 'Türkiye Bursları (Full Grant)', 'English'],                   // Boğaziçi (Только TOEFL 79+)
  ];
  const updCurated = db.prepare(`
    UPDATE world_institutions
       SET min_ielts = ?,
           min_toefl_ibt = ?,
           base_tuition_usd = COALESCE(base_tuition_usd, ?),
           scholarships_grants = COALESCE(scholarships_grants, ?),
           instruction_language = COALESCE(instruction_language, ?)
     WHERE openalex_id = ? AND min_ielts IS NULL AND min_toefl_ibt IS NULL
  `);
  for (const [id, ielts, toefl, tuition, grant, lang] of curated) {
    updCurated.run(ielts, toefl, tuition, grant, lang, id);
  }
  // Для топ-100 мировых вузов по научному весу ставим базовый порог min_ielts = 7.0
  db.exec(`
    UPDATE world_institutions
       SET min_ielts = '7.0'
     WHERE openalex_id IN (
       SELECT openalex_id FROM world_institutions
        ORDER BY research_works_count DESC
        LIMIT 100
     )
       AND min_ielts IS NULL AND min_toefl_ibt IS NULL
  `);
}
applyAbroadBaselines();

const q = {
  count: db.prepare('SELECT COUNT(*) AS n FROM specialties'),
  scored: db.prepare('SELECT COUNT(*) AS n FROM specialties WHERE min_score_prev IS NOT NULL'),
  clusters: db.prepare(`SELECT s.cluster AS id, COALESCE(c.name, '') AS name, COUNT(*) AS n
                          FROM specialties s LEFT JOIN clusters c ON c.id = s.cluster
                         GROUP BY s.cluster ORDER BY s.cluster`),
  cities: db.prepare("SELECT DISTINCT city FROM specialties WHERE city <> '' ORDER BY city"),
  languages: db.prepare("SELECT DISTINCT language FROM specialties WHERE language <> ''"),
  levels: db.prepare('SELECT DISTINCT level FROM specialties ORDER BY level'),
  studyForms: db.prepare("SELECT DISTINCT study_form FROM specialties WHERE study_form <> '' ORDER BY study_form"),
  maxPrice: db.prepare("SELECT MAX(price_tjs) AS max_price FROM specialties WHERE tuition_type = 'contract'"),
  worldCount: db.prepare('SELECT COUNT(*) AS n FROM world_institutions'),
  worldCountries: db.prepare('SELECT country, COUNT(*) AS n FROM world_institutions GROUP BY country ORDER BY n DESC, country ASC'),
  insertLead: db.prepare(`INSERT INTO abroad_leads
    (certificate, certificate_score, gpa, region, budget_usd, name, phone, messenger, target_university, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`),
  markSent: db.prepare('UPDATE abroad_leads SET telegram_sent = 1, partner_message_id = ? WHERE id = ?'),
  logEvent: db.prepare('INSERT INTO site_events (event_type, value, telegram_id) VALUES (?, ?, ?)'),
  getSaved: db.prepare(`SELECT id, telegram_id, username, item_type, item_id, title, institution, price_info, created_at
                          FROM user_saved_programs WHERE telegram_id = ?
                         ORDER BY CASE item_type WHEN 'mmt' THEN 0 ELSE 1 END, id ASC`),
  upsertSaved: db.prepare(`INSERT INTO user_saved_programs
    (telegram_id, username, item_type, item_id, title, institution, price_info)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (telegram_id, item_type, item_id) DO UPDATE SET
      username = excluded.username,
      title = excluded.title,
      institution = excluded.institution,
      price_info = excluded.price_info`),
  deleteSaved: db.prepare('DELETE FROM user_saved_programs WHERE telegram_id = ? AND item_type = ? AND item_id = ?'),
  mmtContact: db.prepare(`SELECT s.code, s.cluster, s.tuition_type, s.price_tjs, i.address, i.phone
                            FROM specialties s
                            LEFT JOIN institutions i ON i.name = s.university
                           WHERE CAST(s.combo_id AS TEXT) = ?`),
  insertDraft: db.prepare('INSERT INTO shpar_drafts (token, items_json) VALUES (?, ?)'),
};

function logEvent(type, value = '', tgId = null) {
  try { q.logEvent.run(type, String(value || ''), tgId); } catch { /* ignore */ }
}

// ---------- Справочники анкеты ----------
const REGIONS = [
  'Европа',
  'Великобритания',
  'США и Канада',
  'Россия и страны СНГ',
  'Турция',
  'Китай, Корея, Япония',
  'Малайзия и Юго-Восточная Азия',
  'ОАЭ и Ближний Восток',
  'Пока не решили',
];

// ---------- Вспомогательные функции ----------
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.').trim());
  return Number.isFinite(n) ? n : null;
}

// Метка программы:
//   pending — проходной балл не опубликован (min_score_prev = NULL), баллы не придумываем;
//   high    — бюджет, балл не ниже прошлогоднего проходного;
//   working — договор, балл не ниже прошлогоднего проходного;
//   risk    — балл ниже проходного не более чем на RISK_MARGIN;
//   null    — балл слишком низкий, программа не показывается.
function chanceFor(score, row) {
  const min = row.min_score_prev;
  if (min === null) return 'pending';
  if (score === null) return 'pending';
  if (score >= min) return row.tuition_type === 'budget' ? 'high' : 'working';
  if (score >= min - RISK_MARGIN) return 'risk';
  return null;
}

// Языки в базе бывают составными («тоҷикӣ, русӣ») — для фильтра разбиваем на отдельные.
function splitLanguages(rows) {
  const set = new Set();
  for (const { language } of rows) {
    for (const l of language.split(',')) if (l.trim()) set.add(l.trim());
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

// ---------- API ----------
function apiStats(res, params) {
  const tgId = toNumber(params.get('telegram_id'));
  logEvent('visit', '', tgId && Number.isInteger(tgId) ? tgId : null);
  sendJson(res, 200, {
    specialties: q.count.get().n,
    scored: q.scored.get().n,
    clusters: q.clusters.all(),
    levels: q.levels.all().map((r) => r.level),
    studyForms: q.studyForms.all().map((r) => r.study_form),
    cities: q.cities.all().map((r) => r.city),
    languages: splitLanguages(q.languages.all()),
    maxPriceTjs: q.maxPrice.get().max_price || 0,
    worldCount: q.worldCount.get().n,
    worldCountries: q.worldCountries.all(),
    botUsername: BOT_USERNAME,
    usdRate: USD_TJS_RATE,
    riskMargin: RISK_MARGIN,
    regions: REGIONS,
    ads: { courses: AD_COURSES_TEXT, private: AD_PRIVATE_TEXT },
  });
}

const CHANCE_ORDER = { high: 0, working: 1, risk: 2, pending: 3 };

function apiSearch(res, params) {
  const cluster = Number(params.get('cluster'));
  if (!Number.isInteger(cluster) || cluster < 1 || cluster > 5) {
    return sendJson(res, 400, { error: 'Выберите кластер от 1 до 5.' });
  }
  logEvent('cluster_search', String(cluster));
  const rawScore = (params.get('score') || '').trim();
  const score = toNumber(rawScore);
  if (rawScore && (score === null || score < 0 || score > 1000)) {
    return sendJson(res, 400, { error: 'Введите балл ММТ числом.' });
  }
  // Пока проходные баллы не опубликованы, балл ученика не обязателен.
  if (score === null && q.scored.get().n > 0) {
    return sendJson(res, 400, { error: 'Введите ваш балл ММТ.' });
  }

  const where = ['s.cluster = ?'];
  const args = [cluster];
  const level = (params.get('level') || '').trim();
  const studyForm = (params.get('study_form') || '').trim();
  const city = (params.get('city') || '').trim();
  const language = (params.get('language') || '').trim();
  const budgetOnly = params.get('budget_only') === '1' || params.get('budget_only') === 'true';
  const maxPrice = toNumber(params.get('max_price'));
  if (level) { where.push('s.level = ?'); args.push(level); }
  if (studyForm) { where.push('s.study_form = ?'); args.push(studyForm); }
  if (city) { where.push('s.city = ?'); args.push(city); }
  if (language) {
    where.push("(', ' || s.language || ',') LIKE ?");
    args.push(`%, ${language},%`);
  }
  if (budgetOnly) {
    where.push("s.tuition_type = 'budget'");
  } else if (maxPrice !== null && maxPrice >= 0) {
    where.push("(s.tuition_type = 'budget' OR s.price_tjs <= ?)");
    args.push(maxPrice);
  }

  const rows = db.prepare(
    `SELECT s.combo_id, s.level, s.cluster, s.code, s.specialty, s.university, s.city,
            s.study_form, s.tuition_type, s.price_tjs, s.language, s.vacant_seats, s.min_score_prev,
            i.region AS inst_region, i.address AS inst_address, i.phone AS inst_phone
       FROM specialties s
       LEFT JOIN institutions i ON i.name = s.university
      WHERE ${where.join(' AND ')}`
  ).all(...args);

  const results = [];
  for (const r of rows) {
    const chance = chanceFor(score, r);
    if (chance) results.push({ ...r, chance });
  }
  // Сначала «Светофор» (если баллы есть), затем программы без баллов.
  // Внутри группы: бюджет, затем контракт от дешёвого к дорогому, затем больше мест.
  results.sort((a, b) =>
    CHANCE_ORDER[a.chance] - CHANCE_ORDER[b.chance] ||
    (a.tuition_type === 'budget' ? 0 : 1) - (b.tuition_type === 'budget' ? 0 : 1) ||
    (a.tuition_type === 'budget' ? 0 : (a.price_tjs ?? Infinity)) -
      (b.tuition_type === 'budget' ? 0 : (b.price_tjs ?? Infinity)) ||
    (b.vacant_seats ?? 0) - (a.vacant_seats ?? 0) ||
    a.specialty.localeCompare(b.specialty, 'ru'));

  sendJson(res, 200, {
    total: rows.length,
    scoresPublished: rows.some((r) => r.min_score_prev !== null),
    results,
  });
}

function parseFirstNumber(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const m = String(raw).replace(/\s+/g, '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function evaluateAbroadInstitution(r, { userIelts, userToefl, userGpa, userBudget }) {
  const reqIelts = parseFirstNumber(r.min_ielts);
  const reqToefl = parseFirstNumber(r.min_toefl_ibt);
  const tuition = parseFirstNumber(r.base_tuition_usd);
  const hasFullGrant = /full|100%|stipendium|burslar|csc|kaist|dsu|er\.go|чешск/i.test(r.scholarships_grants || '') || tuition === 0;
  const hasDiscount = Boolean(r.scholarships_grants) && !hasFullGrant;
  const toeflOnly = reqIelts === null && reqToefl !== null;
  const isVerified = reqIelts !== null || reqToefl !== null || tuition !== null;

  const hasScore = userIelts !== null || userToefl !== null;
  const hasGpa = userGpa !== null;
  const hasBudget = userBudget !== null && userBudget >= 0;
  const hasAnyInput = hasScore || hasGpa || hasBudget;

  const tuitionShort = tuition === 0
    ? 'Полный грант ($0/год)'
    : (tuition !== null ? `$${tuition.toLocaleString('en-US')}/год` : 'Цена по запросу');
  const grantSummary = hasFullGrant
    ? (r.scholarships_grants ? `${r.scholarships_grants}` + (tuition ? ` или ${tuitionShort}` : '') : tuitionShort)
    : (hasDiscount ? `${tuitionShort} · ${r.scholarships_grants}` : tuitionShort);

  // 1) Общая база OpenAlex без проверенных порогов — честный unknown
  if (!isVerified) {
    return {
      group: 'unknown',
      sortDiff: 99,
      admission_chance: {
        status: 'unknown',
        badge: hasAnyInput ? 'Требования уточняются' : 'Впишите IELTS и GPA для оценки шансов',
        label: 'IELTS и порог уточняются',
      },
      grant_chance: {
        label: 'Грант: проверка по анкете',
        summary: 'Грант: проверка по анкете',
        highlight: false,
      },
      reason: 'Вуз из базы OpenAlex: точные требования IELTS и цены уточняем по запросу.',
    };
  }

  // 2) Если ученик ещё не ввёл ни балл, ни GPA, ни бюджет
  if (!hasAnyInput) {
    const reqLabel = reqIelts !== null ? `Мин. IELTS ${r.min_ielts}` : (reqToefl !== null ? `Только TOEFL ${r.min_toefl_ibt}+` : 'Проверенный вуз');
    return {
      group: 'verified_idle',
      sortDiff: 0,
      admission_chance: {
        status: 'unknown',
        badge: 'Впишите IELTS и GPA для оценки шансов',
        label: reqLabel,
      },
      grant_chance: {
        label: hasFullGrant ? `Доступен полный грант (${r.scholarships_grants || '100%'})` : (hasDiscount ? 'Скидка за оценки: 10%–30%' : 'Обучение на контракте'),
        summary: grantSummary,
        highlight: hasFullGrant,
      },
      reason: `${reqLabel}. Впишите свой IELTS/TOEFL, GPA и бюджет, чтобы увидеть шанс.`,
    };
  }

  // 3) Проверенный вуз + есть ввод ученика
  let diff = null;
  if (userIelts !== null && reqIelts !== null) {
    diff = Number((userIelts - reqIelts).toFixed(2));
  } else if (userToefl !== null && reqToefl !== null) {
    diff = Number(((userToefl - reqToefl) / 15).toFixed(2));
  }

  // Турецкие вузы, принимающие только TOEFL, когда введён IELTS
  if (toeflOnly && userIelts !== null && userToefl === null) {
    return {
      group: 'unknown',
      sortDiff: 50,
      admission_chance: {
        status: 'unknown',
        badge: `Только TOEFL ${r.min_toefl_ibt}+`,
        label: `Нужен TOEFL iBT ${r.min_toefl_ibt}+`,
      },
      grant_chance: {
        label: hasFullGrant ? `Полный грант (${r.scholarships_grants})` : 'Грант: проверка по анкете',
        summary: grantSummary,
        highlight: hasFullGrant,
      },
      reason: `Этот вуз принимает TOEFL iBT от ${r.min_toefl_ibt} баллов вместо IELTS.`,
    };
  }

  const gpaOk = !hasGpa || userGpa >= 4.0;
  const gpaBorder = hasGpa && userGpa >= 3.5 && userGpa < 4.0;
  const gpaLow = hasGpa && userGpa < 3.5;

  const budgetOk = !hasBudget || tuition === null || tuition <= userBudget || hasFullGrant;
  const budgetNear = hasBudget && tuition !== null && !hasFullGrant && tuition > userBudget && tuition <= userBudget * 1.2;
  const budgetWayOver = hasBudget && tuition !== null && !hasFullGrant && tuition > userBudget * 1.2;

  const reqShort = reqIelts !== null ? `IELTS ${r.min_ielts}+` : (reqToefl !== null ? `TOEFL ${r.min_toefl_ibt}+` : 'по анкете');

  // HIGH: язык >= порога, GPA >= 4.0 (или не задан), бюджет ок или есть полный грант
  if ((diff === null || diff >= 0) && gpaOk && budgetOk) {
    const strongForGrant = (!hasGpa || userGpa >= 4.5) && (!hasScore || (userIelts !== null ? userIelts >= 6.0 : userToefl >= 80));
    const grantLabel = hasFullGrant
      ? (strongForGrant ? 'Шанс на полный грант: Высокий (GPA 4.5+ и IELTS 6.0+)' : `Доступен полный грант (${r.scholarships_grants})`)
      : (hasDiscount ? 'Скидка за оценки: 10%–30%' : 'Контракт укладывается в бюджет');
    return {
      group: 'high',
      sortDiff: diff !== null ? diff : 0,
      admission_chance: {
        status: 'high',
        badge: hasFullGrant ? 'Высокий шанс · Грант доступен' : 'Высокий шанс',
        label: `Высокий · ${reqShort}`,
      },
      grant_chance: {
        label: grantLabel,
        summary: grantSummary,
        highlight: hasFullGrant || hasDiscount,
      },
      reason: `Подходите по требованиям (${reqShort}${hasGpa ? ', GPA ' + userGpa : ''}) и условиям финансирования.`,
    };
  }

  // MEDIUM: не хватает <= 0.5 IELTS, или GPA 3.5–3.9, или бюджет в пределах +20%
  const scoreNear = diff !== null && diff < 0 && diff >= -0.5;
  if (!gpaLow && !budgetWayOver && (scoreNear || gpaBorder || budgetNear) && (diff === null || diff >= -0.5)) {
    const badge = scoreNear
      ? 'Реальный шанс · Нужен +0.5 IELTS / Foundation'
      : (gpaBorder ? 'Реальный шанс · Подтяните GPA' : 'Реальный шанс · Бюджет +20%');
    const label = scoreNear ? `Через Foundation · ${reqShort}` : `Реальный · ${reqShort}`;
    const reason = scoreNear
      ? `До прямого поступления (${reqShort}) не хватает ≤ 0.5 балла — можно через Foundation.`
      : (gpaBorder ? `GPA ${userGpa} чуть ниже 4.0, но поступление реально при сильном пакете документов.` : `Контракт чуть выше бюджета — помогут частичные скидки.`);
    return {
      group: 'medium',
      sortDiff: diff !== null ? Math.abs(diff) : 0.3,
      admission_chance: { status: 'medium', badge, label },
      grant_chance: {
        label: hasFullGrant ? `Возможен грант (${r.scholarships_grants})` : (hasDiscount ? 'Скидка за оценки: 10%–30%' : 'Частичные скидки по анкете'),
        summary: grantSummary,
        highlight: hasFullGrant || hasDiscount,
      },
      reason,
    };
  }

  // LOW: не хватает > 0.5 IELTS, GPA < 3.5, или бюджет значительно ниже контракта без полного гранта
  const reason = (diff !== null && diff < -0.5)
    ? `Требуется ${reqShort} — текущих баллов пока недостаточно.`
    : (budgetWayOver ? `Контракт (${tuitionShort}) существенно выше указанного бюджета.` : `Требуется более высокий GPA (от 3.5–4.0).`);
  return {
    group: 'low',
    sortDiff: diff !== null ? Math.abs(diff) : 10,
    admission_chance: {
      status: 'low',
      badge: 'Низкий шанс / Не хватает баллов',
      label: `Низкий · ${reqShort}`,
    },
    grant_chance: {
      label: hasFullGrant ? `Грант (${r.scholarships_grants}) требует выше баллы` : 'Полный грант маловероятен',
      summary: grantSummary,
      highlight: false,
    },
    reason,
  };
}

// 5 направлений обучения для зарубежных вузов (аналог 5 кластеров ММТ).
const ABROAD_DIRECTIONS = {
  1: {
    name: 'IT, инженерия и техника',
    re: /\b(tech|technolog\w*|polytech\w*|politecnic\w*|engineer\w*|informat\w*|comput\w*|cyber\w*|mining|aviation|aerospace|transport|physic\w*|math\w*|science|sciences|mit|eth|kaist|rwth|tum|itu|metu|caltech|satbayev|bauman)\b/i,
  },
  2: {
    name: 'Экономика, бизнес и финансы',
    re: /\b(econ\w*|busin\w*|financ\w*|manag\w*|commerc\w*|trade|bank\w*|account\w*|touris\w*|hospitality|market\w*|entrepreneur\w*|hse|lse|insead|hec|wharton|corvinus|plekhanov|sgh)\b/i,
  },
  3: {
    name: 'Филология, языки и искусство',
    re: /\b(art|arts|music\w*|design|linguist\w*|philolog\w*|pedagog\w*|educat\w*|teach\w*|cultur\w*|film|theat\w*|conservat\w*|humanit\w*|languag\w*|literat\w*|journal\w*|media|architecture|normal\s+univ\w*)\b/i,
  },
  4: {
    name: 'Право, политика и общество',
    re: /\b(law|legal|jurid\w*|politic\w*|policy|diplom\w*|international\s+relations|public\s+admin\w*|govern\w*|social\s+scien\w*|sociol\w*|histor\w*|psycholog\w*|sciences\s+po|mgimo|kutafin)\b/i,
  },
  5: {
    name: 'Медицина и биология',
    re: /\b(medic\w*|health|biolog\w*|biomed\w*|pharm\w*|dent\w*|nurs\w*|veterin\w*|agricult\w*|agrar\w*|sport\w*|clinic\w*|hospital|sechenov|pirogov|karolinska|johns\s+hopkins|charit\w*)\b/i,
  },
};

// Проверенные курируемые вузы и их подтверждённые направления (1..5).
const CURATED_DIRECTIONS = {
  'University of Warsaw': [1, 2, 3, 4],
  'Universiti Putra Malaysia': [1, 2, 5],
  'Middle East Technical University': [1, 2, 4],
  'Istanbul Technical University': [1],
  'Eötvös Loránd University': [1, 3, 4],
  'University of Debrecen': [1, 2, 3, 4, 5],
  'Al-Farabi Kazakh National University': [1, 2, 3, 4, 5],
  'Boğaziçi University': [1, 2, 3, 4],
  'Nazarbayev University': [1, 2, 3, 4, 5],
  "Taylor's University": [1, 2, 3, 4, 5],
  'Satbayev University': [1],
  'Asia Pacific University of Technology & Innovation': [1, 2],
};

// Возвращает 2 (профильный вуз), 1 (проверенный многопрофильный вуз), 0 (не подходит под направление).
function matchAbroadDirection(r, direction) {
  if (!direction || !ABROAD_DIRECTIONS[direction]) return 1;
  const hay = `${r.name || ''} ${r.tuition_entry_details || ''} ${r.scholarships_grants || ''}`;
  const exactRe = ABROAD_DIRECTIONS[direction].re;
  if (exactRe.test(hay)) return 2;

  const curated = CURATED_DIRECTIONS[r.name];
  if (curated) return curated.includes(direction) ? 2 : 0;

  // Многопрофильный проверенный вуз (например Harvard, Oxford, Toronto): подходит, если он не узкопрофильный по другому направлению
  const isVerified = r.min_ielts !== null || r.min_toefl_ibt !== null;
  if (isVerified) {
    const narrowOther = Object.entries(ABROAD_DIRECTIONS)
      .some(([k, cfg]) => Number(k) !== direction && cfg.re.test(r.name || ''));
    if (!narrowOther) return 1;
  }
  return 0;
}

function apiAbroadSearch(res, params) {
  const limit = Math.min(50, Math.max(1, Number(params.get('limit')) || 20));
  const page = Math.max(1, Number(params.get('page')) || 1);
  const country = (params.get('country') || '').trim();
  const type = (params.get('type') || '').trim();
  const search = (params.get('query') || params.get('q') || '').trim();
  const rawDir = toNumber(params.get('direction'));
  const direction = rawDir !== null && rawDir >= 1 && rawDir <= 5 && Number.isInteger(rawDir) ? rawDir : null;
  const userIelts = toNumber(params.get('ielts'));
  const userToefl = toNumber(params.get('toefl'));
  const userGpa = toNumber(params.get('gpa'));
  const userBudget = toNumber(params.get('budget'));
  const showAll = params.get('show_all') === '1' || params.get('show_all') === 'true';

  const where = [];
  const args = [];
  if (country) { where.push('country = ?'); args.push(country); logEvent('country_search', country); }
  if (type === 'University' || type === 'College') { where.push('institution_type = ?'); args.push(type); }
  if (search) {
    where.push('(name LIKE ? COLLATE NOCASE OR city LIKE ? COLLATE NOCASE)');
    args.push(`%${search}%`, `%${search}%`);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const ctx = { userIelts, userToefl, userGpa, userBudget };
  const hasAnyInput = userIelts !== null || userToefl !== null || userGpa !== null || (userBudget !== null && userBudget >= 0);

  // Быстрый путь без параметров оценки и без фильтра по направлению: прямая SQL-пагинация
  if (!hasAnyInput && !direction) {
    const offset = (page - 1) * limit;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM world_institutions ${clause}`).get(...args).n;
    const rows = db.prepare(
      `SELECT openalex_id, ror_id, name, institution_type, country_code, country, city,
              official_url, research_works_count, cited_by_count,
              global_ranking, instruction_language, min_ielts, min_toefl_ibt,
              base_tuition_usd, tuition_entry_details, scholarships_grants
         FROM world_institutions ${clause}
        ORDER BY CASE WHEN min_ielts IS NOT NULL OR min_toefl_ibt IS NOT NULL THEN 0 ELSE 1 END,
                 research_works_count DESC, name ASC
        LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);

    const results = rows.map((r) => {
      const ev = evaluateAbroadInstitution(r, ctx);
      return { ...r, admission_chance: ev.admission_chance, grant_chance: ev.grant_chance, reason: ev.reason };
    });
    return sendJson(res, 200, {
      total, hiddenCount: 0, page, limit, direction: null,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      results,
    });
  }

  // Полное ранжирование (с учётом направления 1..5 и 4 групп high -> medium -> unknown -> low)
  const allRows = db.prepare(
    `SELECT openalex_id, ror_id, name, institution_type, country_code, country, city,
            official_url, research_works_count, cited_by_count,
            global_ranking, instruction_language, min_ielts, min_toefl_ibt,
            base_tuition_usd, tuition_entry_details, scholarships_grants
       FROM world_institutions ${clause}`
  ).all(...args);

  const buckets = { high: [], medium: [], unknown: [], low: [] };
  for (const r of allRows) {
    const dirRank = matchAbroadDirection(r, direction);
    if (direction && dirRank === 0) continue;
    const ev = evaluateAbroadInstitution(r, ctx);
    const enriched = {
      ...r,
      _diff: ev.sortDiff,
      _dirRank: dirRank,
      _verified: (r.min_ielts !== null || r.min_toefl_ibt !== null) ? 1 : 0,
      admission_chance: ev.admission_chance,
      grant_chance: ev.grant_chance,
      reason: ev.reason,
    };
    const key = ev.group === 'verified_idle' ? 'high' : ev.group;
    buckets[key].push(enriched);
  }

  const cmp = (a, b) =>
    b._verified - a._verified ||
    b._dirRank - a._dirRank ||
    a._diff - b._diff ||
    b.research_works_count - a.research_works_count;

  buckets.high.sort(cmp);
  buckets.medium.sort(cmp);
  buckets.unknown.sort(cmp);
  buckets.low.sort(cmp);

  const combined = (showAll || !hasAnyInput)
    ? [...buckets.high, ...buckets.medium, ...buckets.unknown, ...buckets.low]
    : [...buckets.high, ...buckets.medium, ...buckets.unknown];

  const total = combined.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * limit;

  sendJson(res, 200, {
    total,
    direction,
    hiddenCount: (showAll || !hasAnyInput) ? 0 : buckets.low.length,
    counts: {
      high: buckets.high.length,
      medium: buckets.medium.length,
      unknown: buckets.unknown.length,
      low: buckets.low.length,
    },
    page: safePage,
    limit,
    totalPages,
    results: combined.slice(start, start + limit).map(({ _diff, _dirRank, _verified, ...rest }) => rest),
  });
}

// Простое ограничение частоты заявок с одного адреса.
const leadHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const hits = (leadHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  leadHits.set(ip, hits);
  return hits.length > 5;
}

function validateLead(d) {
  const errors = {};
  const certificate = ['IELTS', 'TOEFL', 'NONE'].includes(d.certificate) ? d.certificate : null;
  if (!certificate) errors.certificate = 'Выберите сертификат или «Нет сертификата».';

  let certificateScore = null;
  if (certificate === 'IELTS') {
    certificateScore = toNumber(d.certificate_score);
    if (certificateScore === null || certificateScore < 0 || certificateScore > 9 || (certificateScore * 2) % 1 !== 0) {
      errors.certificate_score = 'Балл IELTS — от 0 до 9 с шагом 0,5.';
    }
  } else if (certificate === 'TOEFL') {
    certificateScore = toNumber(d.certificate_score);
    if (certificateScore === null || certificateScore < 0 || certificateScore > 120 || !Number.isInteger(certificateScore)) {
      errors.certificate_score = 'Балл TOEFL iBT — целое число от 0 до 120.';
    }
  }

  const gpa = toNumber(d.gpa);
  if (gpa === null || gpa < 1 || gpa > 5) errors.gpa = 'Средний балл аттестата — число от 1 до 5.';

  const region = REGIONS.includes(d.region) ? d.region : null;
  if (!region) errors.region = 'Выберите регион из списка.';

  const budget = toNumber(d.budget_usd);
  if (budget === null || budget < 0 || budget > 1_000_000 || !Number.isInteger(budget)) {
    errors.budget_usd = 'Введите бюджет целым числом в долларах.';
  }

  const name = String(d.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) errors.name = 'Введите имя (от 2 до 100 символов).';

  const phone = String(d.phone || '').trim();
  const digits = phone.replace(/\D/g, '');
  if (!/^[+\d\s()-]+$/.test(phone) || digits.length < 9 || digits.length > 15) {
    errors.phone = 'Введите номер телефона, например +992 900 00 00 00.';
  }

  const messenger = ['Telegram', 'WhatsApp'].includes(d.messenger) ? d.messenger : null;
  if (!messenger) errors.messenger = 'Выберите, где с вами связаться.';

  const targetUniversity = String(d.target_university || '').trim().replace(/\s+/g, ' ').slice(0, 200);

  return {
    errors,
    lead: { certificate, certificateScore, gpa, region, budget, name, phone, messenger, targetUniversity },
  };
}

// Соответствие регионов анкеты ISO-кодам стран в world_institutions (для автоподбора).
const REGION_COUNTRIES = {
  'Европа': ['DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'CZ', 'AT', 'SE', 'CH', 'HU', 'FI', 'BE', 'NO'],
  'Великобритания': ['GB'],
  'США и Канада': ['US', 'CA'],
  'Россия и страны СНГ': ['RU', 'KZ', 'BY', 'UZ', 'KG', 'AM', 'AZ'],
  'Турция': ['TR'],
  'Китай, Корея, Япония': ['CN', 'KR', 'JP'],
  'Малайзия и Юго-Восточная Азия': ['MY', 'SG', 'TH', 'ID', 'VN', 'PH'],
  'ОАЭ и Ближний Восток': ['AE', 'SA', 'QA', 'IL', 'JO'],
};

function autoMatchWorldInstitutions(lead) {
  const codes = REGION_COUNTRIES[lead.region] || null;
  if (codes && codes.length) {
    const placeholders = codes.map(() => '?').join(',');
    return db.prepare(
      `SELECT openalex_id, name, institution_type, country, city, official_url,
              min_ielts, base_tuition_usd, research_works_count
         FROM world_institutions
        WHERE country_code IN (${placeholders})
        ORDER BY research_works_count DESC
        LIMIT 5`
    ).all(...codes);
  }
  return db.prepare(
    `SELECT openalex_id, name, institution_type, country, city, official_url,
            min_ielts, base_tuition_usd, research_works_count
       FROM world_institutions
      ORDER BY research_works_count DESC
      LIMIT 5`
  ).all();
}

async function sendTelegramMessage(chatId, text, replyMarkup = null) {
  if (!BOT_TOKEN || !chatId) return null;
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok || !payload.ok) {
      console.error('Telegram:', r.status, JSON.stringify(payload));
      return null;
    }
    return payload.result?.message_id || true;
  } catch (e) {
    console.error('Telegram:', e.message);
    return null;
  }
}

async function notifyPartnerChannel(id, l) {
  const targetChat = PARTNER_CHANNEL_ID || ADMIN_CHAT_ID;
  if (!BOT_TOKEN || !targetChat) return null;
  const cert = l.certificate === 'NONE' ? 'Нет' : `${l.certificate} ${l.certificateScore}`;
  const lines = [
    `НОВЫЙ ЛИД #${id} · Studex (За рубежом)`,
    `Имя: ${l.name}`,
    `Контакт: ${l.phone} (${l.messenger})`,
    `Сертификат: ${cert}`,
    `GPA аттестата: ${l.gpa}`,
    `Регион: ${l.region}`,
    `Бюджет / год: ${l.budget} USD`,
  ];
  if (l.targetUniversity) lines.push(`Интересующий вуз: ${l.targetUniversity}`);
  return sendTelegramMessage(targetChat, lines.join('\n'), {
    inline_keyboard: [[
      { text: 'Забрать лид в работу', callback_data: `claim_lead:${id}` },
    ]],
  });
}

async function apiLead(req, res) {
  const ip = getClientIp(req);
  let data;
  try {
    data = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Неверный формат заявки.' });
  }
  // Скрытое поле-ловушка для ботов.
  if (data.website) return sendJson(res, 200, { ok: true, matches: [] });
  if (limitLeads(ip)) return sendJson(res, 429, { error: 'Слишком много заявок (лимит 10 в минуту). Попробуйте чуть позже.' });

  const { errors, lead } = validateLead(data);
  if (Object.keys(errors).length) return sendJson(res, 400, { error: 'Проверьте поля анкеты.', fields: errors });

  const { lastInsertRowid } = q.insertLead.run(
    lead.certificate, lead.certificateScore, lead.gpa, lead.region,
    lead.budget, lead.name, lead.phone, lead.messenger, lead.targetUniversity,
  );
  const id = Number(lastInsertRowid);
  const matches = autoMatchWorldInstitutions(lead);
  const msgId = await notifyPartnerChannel(id, lead);
  if (msgId) q.markSent.run(typeof msgId === 'number' ? msgId : null, id);
  sendJson(res, 201, { ok: true, id, matches });
}

// ---------- Сохранённые программы (Mini App <-> Telegram-бот) ----------
function parseTgId(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function apiGetSaved(res, params) {
  const tgId = parseTgId(params.get('telegram_id'));
  if (!tgId) return sendJson(res, 400, { error: 'Нужен telegram_id.' });
  sendJson(res, 200, { items: q.getSaved.all(tgId) });
}

async function apiAddSaved(req, res) {
  let d;
  try { d = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Неверный JSON.' }); }
  const tgId = parseTgId(d.telegram_id);
  const itemType = d.item_type === 'mmt' || d.item_type === 'abroad' ? d.item_type : null;
  const itemId = String(d.item_id || '').trim();
  const title = String(d.title || '').trim().slice(0, 200);
  const institution = String(d.institution || '').trim().slice(0, 250);
  const priceInfo = String(d.price_info || '').trim().slice(0, 120);
  const username = String(d.username || '').trim().slice(0, 64);
  if (!tgId || !itemType || !itemId || !title || !institution) {
    return sendJson(res, 400, { error: 'Заполните обязательные поля сохранения.' });
  }
  q.upsertSaved.run(tgId, username, itemType, itemId, title, institution, priceInfo);
  sendJson(res, 200, { ok: true, items: q.getSaved.all(tgId) });
}

function apiDeleteSaved(res, params) {
  const tgId = parseTgId(params.get('telegram_id'));
  const itemType = params.get('item_type');
  const itemId = (params.get('item_id') || '').trim();
  if (!tgId || !itemType || !itemId) return sendJson(res, 400, { error: 'Неверные параметры удаления.' });
  q.deleteSaved.run(tgId, itemType, itemId);
  sendJson(res, 200, { ok: true, items: q.getSaved.all(tgId) });
}

async function apiSyncSavedTelegram(req, res) {
  if (limitShpar(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Слишком много запросов (лимит 10 в минуту). Подождите минуту.' });
  }
  let d;
  try { d = JSON.parse(await readBody(req, 40_000)); } catch { return sendJson(res, 400, { error: 'Неверный JSON.' }); }
  const tgId = parseTgId(d.telegram_id);
  if (!tgId) {
    const botRef = BOT_USERNAME ? `@${BOT_USERNAME}` : 'Telegram-бота Studex';
    return sendJson(res, 400, { error: `Откройте Studex внутри ${botRef}, чтобы синхронизировать список.` });
  }
  const username = String(d.username || '').trim().slice(0, 64);
  const rawItems = Array.isArray(d.items) ? d.items : [];
  let mmtCount = 0;

  for (const it of rawItems) {
    const itemType = it.item_type === 'abroad' ? 'abroad' : 'mmt';
    if (itemType === 'mmt') {
      if (mmtCount >= 12) continue;
      mmtCount += 1;
    }
    const itemId = String(it.item_id || '').trim();
    const title = String(it.title || '').trim().slice(0, 200);
    const institution = String(it.institution || '').trim().slice(0, 250);
    const priceInfo = String(it.price_info || '').trim().slice(0, 120);
    if (itemId && title && institution) {
      q.upsertSaved.run(tgId, username, itemType, itemId, title, institution, priceInfo);
    }
  }

  const saved = q.getSaved.all(tgId);
  if (saved.length === 0) {
    return sendJson(res, 400, { error: 'Шпаргалка пуста. Сначала добавьте хотя бы 1 позицию.' });
  }

  const mmtRows = saved.filter((r) => r.item_type === 'mmt').slice(0, 12);
  const abroadRows = saved.filter((r) => r.item_type === 'abroad');
  const lines = ['ТВОЯ ШПАРГАЛКА STUDEX:', ''];

  if (mmtRows.length) {
    lines.push(`МОИ КОДЫ ММТ (${mmtRows.length}/12):`);
    mmtRows.forEach((r, idx) => {
      const num = String(idx + 1).padStart(2, '0');
      const info = q.mmtContact.get(r.item_id);
      const code = info?.code ? `Код ${info.code} (ID ${r.item_id})` : `ID ${r.item_id}`;
      const price = info
        ? (info.tuition_type === 'budget' ? 'Бюджет · 0 TJS' : (info.price_tjs ? `${info.price_tjs} TJS/год` : r.price_info))
        : r.price_info;
      lines.push(`${num}. ${code} — ${r.title}`);
      lines.push(`    ${r.institution}${price ? ' · ' + price : ''}`);
      if (info && (info.address || info.phone)) {
        lines.push(`    Приёмная комиссия: ${[info.address, info.phone].filter(Boolean).join(' | ')}`);
      }
    });
    lines.push('');
  }

  if (abroadRows.length) {
    lines.push(`МОИ ЗАРУБЕЖНЫЕ ВУЗЫ (${abroadRows.length}):`);
    abroadRows.forEach((r, idx) => {
      const num = String(idx + 1).padStart(2, '0');
      lines.push(`${num}. ${r.title} (${r.institution})${r.price_info ? ' · ' + r.price_info : ''}`);
    });
    lines.push('');
  }

  lines.push('Команда /saved в боте покажет оба раздела и позволит управлять списком.');

  const sent = await sendTelegramMessage(tgId, lines.join('\n'));
  sendJson(res, 200, { ok: true, count: saved.length, mmtCount: mmtRows.length, abroadCount: abroadRows.length, telegramSent: Boolean(sent) });
}

function generateDraftToken() {
  const rnd = crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, '').toLowerCase();
  return 's_' + rnd.slice(0, 8);
}

async function apiCreateShparLink(req, res) {
  if (limitShpar(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Слишком много запросов (лимит 10 в минуту). Подождите минуту.' });
  }
  let d;
  try { d = JSON.parse(await readBody(req, 60_000)); } catch { return sendJson(res, 400, { error: 'Неверный формат данных.' }); }
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const clean = [];
  let mmtCount = 0;

  for (const it of rawItems) {
    const itemType = it.item_type === 'abroad' ? 'abroad' : 'mmt';
    if (itemType === 'mmt') {
      if (mmtCount >= 12) continue;
      mmtCount += 1;
    }
    const itemId = String(it.item_id || '').trim();
    const title = String(it.title || '').trim().slice(0, 200);
    const institution = String(it.institution || '').trim().slice(0, 250);
    const priceInfo = String(it.price_info || '').trim().slice(0, 120);
    if (itemId && title && institution) {
      clean.push({ item_type: itemType, item_id: itemId, title, institution, price_info: priceInfo });
    }
  }

  if (clean.length === 0) {
    return sendJson(res, 400, { error: 'Шпаргалка пуста. Сначала добавьте хотя бы 1 программу или вуз.' });
  }
  if (!BOT_USERNAME) {
    return sendJson(res, 503, { error: 'Имя Telegram-бота (BOT_USERNAME) не настроено.' });
  }

  let token = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateDraftToken();
    try {
      q.insertDraft.run(candidate, JSON.stringify(clean));
      token = candidate;
      break;
    } catch { /* коллизия — пробуем другой токен */ }
  }
  if (!token) return sendJson(res, 500, { error: 'Не удалось создать ссылку. Попробуйте ещё раз.' });

  const deepLink = `https://t.me/${BOT_USERNAME}?start=${token}`;
  sendJson(res, 201, { ok: true, token, deep_link: deepLink, count: clean.length });
}

// ---------- Защищённая админ-панель /admin/stats ----------
function checkAdminAuth(req, params) {
  if (!ADMIN_PASSWORD) return false;
  if (params.get('key') === ADMIN_PASSWORD) return true;
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const pass = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded;
    if (pass === ADMIN_PASSWORD) return true;
  }
  return false;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function apiAdminStats(req, res, params) {
  if (!checkAdminAuth(req, params)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Studex Admin Stats"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    return res.end('Требуется пароль администратора (ADMIN_PASSWORD).');
  }

  const stats = {
    visits: db.prepare("SELECT COUNT(*) AS n FROM site_events WHERE event_type = 'visit'").get().n,
    uniqueTelegramUsers: db.prepare('SELECT COUNT(DISTINCT telegram_id) AS n FROM user_saved_programs').get().n,
    savedTotal: db.prepare('SELECT COUNT(*) AS n FROM user_saved_programs').get().n,
    topClusters: db.prepare(
      `SELECT value AS cluster, COUNT(*) AS n FROM site_events
        WHERE event_type = 'cluster_search' AND value <> ''
        GROUP BY value ORDER BY n DESC LIMIT 5`
    ).all(),
    topCountries: db.prepare(
      `SELECT value AS country, COUNT(*) AS n FROM site_events
        WHERE event_type = 'country_search' AND value <> ''
        GROUP BY value ORDER BY n DESC LIMIT 10`
    ).all(),
    leadsTotal: db.prepare('SELECT COUNT(*) AS n FROM abroad_leads').get().n,
    leadsNew: db.prepare("SELECT COUNT(*) AS n FROM abroad_leads WHERE status = 'new'").get().n,
    leadsClaimed: db.prepare("SELECT COUNT(*) AS n FROM abroad_leads WHERE status = 'claimed'").get().n,
    byPartner: db.prepare(
      `SELECT claimed_by_username AS partner, COUNT(*) AS n FROM abroad_leads
        WHERE status = 'claimed' AND claimed_by_username <> ''
        GROUP BY claimed_by_username ORDER BY n DESC`
    ).all(),
  };

  if (params.get('format') === 'json' || (req.headers.accept || '').includes('application/json')) {
    return sendJson(res, 200, stats);
  }

  const listRows = (arr, k, empty) => (arr.length
    ? arr.map((r) => `<tr><td>${escHtml(r[k])}</td><td>${r.n}</td></tr>`).join('')
    : `<tr><td colspan="2">${empty}</td></tr>`);

  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Studex · Админ-статистика</title>
<style>
  body{margin:0;padding:24px;background:#0B0B0B;color:#F4F1EA;font-family:Arial,sans-serif}
  .wrap{max-width:900px;margin:0 auto}
  h1,h2{text-transform:uppercase;letter-spacing:.04em}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin:18px 0}
  .card{background:#141414;border:3px solid #F4F1EA;box-shadow:6px 6px 0 #FF5B1F;padding:14px}
  .val{font-size:2rem;font-weight:800;color:#FF5B1F}
  table{width:100%;border-collapse:collapse;margin:10px 0 24px;background:#141414;border:3px solid #F4F1EA}
  th,td{padding:10px 12px;border-bottom:2px solid #2C2B28;text-align:left}
  th{color:#B5B0A4;text-transform:uppercase;font-size:.8rem}
</style></head><body><div class="wrap">
  <h1>Studex · Сводная статистика</h1>
  <div class="grid">
    <div class="card"><div>Заходов на сайт</div><div class="val">${stats.visits}</div></div>
    <div class="card"><div>Telegram-пользователей</div><div class="val">${stats.uniqueTelegramUsers}</div></div>
    <div class="card"><div>Сохранённых программ</div><div class="val">${stats.savedTotal}</div></div>
    <div class="card"><div>Лидов всего</div><div class="val">${stats.leadsTotal}</div></div>
    <div class="card"><div>Лидов в работе</div><div class="val">${stats.leadsClaimed}</div></div>
    <div class="card"><div>Новых лидов</div><div class="val">${stats.leadsNew}</div></div>
  </div>
  <h2>Популярные кластеры ММТ</h2>
  <table><tr><th>Кластер</th><th>Поисков</th></tr>${listRows(stats.topClusters, 'cluster', 'Нет данных')}</table>
  <h2>Популярные страны (За рубежом)</h2>
  <table><tr><th>Страна</th><th>Поисков</th></tr>${listRows(stats.topCountries, 'country', 'Нет данных')}</table>
  <h2>Лиды по партнёрам</h2>
  <table><tr><th>Партнёр</th><th>Забрано лидов</th></tr>${listRows(stats.byPartner, 'partner', 'Пока никто не забрал')}</table>
</div></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

// ---------- Статика ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};
const PUBLIC = path.join(ROOT, 'public');

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- Маршруты ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const corsOk = applyCors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(corsOk ? 204 : 403);
        return res.end();
      }
      if (!corsOk) return sendJson(res, 403, { error: 'Origin не разрешён политикой CORS.' });
    }
    if (req.method === 'GET' && url.pathname === '/api/stats') return apiStats(res, url.searchParams);
    if (req.method === 'GET' && url.pathname === '/api/specialties') return apiSearch(res, url.searchParams);
    if (req.method === 'GET' && (url.pathname === '/api/abroad/search' || url.pathname === '/api/world-institutions')) {
      return apiAbroadSearch(res, url.searchParams);
    }
    if (req.method === 'GET' && url.pathname === '/api/saved') return apiGetSaved(res, url.searchParams);
    if (req.method === 'POST' && url.pathname === '/api/saved') return await apiAddSaved(req, res);
    if (req.method === 'DELETE' && url.pathname === '/api/saved') return apiDeleteSaved(res, url.searchParams);
    if (req.method === 'POST' && url.pathname === '/api/saved/sync-telegram') return await apiSyncSavedTelegram(req, res);
    if (req.method === 'POST' && url.pathname === '/api/shpar/create-link') return await apiCreateShparLink(req, res);
    if (req.method === 'POST' && (url.pathname === '/api/abroad-leads' || url.pathname === '/api/abroad/lead')) return await apiLead(req, res);
    if (req.method === 'GET' && url.pathname === '/admin/stats') return apiAdminStats(req, res, url.searchParams);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Не найдено' });
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, url.pathname);
    res.writeHead(405); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'Ошибка сервера. Попробуйте ещё раз.' });
  }
});

server.listen(PORT, () => {
  console.log(`Навигатор поступления: http://localhost:${PORT}`);
  console.log(`База: ${DB_PATH} (специальностей: ${q.count.get().n})`);
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) console.log('Внимание: BOT_TOKEN / ADMIN_CHAT_ID не заданы — заявки сохраняются без уведомления.');
  resolveBotUsername();
});
