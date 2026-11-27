#!/usr/bin/env python3
"""
Импорт проходных баллов из отчётов ntc.tj / stat.ntc.tj в поле
`specialties.min_score_prev`.

Сами программы (вузы, коды, цены, места) загружаются из официального
датасета скриптом scripts/import_excel.py. Этот скрипт только дописывает
проходные баллы к уже загруженным программам — после этого на сайте
автоматически включается «Светофор» ([ВЫСОКИЙ ШАНС] / [РАБОЧИЙ ВАРИАНТ] / [РИСК]).
Сопоставление: код специальности + вуз + тип оплаты (бюджет / договор).

Поддерживаемые форматы: PDF (через pdfplumber), CSV, XLSX/XLS (через pandas).
Поддерживается таджикская кириллица (қ, ғ, ҳ, ӣ, ӯ, ҷ), включая исправление
«старых» таджикских шрифтов, где буквы заменены на ќ, ѓ, њ, ї, ў, љ.

Установка зависимостей:
    pip install -r scripts/requirements.txt

Примеры:
    # Сначала посмотреть, как распознались колонки, ничего не записывая:
    python scripts/import_ntc.py reports/klaster_1.pdf --cluster 1 --dry-run

    # Дописать баллы из нескольких отчётов:
    python scripts/import_ntc.py reports/klaster_1.pdf reports/klaster_2.pdf

    # Перезаписать ранее загруженные баллы:
    python scripts/import_ntc.py reports/*.pdf --overwrite

    # Если заголовок колонки не распознан автоматически — указать вручную:
    python scripts/import_ntc.py report.csv --map score_budget="Холи ҳадди ақал (ройгон)"

Правило: скрипт НЕ придумывает данные. Строка без кода специальности,
вуза или кластера пропускается и попадает в отчёт о пропущенных строках.
"""

from __future__ import annotations

import argparse
import glob
import re
import sqlite3
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

try:
    import pandas as pd
except ImportError:  # pragma: no cover
    sys.exit("Не установлен pandas. Выполните: pip install -r scripts/requirements.txt")

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = ROOT / "db" / "schema.sql"
DEFAULT_DB = ROOT / "data" / "navigator.db"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

# --------------------------------------------------------------------------
# Нормализация текста (таджикская кириллица)
# --------------------------------------------------------------------------

# Старые таджикские шрифты (Times New Roman Tj и т.п.) и похожие буквы
# других алфавитов → правильные таджикские буквы Unicode.
LEGACY_TJ = str.maketrans({
    "Ќ": "Қ", "ќ": "қ",
    "Ѓ": "Ғ", "ѓ": "ғ",
    "Њ": "Ҳ", "њ": "ҳ",
    "Ї": "Ӣ", "ї": "ӣ",
    "Ў": "Ӯ", "ў": "ӯ",
    "Љ": "Ҷ", "љ": "ҷ",
})
LOOKALIKE_TJ = str.maketrans({
    "Һ": "Ҳ", "һ": "ҳ",   # башкирская/казахская һ
    "Ҡ": "Қ", "ҡ": "қ",   # башкирская ҡ
    "Ӌ": "Ҷ", "ӌ": "ҷ",   # хакасская ӌ
    "Ҝ": "Қ", "ҝ": "қ",
})
# Латинские буквы, внешне совпадающие с кириллическими (ошибки OCR/вёрстки).
LATIN_TO_CYR = str.maketrans({
    "A": "А", "B": "В", "C": "С", "E": "Е", "H": "Н", "K": "К", "M": "М",
    "O": "О", "P": "Р", "T": "Т", "X": "Х", "Y": "У",
    "a": "а", "c": "с", "e": "е", "o": "о", "p": "р", "x": "х", "y": "у",
})
CYR_RE = re.compile(r"[\u0400-\u04FF]")
WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)

FIX_LEGACY = True


def clean_text(value) -> str:
    """Приводит ячейку к аккуратной строке в Unicode NFC."""
    if value is None:
        return ""
    if isinstance(value, float) and pd.isna(value):
        return ""
    s = str(value)
    s = unicodedata.normalize("NFC", s)       # и + ◌̄ → ӣ, у + ◌̄ → ӯ
    s = s.replace("\u00ad", "").replace("\ufeff", "")
    s = s.translate(LOOKALIKE_TJ)
    if FIX_LEGACY:
        s = s.translate(LEGACY_TJ)

    def fix_word(m: re.Match) -> str:
        w = m.group(0)
        return w.translate(LATIN_TO_CYR) if CYR_RE.search(w) else w

    s = WORD_RE.sub(fix_word, s)
    s = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", s)  # перенос слова в PDF
    s = re.sub(r"\s+", " ", s).strip()
    return s


