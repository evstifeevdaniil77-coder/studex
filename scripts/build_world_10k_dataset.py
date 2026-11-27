#!/usr/bin/env python3
"""
Загрузка ровно 10 000 реальных университетов и колледжей со всего мира
из официального открытого API OpenAlex (https://api.openalex.org/institutions).

Правило: НИКАКИХ выдуманных данных. Все 10 000 записей приходят из OpenAlex API.
Если в data/ присутствует проверенный файл world_universities_dataset_en_2026-v2.xlsx
(лист Verified_Universities_2026), данные о ценах и IELTS подклеиваются только для
совпавших вузов. Для остальных эти поля остаются пустыми (NULL).

Результат:
  1. data/world_universities_10000_en.csv   (utf-8-sig)
  2. data/world_universities_10000_en.xlsx  (листы World_10k_EN и Summary_by_Country)
  3. Таблица world_institutions в data/navigator.db с индексами по country, institution_type, name.

Запуск:
    python scripts/build_world_10k_dataset.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

try:
    import pandas as pd
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    sys.exit("Нужны pandas и openpyxl. Выполните: pip install -r scripts/requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "db" / "schema.sql"
DEFAULT_DB = ROOT / "data" / "navigator.db"
DEFAULT_CSV = ROOT / "data" / "world_universities_10000_en.csv"
DEFAULT_XLSX = ROOT / "data" / "world_universities_10000_en.xlsx"
VERIFIED_XLSX = ROOT / "data" / "world_universities_dataset_en_2026-v2.xlsx"
VERIFIED_SHEET = "Verified_Universities_2026"

TARGET_COUNT = 10_000
PER_PAGE = 200
OPENALEX_URL = "https://api.openalex.org/institutions"
USER_AGENT = "NavigatorMMT/1.0 (mailto:admin@navigator-mmt.local)"
SELECT_FIELDS = "id,ror,display_name,country_code,geo,homepage_url,works_count,cited_by_count"

COLLEGE_RE = re.compile(r"\b(community\s+college|college|polytechnic)\b", re.IGNORECASE)

VERIFIED_COLUMNS = [
    ("Global Ranking", "global_ranking"),
    ("Instruction Language", "instruction_language"),
    ("Min IELTS", "min_ielts"),
    ("Min TOEFL iBT", "min_toefl_ibt"),
    ("Base Tuition (USD/yr)", "base_tuition_usd"),
    ("Tuition & Entry Details (2026/27)", "tuition_entry_details"),
    ("Scholarships & Grants", "scholarships_grants"),
]

EXPORT_COLUMNS = [
    ("openalex_id", "openalex_id"),
    ("ror_id", "ror_id"),
    ("name", "name"),
    ("institution_type", "institution_type"),
    ("country_code", "country_code"),
    ("country", "country"),
    ("city", "city"),
    ("official_url", "official_url"),
    ("research_works_count", "research_works_count"),
    ("cited_by_count", "cited_by_count"),
    *VERIFIED_COLUMNS,
]

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def clean_str(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    s = unicodedata.normalize("NFC", str(v)).replace("\u00a0", " ").replace("\ufeff", "")
    return re.sub(r"\s+", " ", s).strip()


def nullable_str(v) -> str | None:
    s = clean_str(v)
    return s if s else None


def normalize_name(name: str) -> str:
    s = unicodedata.normalize("NFKD", clean_str(name))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def strip_prefix(url: str | None, prefix: str) -> str | None:
    s = clean_str(url)
    if not s:
        return None
    if s.startswith(prefix):
        return s[len(prefix):].strip("/")
    return s.rstrip("/").rsplit("/", 1)[-1]


def classify_type(name: str) -> str:
    return "College" if COLLEGE_RE.search(name) else "University"


def fetch_page(
    *,
    cursor: str | None = None,
    page: int | None = None,
    sort: str = "works_count:desc",
    api_key: str | None = None,
    retries: int = 5,
    timeout: int = 25,
) -> dict:
    query = {
        "filter": "type:education,country_code:!null",
        "sort": sort,
        "per-page": str(PER_PAGE),
        "select": SELECT_FIELDS,
    }
    if cursor is not None:
        query["cursor"] = cursor
    elif page is not None:
        query["page"] = str(page)
    if api_key:
        query["api_key"] = api_key

    url = f"{OPENALEX_URL}?{urllib.parse.urlencode(query)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})

    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = e
            wait = min(30.0, 1.5 * (2 ** (attempt - 1)))
            if e.code in (429, 500, 502, 503, 504):
                retry_after = e.headers.get("Retry-After")
                if retry_after and retry_after.isdigit():
                    wait = max(wait, float(retry_after))
                print(f"  HTTP {e.code} (попытка {attempt}/{retries}), жду {wait:.1f}с…", flush=True)
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
            last_err = e
            wait = min(30.0, 1.5 * (2 ** (attempt - 1)))
            print(f"  Сетевая ошибка ({e}) (попытка {attempt}/{retries}), жду {wait:.1f}с…", flush=True)
            time.sleep(wait)
    raise SystemExit(f"Не удалось получить страницу OpenAlex (cursor={cursor}, page={page}): {last_err}")


def _append_items(results: list[dict], records: list[dict], seen_ids: set[str], target: int) -> int:
    dropped = 0
    for item in results:
        oid = strip_prefix(item.get("id"), "https://openalex.org/")
        if not oid or oid in seen_ids:
            continue
        name = clean_str(item.get("display_name"))
        geo = item.get("geo") or {}
        country = clean_str(geo.get("country"))
        country_code = clean_str(item.get("country_code") or geo.get("country_code")).upper()
        if not name or not country or not country_code:
            dropped += 1
            continue

        seen_ids.add(oid)
        records.append({
            "openalex_id": oid,
            "ror_id": strip_prefix(item.get("ror"), "https://ror.org/"),
            "name": name,
            "institution_type": classify_type(name),
            "country_code": country_code,
            "country": country,
            "city": clean_str(geo.get("city")),
            "official_url": nullable_str(item.get("homepage_url")),
            "research_works_count": int(item.get("works_count") or 0),
            "cited_by_count": int(item.get("cited_by_count") or 0),
            "global_ranking": None,
            "instruction_language": None,
            "min_ielts": None,
            "min_toefl_ibt": None,
            "base_tuition_usd": None,
            "tuition_entry_details": None,
            "scholarships_grants": None,
        })
        if len(records) >= target:
            break
    return dropped


def fetch_institutions(target: int, api_key: str | None = None) -> list[dict]:
    records: list[dict] = []
    seen_ids: set[str] = set()
    dropped = 0

    use_cursor = bool(api_key)
    mode = "cursor (с API-ключом)" if use_cursor else "page=1..50 (без API-ключа, лимит OpenAlex 10 000)"
    print(f"Загружаю {target} учреждений из OpenAlex API (filter=type:education, sort=works_count:desc, режим: {mode})…", flush=True)

    if use_cursor:
        cursor: str | None = "*"
        page_num = 0
        while len(records) < target and cursor:
            page_num += 1
            data = fetch_page(cursor=cursor, api_key=api_key)
            results = data.get("results") or []
            if not results:
                break
            dropped += _append_items(results, records, seen_ids, target)
            cursor = (data.get("meta") or {}).get("next_cursor")
            if page_num % 10 == 0 or len(records) >= target:
                print(f"  Страница {page_num}: собрано {len(records)} / {target} (отброшено: {dropped})", flush=True)
            if len(records) < target and cursor:
                time.sleep(0.15)
    else:
        max_pages = 50  # OpenAlex без api_key разрешает page=1..50 (50 * 200 = 10 000)
        for page_num in range(1, max_pages + 1):
            if len(records) >= target:
                break
            data = fetch_page(page=page_num)
            results = data.get("results") or []
            if not results:
                break
            dropped += _append_items(results, records, seen_ids, target)
            if page_num % 10 == 0 or len(records) >= target:
                print(f"  Страница {page_num}/{max_pages}: собрано {len(records)} / {target} (отброшено: {dropped})", flush=True)
            if len(records) < target:
                time.sleep(0.15)

        # Если из-за отброшенных записей (без geo.country) не хватило нескольких штук до 10 000,
        # добираем уникальные реальные вузы из OpenAlex по альтернативной сортировке.
        extra_page = 1
        while len(records) < target and extra_page <= 10:
            data = fetch_page(page=extra_page, sort="cited_by_count:desc")
            results = data.get("results") or []
            if not results:
                break
            dropped += _append_items(results, records, seen_ids, target)
            extra_page += 1
            if len(records) < target:
                time.sleep(0.15)
        if extra_page > 1:
            print(f"  Добрано до {len(records)} / {target} по cited_by_count:desc", flush=True)

    if len(records) < target:
        print(f"Внимание: OpenAlex вернул только {len(records)} валидных записей из {target}.")
    return records


def merge_verified(records: list[dict], verified_path: Path) -> int:
    if not verified_path.exists():
        print(f"Файл проверенных данных не найден ({verified_path.name}) — поля цен/IELTS оставлены пустыми (NULL).")
        return 0

    print(f"Подклеиваю проверенные данные из {verified_path.name} (лист {VERIFIED_SHEET})…", flush=True)
    df = pd.read_excel(verified_path, sheet_name=VERIFIED_SHEET, dtype=str)
    df.columns = [clean_str(c) for c in df.columns]

    name_col = next(
        (c for c in df.columns if c.lower() in ("university", "institution", "name", "university name", "official name")),
        df.columns[0],
    )
    lookup: dict[str, dict[str, str | None]] = {}
    for row in df.to_dict("records"):
        key = normalize_name(row.get(name_col))
        if not key:
            continue
        lookup[key] = {
            db_col: nullable_str(row.get(src_col))
            for src_col, db_col in VERIFIED_COLUMNS
            if src_col in df.columns
        }

    matched = 0
    for r in records:
        hit = lookup.get(normalize_name(r["name"]))
        if not hit:
            continue
        for db_col, val in hit.items():
            if val is not None:
                r[db_col] = val
        matched += 1
    print(f"  Сопоставлено с проверенными данными: {matched}")
    return matched


def export_files(records: list[dict], csv_path: Path, xlsx_path: Path) -> None:
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    xlsx_path.parent.mkdir(parents=True, exist_ok=True)

    df = pd.DataFrame([
        {out_col: r[db_col] for out_col, db_col in EXPORT_COLUMNS}
        for r in records
    ])
    df.to_csv(csv_path, index=False, encoding="utf-8-sig")
    print(f"Сохранён CSV: {csv_path}")

    summary = (
        df.groupby(["country", "country_code"], as_index=False)
        .agg(
            Universities=("institution_type", lambda s: int((s == "University").sum())),
            Colleges=("institution_type", lambda s: int((s == "College").sum())),
            Total=("openalex_id", "count"),
        )
        .sort_values(["Total", "country"], ascending=[False, True])
        .rename(columns={"country": "Country", "country_code": "Country Code"})
    )

    widths_main = {
        "openalex_id": 14,
        "ror_id": 14,
        "name": 42,
        "institution_type": 16,
        "country_code": 13,
        "country": 24,
        "city": 22,
        "official_url": 36,
        "research_works_count": 20,
        "cited_by_count": 16,
        "Global Ranking": 16,
        "Instruction Language": 20,
        "Min IELTS": 12,
        "Min TOEFL iBT": 14,
        "Base Tuition (USD/yr)": 20,
        "Tuition & Entry Details (2026/27)": 34,
        "Scholarships & Grants": 30,
    }

    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="World_10k_EN", index=False)
        ws1 = writer.sheets["World_10k_EN"]
        ws1.freeze_panes = "A2"
        ws1.auto_filter.ref = ws1.dimensions
        for i, (col_name, _) in enumerate(EXPORT_COLUMNS, start=1):
            ws1.column_dimensions[get_column_letter(i)].width = widths_main.get(col_name, 18)

        summary.to_excel(writer, sheet_name="Summary_by_Country", index=False)
        ws2 = writer.sheets["Summary_by_Country"]
        ws2.freeze_panes = "A2"
        ws2.auto_filter.ref = ws2.dimensions
        for i, w in enumerate((28, 14, 14, 12, 12), start=1):
            ws2.column_dimensions[get_column_letter(i)].width = w

    print(f"Сохранён Excel: {xlsx_path}")


def write_db(records: list[dict], db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    try:
        con.executescript(SCHEMA.read_text(encoding="utf-8"))
        db_cols = [db_col for _, db_col in EXPORT_COLUMNS]
        placeholders = ", ".join(":" + c for c in db_cols)
        with con:
            con.execute("DELETE FROM world_institutions")
            con.executemany(
                f"INSERT INTO world_institutions ({', '.join(db_cols)}) VALUES ({placeholders})",
                records,
            )
    finally:
        con.close()
    print(f"Загружено в БД: {db_path} (таблица world_institutions)")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Сборка датасета 10 000 вузов мира из OpenAlex API.")
    p.add_argument("--count", type=int, default=TARGET_COUNT, help="Сколько учреждений загрузить (по умолчанию 10000)")
    p.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"База SQLite (по умолчанию {DEFAULT_DB})")
    p.add_argument("--csv", type=Path, default=DEFAULT_CSV, help=f"Путь к CSV (по умолчанию {DEFAULT_CSV})")
    p.add_argument("--xlsx", type=Path, default=DEFAULT_XLSX, help=f"Путь к Excel (по умолчанию {DEFAULT_XLSX})")
    p.add_argument("--verified", type=Path, default=VERIFIED_XLSX, help="Файл с проверенными ценами и IELTS")
    p.add_argument("--api-key", default=os.environ.get("OPENALEX_API_KEY", ""), help="API-ключ OpenAlex (для cursor-пагинации)")
    args = p.parse_args(argv)

    records = fetch_institutions(args.count, api_key=args.api_key or None)
    merge_verified(records, args.verified)
    export_files(records, args.csv, args.xlsx)
    write_db(records, args.db)

    n_total = len(records)
    n_uni = sum(1 for r in records if r["institution_type"] == "University")
    n_col = sum(1 for r in records if r["institution_type"] == "College")
    n_countries = len({r["country"] for r in records})
    n_verified = sum(1 for r in records if r["base_tuition_usd"] is not None or r["min_ielts"] is not None)

    print()
    print("================ ИТОГОВЫЙ ОТЧЁТ ================")
    print(f"Всего строк:                 {n_total}")
    print(f"University:                  {n_uni}")
    print(f"College:                     {n_col}")
    print(f"Уникальных стран:            {n_countries}")
    print(f"С проверенными ценами/IELTS: {n_verified}")
    print("================================================")
    return 0


if __name__ == "__main__":
    sys.exit(main())
