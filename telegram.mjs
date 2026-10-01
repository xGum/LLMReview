// Telegram-бот для релиз-дайджестов. Без зависимостей: Bot API через fetch, long polling.
//
// Команды в группе (или личке) из списка TELEGRAM_CHAT_IDS:
//   /report                       — дайджест за прошлую полную неделю (пн–вс)
//   /report 7                     — за последние N дней
//   /report 2026-09-14 2026-09-20 — за период
//   /report ... force             — собрать, даже если у части PR не удалось получить саммари
//   /latest                       — переслать последний готовый дайджест, не пересобирая
//   /status                       — репозитории, последний дайджест, аптайм
//   /chatid                       — id этого чата (нужен для TELEGRAM_CHAT_IDS)
//
// В чат уходит текстовая часть (telegram.txt из папки дайджеста), затем markdown-файлы:
// summary.md и по одному на репозиторий.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { loadEnv } from "./common.mjs";

const env = loadEnv();
const {
  TELEGRAM_BOT_TOKEN = "",
  TELEGRAM_CHAT_IDS = "",     // разрешённые чаты через запятую: -1001234567890, 123456789
  TELEGRAM_AUTO_POST = "true", // слать недельный дайджест по расписанию во все разрешённые чаты
} = env;

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const ALLOWED = new Set(TELEGRAM_CHAT_IDS.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean));
const TG_TEXT_LIMIT = 4096;

export const telegramEnabled = Boolean(TELEGRAM_BOT_TOKEN);
export const autoPostEnabled = telegramEnabled && TELEGRAM_AUTO_POST === "true" && ALLOWED.size > 0;
export const allowedChatIds = [...ALLOWED];

const log = (m) => console.log(`[telegram] ${m}`);
const logErr = (m) => console.error(`[telegram] ✗ ${m}`);