def key_text(s: str) -> str:
    """Строка для сравнения заголовков: нижний регистр, без пунктуации."""
    s = clean_text(s).lower().replace("ё", "е")
    return re.sub(r"[^\w]+", " ", s).strip()


# --------------------------------------------------------------------------
# Распознавание колонок (русские и таджикские заголовки)
# --------------------------------------------------------------------------

FIELDS = [
    "code", "name", "university", "faculty", "cluster", "city", "language",
    "form", "score", "score_budget", "score_contract", "price",
]

BUDGET_WORDS = ("бюджет", "буҷет", "буджет", "ройгон", "грант")
CONTRACT_WORDS = ("договор", "контракт", "шартнома", "пулак", "платн")
SCORE_WORDS = ("балл", "хол", "ҳадди", "минимал", "проходн", "гузар")
PRICE_WORDS = ("цена", "стоимост", "нарх", "маблағ", "пардохт", "сомон", "оплат", "арзиш")


def classify_header(h: str) -> str | None:
    k = key_text(h)
    if not k:
        return None
    has = lambda words: any(w in k for w in words)  # noqa: E731

    if has(PRICE_WORDS):
        return "price"
    if has(("шакли таҳсил", "шакли тахсил", "форма обуч", "форма финанс", "асоси таҳсил", "основа обуч")):
        return "form"
    if has(SCORE_WORDS) or has(BUDGET_WORDS) or has(CONTRACT_WORDS):
        if has(BUDGET_WORDS):
            return "score_budget"
        if has(CONTRACT_WORDS):
            return "score_contract"
        if has(SCORE_WORDS):
            return "score"
    if has(("кластер", "klaster", "cluster")):
        return "cluster"
    if has(("забон", "язык")):
        return "language"
    if has(("шаҳр", "шахр", "город", "минтақа", "населен")):
        return "city"
    if has(("факультет", "факултет")):
        return "faculty"
    if has(("рамз", "шифр", "код")):
        return "code"
    if has(("муассиса", "донишгоҳ", "донишгох", "вуз", "мтмк", "мтоқ", "учрежден", "университет", "институт", "донишкада")):
        return "university"
    if has(("ихтисос", "специальн", "номгӯ", "номгу", "направлен", "название")):
        return "name"
    return None


def map_columns(header: list[str], manual: dict[str, str]) -> dict[str, int]:
    """Возвращает {поле: индекс колонки}."""
    mapping: dict[str, int] = {}
    keys = [key_text(h) for h in header]
    for fld, title in manual.items():
        t = key_text(title)
        for i, k in enumerate(keys):
            if k == t or (t and t in k):
                mapping[fld] = i
                break
    for i, h in enumerate(header):
        if i in mapping.values():
            continue
        fld = classify_header(h)
        if fld and fld not in mapping:
            mapping[fld] = i
    return mapping


def header_score(row: list[str]) -> int:
    """Сколько разных полей распознаётся в строке. У строки с данными (есть
    чисто числовые ячейки — коды, баллы) заголовком она не считается."""
    if any(re.search(r"\d", c) and re.fullmatch(r"[\d\s.,\-–]+", c) for c in row):
        return 0
    return len({classify_header(c) for c in row if classify_header(c)})


# --------------------------------------------------------------------------
# Чтение файлов
# --------------------------------------------------------------------------

def read_pdf(path: Path) -> list[list[list[str]]]:
    try:
        import pdfplumber
    except ImportError:
        sys.exit("Не установлен pdfplumber. Выполните: pip install -r scripts/requirements.txt")
    tables: list[list[list[str]]] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            found = page.extract_tables()
            if not found:
                found = page.extract_tables({"vertical_strategy": "text", "horizontal_strategy": "text"})
            for t in found:
                rows = [[clean_text(c) for c in row] for row in t if row]
                if rows:
                    tables.append(rows)
    return tables


def read_csv(path: Path) -> list[list[list[str]]]:
    last_err = None
    for enc in ("utf-8-sig", "utf-16", "cp1251"):
        try:
            df = pd.read_csv(path, header=None, dtype=str, sep=None, engine="python", encoding=enc)
            break
        except (UnicodeDecodeError, UnicodeError) as e:
            last_err = e
    else:
        raise SystemExit(f"Не удалось прочитать {path}: {last_err}")
    return [df.fillna("").map(clean_text).values.tolist()]


