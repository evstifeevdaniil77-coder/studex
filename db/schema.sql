-- Навигатор поступления: структура базы данных (SQLite).
-- Данные загружаются только из официального датасета НТЦ
-- (scripts/import_excel.py) и отчётов ntc.tj (scripts/import_ntc.py).

-- Программы приёма (лист «Специальности_2026»).
-- Одна строка = одна программа с одним типом оплаты (budget / contract).
CREATE TABLE IF NOT EXISTS specialties (
    combo_id       INTEGER PRIMARY KEY,                          -- ID программы в датасете НТЦ
    level          TEXT    NOT NULL CHECK (level IN ('ВУЗ', 'Колледж')),
    cluster        INTEGER NOT NULL CHECK (cluster BETWEEN 1 AND 5),
    code           TEXT    NOT NULL,                             -- код специальности
    specialty      TEXT    NOT NULL,                             -- название специальности
    university     TEXT    NOT NULL,                             -- вуз / колледж
    city           TEXT    NOT NULL DEFAULT '',
    study_form     TEXT    NOT NULL DEFAULT '',                  -- фосилавӣ / ғоибона
    tuition_type   TEXT    NOT NULL CHECK (tuition_type IN ('budget', 'contract')),
    price_tjs      INTEGER,                                      -- цена в год, сомони (для контракта)
    language       TEXT    NOT NULL DEFAULT '',                  -- язык обучения
    vacant_seats   INTEGER,                                      -- свободные места
    min_score_prev REAL                                          -- проходной балл прошлого года; NULL = не опубликован
);
CREATE INDEX IF NOT EXISTS ix_specialties_cluster ON specialties (cluster);
CREATE INDEX IF NOT EXISTS ix_specialties_university ON specialties (university);

-- Контакты приёмных комиссий (лист «Контакты_вузов»).
CREATE TABLE IF NOT EXISTS institutions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    type    TEXT NOT NULL,                                       -- ВУЗ / Колледж
    region  TEXT NOT NULL DEFAULT '',
    name    TEXT NOT NULL UNIQUE,                                -- совпадает с specialties.university
    address TEXT NOT NULL DEFAULT '',
    phone   TEXT NOT NULL DEFAULT ''
);

-- Названия кластеров (лист «Сводка»).
CREATE TABLE IF NOT EXISTS clusters (
    id   INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 5),
    name TEXT NOT NULL
);

-- Международные вузы и колледжи (10 000 записей из OpenAlex API + опционально проверенные данные).
CREATE TABLE IF NOT EXISTS world_institutions (
    openalex_id           TEXT    PRIMARY KEY,
    ror_id                TEXT,
    name                  TEXT    NOT NULL,
    institution_type      TEXT    NOT NULL CHECK (institution_type IN ('University', 'College')),
    country_code          TEXT    NOT NULL,
    country               TEXT    NOT NULL,
    city                  TEXT    NOT NULL DEFAULT '',
    official_url          TEXT,
    research_works_count  INTEGER NOT NULL DEFAULT 0,
    cited_by_count        INTEGER NOT NULL DEFAULT 0,
    global_ranking        TEXT,
    instruction_language  TEXT,
    min_ielts             TEXT,
    min_toefl_ibt         TEXT,
    base_tuition_usd      TEXT,
    tuition_entry_details TEXT,
    scholarships_grants   TEXT
);
CREATE INDEX IF NOT EXISTS ix_world_country ON world_institutions (country);
CREATE INDEX IF NOT EXISTS ix_world_type ON world_institutions (institution_type);
CREATE INDEX IF NOT EXISTS ix_world_name ON world_institutions (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS ix_world_works ON world_institutions (research_works_count DESC);

CREATE TABLE IF NOT EXISTS abroad_leads (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    certificate         TEXT    NOT NULL CHECK (certificate IN ('IELTS', 'TOEFL', 'NONE')),
    certificate_score   REAL,
    gpa                 REAL    NOT NULL,
    region              TEXT    NOT NULL,
    budget_usd          INTEGER NOT NULL,
    name                TEXT    NOT NULL,
    phone               TEXT    NOT NULL,
    messenger           TEXT    NOT NULL CHECK (messenger IN ('Telegram', 'WhatsApp')),
    target_university   TEXT    NOT NULL DEFAULT '',
    status              TEXT    NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'claimed')),
    claimed_by_id       INTEGER,
    claimed_by_username TEXT    NOT NULL DEFAULT '',
    claimed_at          TEXT,
    partner_message_id  INTEGER,
    telegram_sent       INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Сохранённые пользователем программы (синхронизация Mini App <-> Telegram-бот).
CREATE TABLE IF NOT EXISTS user_saved_programs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    username    TEXT    NOT NULL DEFAULT '',
    item_type   TEXT    NOT NULL CHECK (item_type IN ('mmt', 'abroad')),
    item_id     TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    institution TEXT    NOT NULL,
    price_info  TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (telegram_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS ix_saved_tg ON user_saved_programs (telegram_id);

-- Сводная аналитика для /admin/stats (без персональных данных).
CREATE TABLE IF NOT EXISTS site_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT    NOT NULL,
    value       TEXT    NOT NULL DEFAULT '',
    telegram_id INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_events_type ON site_events (event_type);

-- Временные черновики шпаргалки для передачи из браузера в Telegram-бот (?start=s_<token>).
CREATE TABLE IF NOT EXISTS shpar_drafts (
    token                  TEXT PRIMARY KEY,
    items_json             TEXT NOT NULL,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_by_telegram_id INTEGER
);