// ---------- Bot API ----------
async function tg(method, body, { timeoutMs = 60_000 } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`${method}: ${data.description ?? res.status}`);
  return data.result;
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Наш markdown (заголовки ###, **жирный**, пункты, ссылки) → Telegram HTML
export function mdToTelegramHtml(md) {
  const lines = escapeHtml(md.replace(/\r/g, "")).split("\n").map((line) => {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) return `<b>${h[1]}</b>`;
    return line
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/(^|\s)_(.+?)_(?=\s|$)/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^(\s*)[-*]\s+/, "$1• ");
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function trimForTelegram(text, limit = TG_TEXT_LIMIT - 100) {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf("\n", limit);
  return text.slice(0, cut > 0 ? cut : limit) + "\n…\n<i>Полный текст — в файле summary.md</i>";
}

export async function sendText(chatId, html) {
  return tg("sendMessage", { chat_id: chatId, text: trimForTelegram(html), parse_mode: "HTML", disable_web_page_preview: true });
}

// Файлы одним альбомом (до 10), иначе по одному
export async function sendFiles(chatId, filePaths, caption = "") {
  const paths = filePaths.slice(0, 10);
  if (paths.length === 0) return;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  const media = paths.map((p, i) => ({
    type: "document",
    media: `attach://f${i}`,
    ...(i === paths.length - 1 && caption ? { caption, parse_mode: "HTML" } : {}),
  }));
  form.append("media", JSON.stringify(media));
  paths.forEach((p, i) => form.append(`f${i}`, new Blob([readFileSync(p)], { type: "text/markdown" }), basename(p)));
  try {
    await tg("sendMediaGroup", form, { timeoutMs: 120_000 });
  } catch (err) {
    logErr(`sendMediaGroup не прошёл (${err.message}), шлю по одному`);
    for (const p of paths) {
      const f = new FormData();
      f.append("chat_id", String(chatId));
      f.append("document", new Blob([readFileSync(p)], { type: "text/markdown" }), basename(p));
      await tg("sendDocument", f, { timeoutMs: 120_000 });
    }
  }
}

// Отправить готовый дайджест: текст + файлы
export async function sendDigest(chatId, digest) {
  await sendText(chatId, digest.telegramText);
  await tg("sendChatAction", { chat_id: chatId, action: "upload_document" }).catch(() => {});
  await sendFiles(chatId, digest.files, `📎 Подробности: общий отчёт и по каждому проекту`);
}

export async function broadcastDigest(digest, chatIds = allowedChatIds) {
  for (const id of chatIds) {
    try { await sendDigest(id, digest); log(`дайджест отправлен в чат ${id}`); }
    catch (err) { logErr(`чат ${id}: ${err.message}`); }
  }
}

// ---------- разбор команды /report ----------
function parseReportArgs(args) {
  const force = args.includes("force");
  const rest = args.filter((a) => a !== "force");
  if (rest.length === 0) return { force };
  if (rest.length === 1 && /^\d{1,3}$/.test(rest[0])) return { force, days: Number(rest[0]) };
  if (rest.length === 2 && rest.every((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))) return { force, from: rest[0], to: rest[1] };
  return { error: "Не понял период. Варианты: /report, /report 7, /report 2026-09-14 2026-09-20 (+ force)" };
}

const HELP = [
  "<b>Команды</b>",
  "/report — дайджест за прошлую неделю (пн–вс)",
  "/report 7 — за последние 7 дней",
  "/report 2026-09-14 2026-09-20 — за период",
  "добавь <code>force</code> — собрать, даже если у части PR нет саммари",
  "/latest — прислать последний готовый дайджест",
  "/status — что отслеживается и когда был последний дайджест",
].join("\n");

// ---------- long polling ----------
// handlers: { report({days,from,to,force}, progress) → digest, latest() → digest|null, status() → html }
export function startTelegramBot(handlers) {
  if (!telegramEnabled) return;
  if (ALLOWED.size === 0) log("TELEGRAM_CHAT_IDS пуст — бот ответит только на /chatid, остальные команды будут отклонены");

  let busy = false;
  const startedAt = Math.floor(Date.now() / 1000);

  async function handle(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text ?? "").trim();
    const m = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/s);
    if (!m) return;
    const [, cmd, argStr = ""] = m;
    const args = argStr.split(/\s+/).filter(Boolean);
    const from = msg.from?.username ? "@" + msg.from.username : msg.from?.first_name ?? "?";

    if (cmd === "chatid") {
      await sendText(chatId, `id этого чата: <code>${chatId}</code>${ALLOWED.has(String(chatId)) ? " (разрешён)" : " — добавь в TELEGRAM_CHAT_IDS в .env и перезапусти бота"}`);
      return;
    }
    if (!ALLOWED.has(String(chatId))) {
      log(`команда /${cmd} из неразрешённого чата ${chatId} (${msg.chat.title ?? msg.chat.type}) от ${from}`);
      await sendText(chatId, `⛔ Этот чат не в списке разрешённых. id чата: <code>${chatId}</code>`);
      return;
    }
    log(`/${cmd} ${args.join(" ")} от ${from} в чате ${chatId}`);

    if (cmd === "help" || cmd === "start") return sendText(chatId, HELP);
    if (cmd === "status") return sendText(chatId, await handlers.status());
    if (cmd === "latest") {
      const digest = await handlers.latest();
      if (!digest) return sendText(chatId, "Готовых дайджестов пока нет — запусти /report");
      return sendDigest(chatId, digest);
    }
    if (cmd !== "report") return;

    const opts = parseReportArgs(args);
    if (opts.error) return sendText(chatId, opts.error);
    if (busy) return sendText(chatId, "⏳ Уже собираю дайджест, подожди — пришлю, как будет готов");
    busy = true;
    try {
      const periodHint = opts.days ? `за последние ${opts.days} дн.` : opts.from ? `за ${opts.from} — ${opts.to}` : "за прошлую неделю";
      await sendText(chatId, `⏳ Собираю дайджест ${periodHint}. Если у PR нет саммари, сначала догенерирую их — это может занять несколько минут.`);
      await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      const result = await handlers.report(opts);
      if (!result.ok) {
        return sendText(chatId, `⚠️ Дайджест не собран: ${escapeHtml(result.reason)}\n\nМожно повторить с <code>force</code> — тогда PR без саммари войдут как есть.`);
      }
      await sendDigest(chatId, result.digest);
    } catch (err) {
      logErr(`/report: ${err.message}`);
      await sendText(chatId, `⚠️ Ошибка: ${escapeHtml(err.message)}`).catch(() => {});
    } finally {
      busy = false;
    }
  }

  (async () => {
    let offset;
    try {
      // пропускаем накопившиеся до старта апдейты, чтобы не отрабатывать старые команды
      const backlog = await tg("getUpdates", { offset: -1, timeout: 0 });
      if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;
      const me = await tg("getMe");
      log(`бот @${me.username} запущен, разрешённых чатов: ${ALLOWED.size}`);
    } catch (err) {
      logErr(`не удалось запустить бота: ${err.message}`);
      return;
    }
    for (;;) {
      try {
        const updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] }, { timeoutMs: 45_000 });
        for (const u of updates) {
          offset = u.update_id + 1;
          const msg = u.message;
          if (!msg || !msg.text || msg.date < startedAt - 60) continue;
          handle(msg).catch((err) => logErr(`обработка сообщения: ${err.message}`));
        }
      } catch (err) {
        logErr(`getUpdates: ${err.message} — повтор через 5 с`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}