def read_excel(path: Path) -> list[list[list[str]]]:
    sheets = pd.read_excel(path, header=None, dtype=str, sheet_name=None)
    return [df.fillna("").map(clean_text).values.tolist() for df in sheets.values()]


def read_tables(path: Path) -> list[list[list[str]]]:
    ext = path.suffix.lower()
    if ext == ".pdf":
        return read_pdf(path)
    if ext in (".csv", ".txt", ".tsv"):
        return read_csv(path)
    if ext in (".xlsx", ".xls"):
        return read_excel(path)
    raise SystemExit(f"Неподдерживаемый формат файла: {path}")


# --------------------------------------------------------------------------
# Разбор значений
# --------------------------------------------------------------------------

def parse_number(s: str) -> float | None:
    s = clean_text(s)
    if not s or s in {"-", "–", "—", "x", "х", "*"}:
        return None
    s = s.replace("\u00a0", " ")
    m = re.search(r"\d[\d\s]*(?:[.,]\d+)?", s)
    if not m:
        return None
    num = m.group(0).replace(" ", "").replace(",", ".")
    try:
        return float(num)
    except ValueError:
        return None


def parse_cluster(s: str) -> int | None:
    s = clean_text(s)
    m = re.search(r"(?:кластер\w*|klaster|cluster)\s*[№#]?\s*([1-5])\b", s, re.I)
    if m:
        return int(m.group(1))
    m = re.fullmatch(r"\s*([1-5])\s*", s)
    if m:
        return int(m.group(1))
    roman = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5}
    m = re.search(r"\b(I{1,3}|IV|V)\b", s)
    return roman.get(m.group(1)) if m and "класт" in s.lower() else None


def form_kind(s: str) -> str | None:
    k = key_text(s)
    if any(w in k for w in BUDGET_WORDS):
        return "budget"
    if any(w in k for w in CONTRACT_WORDS):
        return "contract"
    return None


def cluster_from_filename(path: Path) -> int | None:
    m = re.search(r"(?:кластер|klaster|cluster)[\s_\-]*([1-5])", path.stem, re.I)
    return int(m.group(1)) if m else None


# --------------------------------------------------------------------------
# Сборка записей
# --------------------------------------------------------------------------

@dataclass
class Context:
    cluster: int | None = None
    city: str = ""
    language: str = ""
    university: str = ""
    source: str = ""


@dataclass
class Stats:
    rows_seen: int = 0
    skipped: dict[str, int] = field(default_factory=dict)

    def skip(self, reason: str) -> None:
        self.skipped[reason] = self.skipped.get(reason, 0) + 1


