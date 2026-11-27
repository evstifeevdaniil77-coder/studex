#!/usr/bin/env python3
"""
Studex — Telegram-бот на aiogram 3 (Mini App + личный кабинет /saved + партнёрские лиды).

Общая база данных SQLite с веб-сервером (data/navigator.db):
  - user_saved_programs : сохранённые программы ММТ и зарубежные вузы пользователя
  - specialties + institutions : контакты приёмных комиссий для экспорта шпаргалки
  - abroad_leads : заявки с атомарным закреплением за партнёром («Забрать лид в работу»)

Переменные окружения (.env):
  BOT_TOKEN          — токен от @BotFather
  WEBAPP_URL         — публичный HTTPS-адрес Studex
  ADMIN_CHAT_ID      — ID администратора
  PARTNER_CHANNEL_ID — ID закрытого партнёрского канала/группы для лидов
  DB_PATH            — путь к SQLite (по умолчанию data/navigator.db)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import sys
from pathlib import Path

from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    BotCommand,
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    WebAppInfo,
)

ROOT = Path(__file__).resolve().parent.parent


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


load_env(ROOT / ".env")

BOT_TOKEN = (os.getenv("BOT_TOKEN") or "").strip()
WEBAPP_URL = (os.getenv("WEBAPP_URL") or "https://studex-4myq.onrender.com").strip()
ADMIN_CHAT_ID = (os.getenv("ADMIN_CHAT_ID") or "").strip()
PARTNER_CHANNEL_ID = (os.getenv("PARTNER_CHANNEL_ID") or "").strip()
DB_PATH = (ROOT / (os.getenv("DB_PATH") or "data/navigator.db")).resolve()

START_TEXT = (
    "Studex — твой навигатор поступления. "
    "Подбери 12 специальностей ММТ или найди вуз за границей за 1 минуту."
)
SHARE_QUERY = (
    "Studex — навигатор поступления! "
    "Подбери 12 специальностей ММТ или найди вуз за границей за 1 минуту."
)

dp = Dispatcher()


def db_connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def build_start_keyboard() -> InlineKeyboardMarkup:
    rows: list[list[InlineKeyboardButton]] = []
    if WEBAPP_URL.startswith("https://"):
        rows.append([
            InlineKeyboardButton(
                text="Открыть Studex",
                web_app=WebAppInfo(url=WEBAPP_URL),
            )
        ])
    rows.append([
        InlineKeyboardButton(text="Мои сохраненные вузы", callback_data="open_saved")
    ])
    rows.append([
        InlineKeyboardButton(
            text="Поделиться с одноклассниками",
            switch_inline_query=SHARE_QUERY,
        )
    ])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def fetch_saved(telegram_id: int) -> list[sqlite3.Row]:
    with db_connect() as con:
        return con.execute(
            """
            SELECT id, item_type, item_id, title, institution, price_info, created_at
              FROM user_saved_programs
             WHERE telegram_id = ?
             ORDER BY CASE item_type WHEN 'mmt' THEN 0 ELSE 1 END, id ASC
            """,
            (telegram_id,),
        ).fetchall()


def render_saved_view(telegram_id: int) -> tuple[str, InlineKeyboardMarkup]:
    rows = fetch_saved(telegram_id)
    if not rows:
        kb_rows: list[list[InlineKeyboardButton]] = []
        if WEBAPP_URL.startswith("https://"):
            kb_rows.append([InlineKeyboardButton(text="Открыть Studex", web_app=WebAppInfo(url=WEBAPP_URL))])
        return (
            "У тебя пока нет сохранённых программ.\n"
            "Открой Studex, выбери специальности ММТ или зарубежные вузы и нажми «+ В шпаргалку».",
            InlineKeyboardMarkup(inline_keyboard=kb_rows),
        )

    mmt_rows = [r for r in rows if r["item_type"] == "mmt"]
    abroad_rows = [r for r in rows if r["item_type"] == "abroad"]

    lines: list[str] = []
    del_buttons: list[InlineKeyboardButton] = []
    idx = 0

    lines.append(f"МОИ КОДЫ ММТ ({len(mmt_rows)}/12):")
    if mmt_rows:
        for r in mmt_rows:
            idx += 1
            price = f" · {r['price_info']}" if r["price_info"] else ""
            lines.append(f"{idx:02d}. {r['title']} — {r['institution']} (ID {r['item_id']}{price})")
            del_buttons.append(
                InlineKeyboardButton(text=f"✕ #{idx:02d}", callback_data=f"del_saved:{r['id']}")
            )
    else:
        lines.append("— пока пусто")

    lines.append("")
    lines.append(f"МОИ ЗАРУБЕЖНЫЕ ВУЗЫ ({len(abroad_rows)}):")
    if abroad_rows:
        for r in abroad_rows:
            idx += 1
            price = f" · {r['price_info']}" if r["price_info"] else ""
            lines.append(f"{idx:02d}. {r['title']} ({r['institution']}{price})")
            del_buttons.append(
                InlineKeyboardButton(text=f"✕ #{idx:02d}", callback_data=f"del_saved:{r['id']}")
            )
    else:
        lines.append("— пока пусто")

    kb_rows = []
    for i in range(0, len(del_buttons), 4):
        kb_rows.append(del_buttons[i : i + 4])
    if mmt_rows:
        kb_rows.append([
            InlineKeyboardButton(text="Экспорт шпаргалки ММТ (до 12 кодов)", callback_data="export_mmt")
        ])
    if WEBAPP_URL.startswith("https://"):
        kb_rows.append([
            InlineKeyboardButton(text="Открыть Studex", web_app=WebAppInfo(url=WEBAPP_URL))
        ])

    return "\n".join(lines), InlineKeyboardMarkup(inline_keyboard=kb_rows)


def build_mmt_export_text(telegram_id: int) -> str:
    with db_connect() as con:
        rows = con.execute(
            """
            SELECT u.item_id, u.title, u.institution, u.price_info,
                   s.code, s.cluster, s.tuition_type, s.price_tjs, s.study_form,
                   i.address, i.phone
              FROM user_saved_programs u
              LEFT JOIN specialties s ON CAST(s.combo_id AS TEXT) = u.item_id
              LEFT JOIN institutions i ON i.name = COALESCE(s.university, u.institution)
             WHERE u.telegram_id = ? AND u.item_type = 'mmt'
             ORDER BY u.id ASC
             LIMIT 12
            """,
            (telegram_id,),
        ).fetchall()

    if not rows:
        return "В твоём списке пока нет программ ММТ для экспорта."

    lines = [f"ШПАРГАЛКА ДЛЯ БЛАНКА ММТ ({len(rows)}/12):", ""]
    for idx, r in enumerate(rows, start=1):
        code = r["code"] or r["item_id"]
        cluster = f" · Кл.{r['cluster']}" if r["cluster"] else ""
        if r["tuition_type"] == "budget":
            price = "Бюджет (0 TJS)"
        elif r["price_tjs"]:
            price = f"{r['price_tjs']} TJS/год"
        else:
            price = r["price_info"] or "цена не указана"
        lines.append(f"{idx:02d}. Код {code} (ID {r['item_id']}{cluster}) — {r['title']}")
        lines.append(f"    Вуз: {r['institution']} | {price}")
        if r["address"] or r["phone"]:
            contact = " | ".join(p for p in (r["address"], r["phone"]) if p)
            lines.append(f"    Приёмная комиссия: {contact}")
    return "\n".join(lines)


def claim_draft(token: str, telegram_id: int, username: str) -> tuple[str, list[dict]]:
    """Переносит черновик из shpar_drafts в user_saved_programs и помечает использованным.
    Возвращает (статус: 'ok'|'already_mine'|'already_other'|'not_found', перенесённые элементы)."""
    with db_connect() as con:
        draft = con.execute(
            "SELECT token, items_json, claimed_by_telegram_id FROM shpar_drafts WHERE token = ?",
            (token,),
        ).fetchone()
        if not draft:
            return "not_found", []
        owner = draft["claimed_by_telegram_id"]
        if owner is not None and owner != telegram_id:
            return "already_other", []

        try:
            items = json.loads(draft["items_json"])
        except json.JSONDecodeError:
            items = []

        if owner is None:
            for it in items:
                item_type = "abroad" if it.get("item_type") == "abroad" else "mmt"
                item_id = str(it.get("item_id") or "").strip()
                title = str(it.get("title") or "").strip()[:200]
                institution = str(it.get("institution") or "").strip()[:250]
                price_info = str(it.get("price_info") or "").strip()[:120]
                if not (item_id and title and institution):
                    continue
                con.execute(
                    """
                    INSERT INTO user_saved_programs
                        (telegram_id, username, item_type, item_id, title, institution, price_info)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (telegram_id, item_type, item_id) DO UPDATE SET
                        username = excluded.username,
                        title = excluded.title,
                        institution = excluded.institution,
                        price_info = excluded.price_info
                    """,
                    (telegram_id, username, item_type, item_id, title, institution, price_info),
                )
            con.execute(
                "UPDATE shpar_drafts SET claimed_by_telegram_id = ? WHERE token = ?",
                (telegram_id, token),
            )
            return "ok", items
        return "already_mine", items


# ---------- Команды пользователя ----------

@dp.message(CommandStart())
async def on_start(message: Message, command: CommandObject) -> None:
    arg = (command.args or "").strip()
    user = message.from_user

    if arg.startswith("s_") and user:
        status, _ = claim_draft(arg, user.id, user.username or "")
        if status == "not_found":
            await message.answer(
                "Ссылка на шпаргалку не найдена или устарела. Открой Studex и нажми «Сохранить в бот» ещё раз.",
                reply_markup=build_start_keyboard(),
            )
            return
        if status == "already_other":
            await message.answer(
                "Эта ссылка уже была использована другим аккаунтом. Создай новую в Studex.",
                reply_markup=build_start_keyboard(),
            )
            return

        saved_text, _ = render_saved_view(user.id)
        header = (
            "Шпаргалка сохранена в твоём Telegram!\n\n"
            if status == "ok"
            else "Эта шпаргалка уже сохранена в твоём списке:\n\n"
        )
        kb_rows = [
            [InlineKeyboardButton(text="Мои сохраненные вузы", callback_data="open_saved")],
            [InlineKeyboardButton(text="Экспорт шпаргалки ММТ (до 12 кодов)", callback_data="export_mmt")],
        ]
        if WEBAPP_URL.startswith("https://"):
            kb_rows.append([InlineKeyboardButton(text="Открыть Studex", web_app=WebAppInfo(url=WEBAPP_URL))])
        await message.answer(header + saved_text, reply_markup=InlineKeyboardMarkup(inline_keyboard=kb_rows))
        return

    if arg.lower() == "saved" and user:
        text, kb = render_saved_view(user.id)
        await message.answer(text, reply_markup=kb)
        return

    text = START_TEXT
    if user:
        saved_count = len(fetch_saved(user.id))
        if saved_count > 0:
            text += f"\n\nУ тебя уже сохранено позиций: {saved_count}. Нажми «Мои сохраненные вузы» или /saved."
    if not WEBAPP_URL.startswith("https://"):
        text += "\n\n(Для кнопки Web App администратору нужно указать публичный HTTPS-адрес в WEBAPP_URL.)"
    await message.answer(text, reply_markup=build_start_keyboard())


@dp.message(Command("saved"))
async def on_saved_cmd(message: Message) -> None:
    if not message.from_user:
        return
    text, kb = render_saved_view(message.from_user.id)
    await message.answer(text, reply_markup=kb)


@dp.callback_query(F.data == "open_saved")
async def on_open_saved(callback: CallbackQuery) -> None:
    text, kb = render_saved_view(callback.from_user.id)
    if callback.message:
        await callback.message.answer(text, reply_markup=kb)
    await callback.answer()


@dp.callback_query(F.data.startswith("del_saved:"))
async def on_delete_saved(callback: CallbackQuery) -> None:
    try:
        row_id = int(callback.data.split(":", 1)[1])
    except ValueError:
        await callback.answer("Неверный ID.", show_alert=True)
        return

    with db_connect() as con:
        con.execute(
            "DELETE FROM user_saved_programs WHERE id = ? AND telegram_id = ?",
            (row_id, callback.from_user.id),
        )

    text, kb = render_saved_view(callback.from_user.id)
    if callback.message:
        try:
            await callback.message.edit_text(text, reply_markup=kb)
        except Exception:
            await callback.message.answer(text, reply_markup=kb)
    await callback.answer("Удалено из списка.")


@dp.callback_query(F.data == "export_mmt")
async def on_export_mmt(callback: CallbackQuery) -> None:
    text = build_mmt_export_text(callback.from_user.id)
    if callback.message:
        await callback.message.answer(text)
    await callback.answer("Шпаргалка готова!")


# ---------- Партнёрский канал: «Забрать лид в работу» ----------

@dp.callback_query(F.data.startswith("claim_lead:"))
async def on_claim_lead(callback: CallbackQuery) -> None:
    try:
        lead_id = int(callback.data.split(":", 1)[1])
    except ValueError:
        await callback.answer("Некорректный номер заявки.", show_alert=True)
        return

    user = callback.from_user
    agency_label = f"@{user.username}" if user.username else f"id{user.id}"

    with db_connect() as con:
        cur = con.execute(
            """
            UPDATE abroad_leads
               SET status = 'claimed',
                   claimed_by_id = ?,
                   claimed_by_username = ?,
                   claimed_at = datetime('now')
             WHERE id = ? AND status = 'new'
            """,
            (user.id, agency_label, lead_id),
        )
        won = cur.rowcount == 1
        row = con.execute(
            "SELECT claimed_by_username FROM abroad_leads WHERE id = ?",
            (lead_id,),
        ).fetchone()

    owner = (row["claimed_by_username"] if row and row["claimed_by_username"] else agency_label)
    claimed_kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=f"В работе у {owner}", callback_data="claimed_noop")
    ]])

    if callback.message:
        try:
            await callback.message.edit_reply_markup(reply_markup=claimed_kb)
        except Exception as e:
            logging.warning("Не удалось обновить кнопку лида #%s: %s", lead_id, e)

    if won:
        await callback.answer(f"Лид #{lead_id} закреплён за {owner}!", show_alert=False)
    else:
        await callback.answer(f"Заявку уже забрал партнёр {owner}.", show_alert=True)


@dp.callback_query(F.data == "claimed_noop")
async def on_claimed_noop(callback: CallbackQuery) -> None:
    await callback.answer("Эта заявка уже в работе.", show_alert=False)


# ---------- Запуск ----------

async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not BOT_TOKEN:
        sys.exit("Ошибка: не задан BOT_TOKEN в .env")
    if not WEBAPP_URL.startswith("https://"):
        logging.warning(
            "WEBAPP_URL не задан или не начинается с https:// (%r). "
            "Кнопка Web App появится после указания HTTPS-ссылки в .env.",
            WEBAPP_URL,
        )

    bot = Bot(token=BOT_TOKEN)
    try:
        try:
            await bot.set_my_commands([
                BotCommand(command="start", description="Открыть Studex"),
                BotCommand(command="saved", description="Мои сохраненные вузы"),
            ])
            me = await bot.get_me()
            logging.info(
                "Бот запущен: @%s (id=%s), DB=%s, PARTNER_CHANNEL_ID=%s",
                me.username, me.id, DB_PATH, PARTNER_CHANNEL_ID or f"fallback ADMIN ({ADMIN_CHAT_ID})",
            )
        except Exception as e:
            logging.warning("Временная ошибка Telegram при старте (%s) — продолжаю запуск polling…", e)
        await dp.start_polling(bot)
    finally:
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
