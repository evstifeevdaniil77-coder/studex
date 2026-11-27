#!/usr/bin/env python3
"""
Импорт официального датасета НТЦ (data/dataset_mmt_2026.xlsx) в базу проекта.

Листы:
  «Специальности_2026» -> таблица specialties   (старые записи полностью удаляются)
  «Контакты_вузов»     -> таблица institutions  (адрес и телефон приёмной комиссии)
  «Сводка»             -> таблица clusters      (названия кластеров; лист необязателен)

Скрипт ничего не придумывает: пустые ячейки остаются пустыми (NULL),
строки с ошибками не исправляются наугад, а выводятся в отчёте.

Лист «Контакты_вузов» получен из PDF, поэтому скрипт чинит типичные
артефакты вёрстки: оторванную букву «ш»/«н» от слов «шаҳри»/«ноҳияи»,
куски названия региона, попавшие в название и адрес, лишние скобки в телефонах.
Название учреждения сопоставляется с названием вуза в листе специальностей,
чтобы в карточке специальности показывались контакты именно этого вуза.

Запуск:
    pip install -r scripts/requirements.txt
    python scripts/import_excel.py
    python scripts/import_excel.py путь/к/файлу.xlsx --db data/navigator.db
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

try:
    import pandas as pd
except ImportError:  # pragma: no cover
    sys.exit("Не установлен pandas. Выполните: pip install -r scripts/requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "db" / "schema.sql"
DEFAULT_XLSX = ROOT / "data" / "dataset_mmt_2026.xlsx"
DEFAULT_DB = ROOT / "data" / "navigator.db"

SHEET_SPEC = "Специальности_2026"
SHEET_CONTACTS = "Контакты_вузов"
SHEET_SUMMARY = "Сводка"

SPEC_COLUMNS = [
    "combo_id", "level", "cluster", "code", "specialty", "university", "city",
    "study_form", "tuition_type", "price_tjs", "language", "vacant_seats", "min_score_prev",
]
CONTACT_COLUMNS = {  # заголовок в Excel -> колонка в базе
    "Тип": "type",
    "Регион": "region",
    "Название учреждения": "name",
    "Адрес": "address",
    "Телефон": "phone",
}

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


# --------------------------------------------------------------------------
# Общие функции
# --------------------------------------------------------------------------

def text(v) -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return ""
    s = unicodedata.normalize("NFC", str(v)).replace("\u00a0", " ").replace("\ufeff", "")
    return re.sub(r"\s+", " ", s).strip()


def to_int(v) -> int | None:
    s = text(v).replace(" ", "").replace(",", ".")
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        raise ValueError(f"не число: {v!r}")
    if f != int(f):
        raise ValueError(f"не целое число: {v!r}")
    return int(f)


def to_float(v) -> float | None:
    s = text(v).replace(" ", "").replace(",", ".")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        raise ValueError(f"не число: {v!r}")


def match_key(s: str) -> str:
    """Ключ для сопоставления названий: без регистра, пробелов, знаков,
    с унификацией ӯ/у и ӣ/и (в источниках встречается «Абуабдуллоҳи» и «Абӯабдуллоҳи»)."""
    s = text(s).lower().replace("ё", "е").replace("ӯ", "у").replace("ӣ", "и")
    return re.sub(r"[\W_]+", "", s)


# --------------------------------------------------------------------------
# Лист «Специальности_2026»
# --------------------------------------------------------------------------

def load_specialties(xlsx: Path) -> tuple[list[dict], list[str]]:
    df = pd.read_excel(xlsx, sheet_name=SHEET_SPEC, dtype=str)
    df.columns = [text(c) for c in df.columns]
    missing = [c for c in SPEC_COLUMNS if c not in df.columns]
    if missing:
        sys.exit(f"В листе «{SHEET_SPEC}» нет колонок: {', '.join(missing)}")

    records, errors = [], []
    seen_ids: set[int] = set()
    for i, row in enumerate(df.itertuples(index=False), start=2):  # 2 = номер строки в Excel
        r = row._asdict()
        try:
            rec = {
                "combo_id": to_int(r["combo_id"]),
                "level": text(r["level"]),
                "cluster": to_int(r["cluster"]),
                "code": text(r["code"]),
                "specialty": text(r["specialty"]),
                "university": text(r["university"]),
                "city": text(r["city"]),
                "study_form": text(r["study_form"]),
                "tuition_type": text(r["tuition_type"]).lower(),
                "price_tjs": to_int(r["price_tjs"]),
                "language": text(r["language"]),
                "vacant_seats": to_int(r["vacant_seats"]),
                "min_score_prev": to_float(r["min_score_prev"]),
            }
            if rec["combo_id"] is None:
                raise ValueError("пустой combo_id")
            if rec["combo_id"] in seen_ids:
                raise ValueError(f"повтор combo_id {rec['combo_id']}")
            if rec["level"] not in ("ВУЗ", "Колледж"):
                raise ValueError(f"неизвестный уровень {rec['level']!r}")
            if rec["cluster"] not in (1, 2, 3, 4, 5):
                raise ValueError(f"кластер вне 1–5: {rec['cluster']!r}")
            if rec["tuition_type"] not in ("budget", "contract"):
                raise ValueError(f"неизвестный тип оплаты {rec['tuition_type']!r}")
            for f in ("code", "specialty", "university"):
                if not rec[f]:
                    raise ValueError(f"пустое поле {f}")
        except ValueError as e:
            errors.append(f"строка {i}: {e}")
            continue
        seen_ids.add(rec["combo_id"])
        records.append(rec)
    return records, errors


# --------------------------------------------------------------------------
# Лист «Контакты_вузов»
# --------------------------------------------------------------------------

def fix_region_leak(name: str, address: str, regions: list[str]) -> tuple[str, str]:
    """Название следующего региона разорвано между колонками:
    «… Осиёи Марказӣ ш Вил» + «… 155 ояти Суғд»  ->  убрать «Вил» и «ояти Суғд»."""
    for region in regions:
        for k in range(2, len(region) - 1):
            pre, suf = region[:k], region[k:]
            if name.endswith(" " + pre) and address.endswith(" " + suf):
                return name[: -len(pre) - 1].rstrip(), address[: -len(suf) - 1].rstrip()
    return name, address


def fix_split_letter(name: str, address: str) -> tuple[str, str]:
    """Первая буква адреса оказалась в названии: «… Назаршоев ш» + «аҳри Хоруғ» -> «шаҳри Хоруғ»."""
    for letter, rest in (("ш", "аҳри"), ("н", "оҳияи")):
        if address.startswith(rest):
            m = re.search(rf"(?:^|\s){letter}(?=\s|$)", name)
            if m:
                name = (name[: m.start()] + name[m.end():]).strip()
                name = re.sub(r"\s+", " ", name)
                address = letter + address
            break
    return name, address


def clean_phone(phone: str) -> str:
    p = re.sub(r"(?i)^телефон\s*", "", phone)
    p = re.sub(r",\s*\)\s*", ", ", p)                    # «…-45, ) (44)…»
    p = re.sub(r"(\d)\s+(?=\(\d)", r"\1, ", p)            # два номера без запятой
    p = re.sub(r"\)\s*-\s*", ") ", p)                     # «(3422)-5-36-99»
    p = re.sub(r"\)(?=\d)", ") ", p)
    return re.sub(r"\s+", " ", p).strip(" ,")


def load_contacts(xlsx: Path) -> list[dict]:
    df = pd.read_excel(xlsx, sheet_name=SHEET_CONTACTS, dtype=str)
    df.columns = [text(c) for c in df.columns]
    missing = [c for c in CONTACT_COLUMNS if c not in df.columns]
    if missing:
        sys.exit(f"В листе «{SHEET_CONTACTS}» нет колонок: {', '.join(missing)}")
    df = df.rename(columns=CONTACT_COLUMNS)
    regions = sorted({text(r) for r in df["region"] if text(r)}, key=len, reverse=True)

    out = []
    for r in df.to_dict("records"):
        c = {k: text(r[k]) for k in CONTACT_COLUMNS.values()}
        if not c["name"]:
            continue
        c["raw_name"] = c["name"]
        c["name"], c["address"] = fix_region_leak(c["name"], c["address"], regions)
        c["name"], c["address"] = fix_split_letter(c["name"], c["address"])
        if c["address"].count("(") > c["address"].count(")"):
            c["address"] += ")"
        c["phone"] = clean_phone(c["phone"])
        out.append(c)
    return out


def match_contacts(contacts: list[dict], specialties: list[dict]) -> tuple[int, list[str]]:
    """Подставляет в contacts['name'] точное название вуза из листа специальностей.
    Возвращает (число сопоставленных вузов, список вузов без контактов)."""
    unis: dict[tuple[str, str], str] = {}
    for s in specialties:
        unis[(s["level"], s["university"])] = s["university"]

    uni_keys = {u: match_key(u) for (_, u) in unis}
    uni_level = {u: lvl for (lvl, u) in unis}
    matched_uni: set[str] = set()
    used_contact: set[int] = set()

    # 1) точное совпадение ключа
    for i, c in enumerate(contacts):
        ck = match_key(c["name"])
        for u, uk in uni_keys.items():
            if u not in matched_uni and uk == ck and uni_level[u] == c["type"]:
                c["name"] = u
                matched_uni.add(u)
                used_contact.add(i)
                break

    # 2) одно название — начало другого (в PDF к названию приклеился хвост
    #    соседней строки или, наоборот, обрезано окончание)
    for i, c in enumerate(contacts):
        if i in used_contact:
            continue
        ck = match_key(c["name"])
        candidates = [
            u for u, uk in uni_keys.items()
            if u not in matched_uni and uni_level[u] == c["type"]
            and min(len(uk), len(ck)) >= 20 and (ck.startswith(uk) or uk.startswith(ck))
        ]
        if len(candidates) == 1:
            c["name"] = candidates[0]
            matched_uni.add(candidates[0])
            used_contact.add(i)

    without = sorted(u for u in uni_keys if u not in matched_uni)
    return len(matched_uni), without


# --------------------------------------------------------------------------
# Лист «Сводка» (названия кластеров)
# --------------------------------------------------------------------------

def load_cluster_names(xlsx: Path) -> dict[int, str]:
    try:
        df = pd.read_excel(xlsx, sheet_name=SHEET_SUMMARY, header=None, dtype=str)
    except ValueError:
        return {}
    names: dict[int, str] = {}
    for row in df.itertuples(index=False):
        if len(row) < 2:
            continue
        first, second = text(row[0]), text(row[1])
        if re.fullmatch(r"[1-5]", first) and second:
            names.setdefault(int(first), second)
    return names


# --------------------------------------------------------------------------
# Запись в базу
# --------------------------------------------------------------------------

def write_db(db_path: Path, specialties, contacts, cluster_names) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    with con:
        # Полная очистка: пересоздаём таблицы справочников по актуальной схеме.
        # Таблица заявок abroad_leads не затрагивается.
        con.execute("DROP TABLE IF EXISTS specialties")
        con.execute("DROP TABLE IF EXISTS institutions")
        con.execute("DROP TABLE IF EXISTS clusters")
    con.executescript(SCHEMA.read_text(encoding="utf-8"))
    with con:
        con.executemany(
            f"INSERT INTO specialties ({', '.join(SPEC_COLUMNS)}) "
            f"VALUES ({', '.join(':' + c for c in SPEC_COLUMNS)})",
            specialties,
        )
        seen = set()
        for c in contacts:
            if c["name"] in seen:
                print(f"  Внимание: повтор учреждения в контактах, пропущен: {c['raw_name']}")
                continue
            seen.add(c["name"])
            con.execute(
                "INSERT INTO institutions (type, region, name, address, phone) VALUES (?, ?, ?, ?, ?)",
                (c["type"], c["region"], c["name"], c["address"], c["phone"]),
            )
        con.executemany("INSERT INTO clusters (id, name) VALUES (?, ?)", sorted(cluster_names.items()))
    return con


def print_report(con: sqlite3.Connection) -> None:
    print()
    print("Проверка базы: записи по кластерам")
    df = pd.read_sql_query(
        """
        SELECT s.cluster                                         AS "Кластер",
               COALESCE(c.name, '')                              AS "Название",
               SUM(s.level = 'ВУЗ')                              AS "ВУЗ",
               SUM(s.level = 'Колледж')                          AS "Колледж",
               SUM(s.tuition_type = 'budget')                    AS "Бюджет",
               SUM(s.tuition_type = 'contract')                  AS "Контракт",
               SUM(COALESCE(s.vacant_seats, 0))                  AS "Мест",
               SUM(s.min_score_prev IS NOT NULL)                 AS "С баллом",
               COUNT(*)                                          AS "Всего"
          FROM specialties s LEFT JOIN clusters c ON c.id = s.cluster
         GROUP BY s.cluster ORDER BY s.cluster
        """,
        con,
    )
    total = df[["ВУЗ", "Колледж", "Бюджет", "Контракт", "Мест", "С баллом", "Всего"]].sum()
    df = df.astype(object)
    df.loc[len(df)] = ["ИТОГО", "", *total.tolist()]
    with pd.option_context("display.width", 200, "display.max_colwidth", 40):
        print(df.to_string(index=False))

    n_spec = con.execute("SELECT COUNT(*) FROM specialties").fetchone()[0]
    n_inst = con.execute("SELECT COUNT(*) FROM institutions").fetchone()[0]
    n_with = con.execute(
        "SELECT COUNT(*) FROM specialties s WHERE EXISTS (SELECT 1 FROM institutions i WHERE i.name = s.university)"
    ).fetchone()[0]
    print()
    print(f"Специальностей в базе: {n_spec}")
    print(f"Учреждений с контактами: {n_inst}")
    print(f"Специальностей, у которых есть контакты приёмной комиссии: {n_with} из {n_spec}")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Импорт датасета НТЦ (Excel) в базу «Навигатора поступления».")
    p.add_argument("xlsx", nargs="?", type=Path, default=DEFAULT_XLSX, help=f"Файл Excel (по умолчанию {DEFAULT_XLSX})")
    p.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"База SQLite (по умолчанию {DEFAULT_DB})")
    args = p.parse_args(argv)

    if not args.xlsx.exists():
        sys.exit(f"Файл не найден: {args.xlsx}")

    print(f"Читаю {args.xlsx} …")
    specialties, errors = load_specialties(args.xlsx)
    print(f"  «{SHEET_SPEC}»: корректных строк {len(specialties)}, с ошибками {len(errors)}")
    for e in errors[:20]:
        print("    " + e)
    if len(errors) > 20:
        print(f"    … и ещё {len(errors) - 20}")
    if not specialties:
        print("Нет корректных строк — база не изменена.")
        return 1

    contacts = load_contacts(args.xlsx)
    matched, without = match_contacts(contacts, specialties)
    n_unis = matched + len(without)
    print(f"  «{SHEET_CONTACTS}»: учреждений {len(contacts)}; сопоставлено с вузами из специальностей: {matched} из {n_unis}")
    if without:
        print("    Нет контактов в отчёте для:")
        for u in without:
            print(f"      - {u}")

    cluster_names = load_cluster_names(args.xlsx)
    print(f"  «{SHEET_SUMMARY}»: названий кластеров {len(cluster_names)}")

    con = write_db(args.db, specialties, contacts, cluster_names)
    try:
        print(f"\nЗаписано в {args.db}")
        print_report(con)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