def extract_records(tables, manual_map, ctx: Context, stats: Stats, verbose: bool) -> list[dict]:
    records: list[dict] = []
    mapping: dict[str, int] | None = None
    width = 0

    for table in tables:
        # Найти строку заголовка в первых строках таблицы (заголовок может быть многострочным).
        header_idx = None
        for i, row in enumerate(table[:6]):
            if header_score(row) >= 3 or (manual_map and len(map_columns(row, manual_map)) >= 3):
                header_idx = i
                break

        if header_idx is not None:
            header = list(table[header_idx])
            # Склеить заголовок из двух строк (например «Холи гузариш» / «ройгон | пулакӣ»).
            if header_idx + 1 < len(table):
                nxt = table[header_idx + 1]
                if nxt and not any(re.search(r"\d{3,}", c) for c in nxt) and any(form_kind(c) for c in nxt):
                    header = [f"{h} {n}".strip() for h, n in zip(header, nxt)]
                    header_idx += 1
            mapping = map_columns(header, manual_map)
            width = len(header)
            body = table[header_idx + 1:]
            if verbose:
                shown = {f: header[i] for f, i in mapping.items()}
                print(f"  Заголовок распознан: {shown}")
        elif mapping is not None and len(table[0]) == width:
            body = table  # продолжение таблицы на следующей странице
        else:
            # Таблица без заголовка — проверяем, нет ли в ней только названия кластера.
            for row in table:
                c = parse_cluster(" ".join(row))
                if c:
                    ctx.cluster = c
            continue

        for row in body:
            row = list(row) + [""] * (width - len(row))
            filled = [c for c in row if c]
            if not filled:
                continue
            joined = " ".join(filled)

            # Строки-разделители: «КЛАСТЕРИ 2», название вуза на всю ширину и т.п.
            if len(filled) == 1:
                c = parse_cluster(joined)
                if c:
                    ctx.cluster = c
                elif "university" not in mapping and not re.search(r"\d", joined):
                    ctx.university = joined
                continue
            if header_score(row) >= 3:  # повтор заголовка на новой странице
                continue

            stats.rows_seen += 1
            get = lambda f: row[mapping[f]] if f in mapping and mapping[f] < len(row) else ""  # noqa: E731

            code = get("code")
            if not re.search(r"\d", code):
                stats.skip("нет кода специальности")
                continue
            code = re.sub(r"\s+", "", code)

            university = get("university") or ctx.university
            if not university:
                stats.skip("нет названия вуза")
                continue

            cluster = parse_cluster(get("cluster")) if "cluster" in mapping else None
            cluster = cluster or ctx.cluster
            if not cluster:
                stats.skip("не определён кластер (укажите --cluster)")
                continue

            budget = parse_number(get("score_budget"))
            contract = parse_number(get("score_contract"))
            generic = parse_number(get("score"))
            if generic is not None:
                kind = form_kind(get("form")) if "form" in mapping else None
                if kind == "contract":
                    contract = contract if contract is not None else generic
                elif kind == "budget" or budget is None:
                    budget = budget if budget is not None else generic

            if budget is None and contract is None:
                stats.skip("нет проходного балла")
                continue

            price = parse_number(get("price"))
            records.append({
                "code": code,
                "name": get("name"),
                "university": university,
                "faculty": get("faculty"),
                "cluster": cluster,
                "city": get("city") or ctx.city,
                "language": get("language") or ctx.language,
                "score_budget": budget,
                "score_contract": contract,
                "price_contract_tjs": int(round(price)) if price is not None else None,
                "source": ctx.source,
            })
    return records


def merge_records(records: list[dict]) -> list[dict]:
    """Объединяет строки одной специальности (бюджет и договор отдельными строками)."""
    merged: dict[tuple, dict] = {}
    for r in records:
        key = (r["code"], r["university"], r["faculty"], r["language"])
        if key not in merged:
            merged[key] = dict(r)
            continue
        m = merged[key]
        for f in ("name", "city", "score_budget", "score_contract", "price_contract_tjs"):
            if m.get(f) in (None, "") and r.get(f) not in (None, ""):
                m[f] = r[f]
    return list(merged.values())


# --------------------------------------------------------------------------
# Запись в базу
# --------------------------------------------------------------------------

def _uni_key(s: str) -> str:
    s = clean_text(s).lower().replace("ё", "е").replace("ӯ", "у").replace("ӣ", "и")
    return re.sub(r"[\W_]+", "", s)


def write_db(db_path: Path, records: list[dict], overwrite: bool) -> tuple[int, int, list[dict]]:
    """Записывает проходные баллы в min_score_prev уже загруженных программ
    (таблица specialties наполняется из официального датасета scripts/import_excel.py).

    Сопоставление: код специальности + вуз (+ тип оплаты budget/contract).
    Новые программы не создаются. Возвращает (обновлено строк, сопоставлено записей, не найдено)."""
    if not db_path.exists():
        sys.exit(f"База не найдена: {db_path}. Сначала выполните scripts/import_excel.py")
    con = sqlite3.connect(db_path)
    try:
        index: dict[tuple[str, str, str], list[int]] = {}
        for combo_id, code, uni, tuition in con.execute(
            "SELECT combo_id, code, university, tuition_type FROM specialties"
        ):
            index.setdefault((re.sub(r"\s+", "", code), _uni_key(uni), tuition), []).append(combo_id)

        updated, matched, not_found = 0, 0, []
        cond = "" if overwrite else " AND min_score_prev IS NULL"
        with con:
            for r in records:
                hit = False
                for tuition, score in (("budget", r["score_budget"]), ("contract", r["score_contract"])):
                    if score is None:
                        continue
                    ids = index.get((r["code"], _uni_key(r["university"]), tuition), [])
                    if ids:
                        hit = True
                    for cid in ids:
                        cur = con.execute(
                            f"UPDATE specialties SET min_score_prev = ? WHERE combo_id = ?{cond}", (score, cid)
                        )
                        updated += cur.rowcount
                if hit:
                    matched += 1
                else:
                    not_found.append(r)
        return updated, matched, not_found
    finally:
        con.close()


# --------------------------------------------------------------------------

def parse_args(argv=None):
    p = argparse.ArgumentParser(
        description="Импорт проходных баллов ММТ из отчётов ntc.tj (PDF/CSV/XLSX) в базу.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("files", nargs="+", help="Файлы отчётов (PDF, CSV, XLSX). Можно маску: reports/*.pdf")
    p.add_argument("--db", type=Path, default=DEFAULT_DB, help=f"Путь к базе SQLite (по умолчанию {DEFAULT_DB})")
    p.add_argument("--cluster", type=int, choices=range(1, 6), help="Кластер, если его нет в таблице и имени файла")
    p.add_argument("--city", default="", help="Город по умолчанию, если колонки нет")
    p.add_argument("--language", default="", help="Язык обучения по умолчанию, если колонки нет")
    p.add_argument("--university", default="", help="Вуз по умолчанию, если колонки нет")
    p.add_argument("--map", action="append", default=[], metavar="ПОЛЕ=Заголовок",
                   help="Ручное соответствие колонки полю. Поля: " + ", ".join(FIELDS))
    p.add_argument("--overwrite", action="store_true", help="Перезаписывать уже заполненные проходные баллы")
    p.add_argument("--dry-run", action="store_true", help="Только показать результат, не записывать в базу")
    p.add_argument("--csv-out", type=Path, help="Сохранить распознанные строки в CSV для проверки")
    p.add_argument("--no-legacy-fix", action="store_true",
                   help="Не заменять ќ ѓ њ ї ў љ на қ ғ ҳ ӣ ӯ ҷ (старые таджикские шрифты)")
    return p.parse_args(argv)


def main(argv=None) -> int:
    global FIX_LEGACY
    args = parse_args(argv)
    FIX_LEGACY = not args.no_legacy_fix

    manual: dict[str, str] = {}
    for item in args.map:
        if "=" not in item:
            sys.exit(f"Неверный --map: {item}. Нужно ПОЛЕ=Заголовок")
        fld, title = item.split("=", 1)
        if fld.strip() not in FIELDS:
            sys.exit(f"Неизвестное поле в --map: {fld}. Допустимо: {', '.join(FIELDS)}")
        manual[fld.strip()] = title.strip()

    paths: list[Path] = []
    for pattern in args.files:
        matched = glob.glob(pattern)
        paths.extend(Path(m) for m in (matched or [pattern]))

    all_records: list[dict] = []
    stats = Stats()
    for path in paths:
        if not path.exists():
            sys.exit(f"Файл не найден: {path}")
        print(f"Читаю {path} …")
        ctx = Context(
            cluster=args.cluster or cluster_from_filename(path),
            city=clean_text(args.city),
            language=clean_text(args.language),
            university=clean_text(args.university),
            source=path.name,
        )
        tables = read_tables(path)
        recs = extract_records(tables, manual, ctx, stats, verbose=True)
        print(f"  Таблиц: {len(tables)}, распознано строк: {len(recs)}")
        all_records.extend(recs)

    records = merge_records(all_records)

    print()
    print(f"Строк с данными: {stats.rows_seen}. Готово к записи: {len(records)}.")
    if stats.skipped:
        print("Пропущено:")
        for reason, n in sorted(stats.skipped.items(), key=lambda x: -x[1]):
            print(f"  {n:>5}  {reason}")

    if records:
        df = pd.DataFrame(records)
        print()
        print("Первые строки:")
        with pd.option_context("display.max_columns", None, "display.width", 200):
            print(df.drop(columns=["source"]).head(10).to_string(index=False))
        if args.csv_out:
            df.to_csv(args.csv_out, index=False, encoding="utf-8-sig")
            print(f"\nCSV для проверки: {args.csv_out}")

    if not records:
        print("\nНичего не импортировано. Проверьте заголовки таблицы и при необходимости используйте --map и --cluster.")
        return 1
    if args.dry_run:
        print("\nРежим --dry-run: база не изменена.")
        return 0

    updated, matched, not_found = write_db(args.db, records, args.overwrite)
    print(f"\nБаза {args.db}: сопоставлено записей отчёта {matched} из {len(records)}, "
          f"обновлено программ (min_score_prev): {updated}.")
    if not_found:
        print(f"Не найдено в базе ({len(not_found)}), первые 15:")
        for r in not_found[:15]:
            print(f"  {r['code']}  {r['university']}")
    if not args.overwrite:
        print("Уже заполненные баллы не перезаписывались (используйте --overwrite).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
