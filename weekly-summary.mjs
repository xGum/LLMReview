// Еженедельный релиз-дайджест для бизнеса.
// Берёт смердженные PR в базовую ветку каждого репозитория за период, просит локальную
// модель (Ollama) описать изменения человеческим языком и кладёт markdown в папку истории.
//
// Ручной запуск:
//   node weekly-summary.mjs                       # прошлая полная неделя (пн–вс)
//   node weekly-summary.mjs --days 7              # последние 7 дней до текущего момента
//   node weekly-summary.mjs --from 2026-09-01 --to 2026-09-14
//   node weekly-summary.mjs --repo xGum/LazarReact # только один репозиторий
//   node weekly-summary.mjs --dry-run             # собрать данные и показать промпт; describe и модель не звать
//   node weekly-summary.mjs --allow-missing       # не требовать саммари у всех PR, собрать как есть
//   node weekly-summary.mjs --no-describe         # не догенерировать саммари (подразумевает --allow-missing)
//
// Порядок работы:
//   1. По каждому репозиторию — список PR, смердженных в базовую ветку за период.
//   2. У каких PR нет саммари от pr-agent describe — для них запускается `describe`
//      (только он), описание PR на GitHub дополняется, тело перечитывается.
//   3. Только когда саммари есть у всех PR (или передан allowMissing) — общий дайджест
//      по репозиторию через модель и запись markdown-файла.
//
// Поллер импортирует runWeeklySummary() и вызывает его по расписанию.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { ROOT, loadEnv, parseRepos, githubJson, ymd, isoLocal, pad2 } from "./common.mjs";
import { runPrAgent } from "./pr-agent.mjs";

const env = loadEnv();
const {
  GITHUB_TOKEN,
  REPOS,
  REPO,
  BASE_BRANCH = "master",
  SUMMARY_PROVIDER = "ollama",        // ollama | openrouter
  OLLAMA_URL = "http://localhost:11434",
  OPENROUTER_API_KEY = "",
  OPENROUTER_URL = "https://openrouter.ai/api/v1",
  SUMMARY_MODEL = "",                 // по умолчанию: gpt-oss:20b для ollama, z-ai/glm-5.3-flash для openrouter
  SUMMARY_NUM_CTX = "32768",          // только для ollama
  SUMMARY_THINK = "low",              // глубина рассуждений gpt-oss: low/medium/high; "" — не передавать
  SUMMARY_TIMEOUT_MINUTES = "30",
  RELEASE_NOTES_DIR = "release-notes",
} = env;

const MODEL = SUMMARY_MODEL || (SUMMARY_PROVIDER === "openrouter" ? "z-ai/glm-5.3-flash" : "gpt-oss:20b");
if (SUMMARY_PROVIDER === "openrouter" && !OPENROUTER_API_KEY) {
  console.error("SUMMARY_PROVIDER=openrouter, но OPENROUTER_API_KEY в .env пуст.");
  process.exit(1);
}

if (!GITHUB_TOKEN) {
  console.error("В .env обязателен GITHUB_TOKEN.");
  process.exit(1);
}

const ALL_REPOS = parseRepos(REPOS || REPO, BASE_BRANCH);
const MAX_BODY_CHARS = 1800;

// ---------- периоды ----------
export function previousFullWeek(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7;            // пн = 0
  const thisMonday = new Date(d);
  thisMonday.setDate(d.getDate() - dow);
  const from = new Date(thisMonday);
  from.setDate(thisMonday.getDate() - 7);
  return { from, to: thisMonday };             // [from, to)
}

function lastDays(days, now = new Date()) {
  const to = new Date(now);
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  return { from, to };
}

function dayRange(fromYmd, toYmd) {
  const from = new Date(`${fromYmd}T00:00:00`);
  const to = new Date(`${toYmd}T00:00:00`);
  to.setDate(to.getDate() + 1);                // включительно по дате
  if (isNaN(from) || isNaN(to)) throw new Error("Даты нужны в формате YYYY-MM-DD");
  return { from, to };
}

const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
function humanPeriod({ from, to }) {
  const last = new Date(to.getTime() - 1);
  const f = `${from.getDate()}${from.getMonth() === last.getMonth() ? "" : " " + MONTHS_GEN[from.getMonth()]}`;
  return `${f}–${last.getDate()} ${MONTHS_GEN[last.getMonth()]} ${last.getFullYear()}`;
}

// ---------- GitHub: смердженные PR за период ----------
async function fetchMergedPRs(repo, { from, to }) {
  const toInclusive = new Date(to.getTime() - 1000);
  const q = `repo:${repo.fullName} is:pr is:merged base:${repo.branch} merged:${isoLocal(from)}..${isoLocal(toInclusive)}`;
  const items = [];
  for (let page = 1; page <= 5; page++) {
    const data = await githubJson(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=asc&per_page=100&page=${page}`, GITHUB_TOKEN);
    items.push(...data.items);
    if (items.length >= data.total_count || data.items.length === 0) break;
  }
  return items.map((it) => ({
    number: it.number,
    title: it.title,
    url: it.html_url,
    author: it.user?.login ?? "?",
    mergedAt: it.pull_request?.merged_at ? new Date(it.pull_request.merged_at) : null,
    labels: (it.labels ?? []).map((l) => l.name),
    body: cleanPrBody(it.body),
    hasSummary: hasPrAgentSummary(it.body),
  })).sort((a, b) => (a.mergedAt?.getTime() ?? 0) - (b.mergedAt?.getTime() ?? 0));
}

// Саммари от pr-agent describe определяем так же, как сам pr-agent (_is_generated_by_pr_agent):
// по его заголовкам в теле PR или по скрытой html-метке.
const PR_AGENT_MARKERS = [
  "<!-- pr-agent-generated -->",
  "### **description**",
  "### **pr description**",
  "### **pr type**",
  "### 🤖 generated by pr agent",
];
export function hasPrAgentSummary(body) {
  const low = (body ?? "").toLowerCase();
  return PR_AGENT_MARKERS.some((m) => low.includes(m));
}

// Догенерировать саммари для PR без него: pr-agent describe → перечитать тело PR.
async function ensureSummaries(repo, prs, { dryRun, describe }) {
  const missing = prs.filter((pr) => !pr.hasSummary);
  if (!missing.length) return [];
  const log = (m) => console.log(`[дайджест] ${repo.fullName}: ${m}`);
  log(`без саммари ${missing.length} из ${prs.length} PR: ${missing.map((p) => "#" + p.number).join(", ")}`);
  if (dryRun || !describe) {
    log(dryRun ? "dry-run — describe не запускаю" : "--no-describe — саммари не догенерирую");
    return missing;
  }

  const stillMissing = [];
  for (const pr of missing) {
    log(`describe для #${pr.number} «${pr.title}»`);
    const ok = await runPrAgent(pr.url, "describe");
    if (ok) {
      try {
        const fresh = await githubJson(`/repos/${repo.fullName}/pulls/${pr.number}`, GITHUB_TOKEN);
        pr.body = cleanPrBody(fresh.body);
        pr.hasSummary = hasPrAgentSummary(fresh.body);
      } catch (err) {
        console.error(`[дайджест] ${repo.fullName}: не удалось перечитать #${pr.number}: ${err.message}`);
      }
    }
    if (!pr.hasSummary) stillMissing.push(pr);
  }
  if (stillMissing.length) log(`саммари так и нет у: ${stillMissing.map((p) => "#" + p.number).join(", ")}`);
  else log(`саммари догенерированы для всех ${missing.length} PR`);
  return stillMissing;
}

// Тело PR: описание автора + саммари от pr-agent describe. Убираем таблицы файлов,
// диаграммы, html и картинки — модели нужна суть, а не разметка.
function cleanPrBody(body) {
  if (!body) return "";
  let s = body.replace(/\r/g, "");
  s = s.replace(/<details>[\s\S]*?<\/details>/gi, "");
  s = s.replace(/```mermaid[\s\S]*?```/g, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  s = s.replace(/^\s*\|.*$/gm, "");
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, "");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s.length > MAX_BODY_CHARS ? s.slice(0, MAX_BODY_CHARS) + "…" : s;
}

// ---------- промпт ----------
const SYSTEM_PROMPT = `Ты готовишь еженедельный дайджест изменений в продукте для руководителей и менеджеров, которые не читают код.
Пиши только на русском языке. Тон — живой, дружелюбный и позитивный, как хорошая новостная рассылка команды: коротко, по делу, с лёгкой энергией. Без канцелярита и без кривляния.

Правила содержания:
- Опирайся ТОЛЬКО на присланный список изменений. Ничего не выдумывай и не додумывай, чего нет в данных.
- Формулируй с точки зрения пользователя и бизнеса: что теперь можно сделать, что стало работать правильно, что стало удобнее или быстрее.
- Не упоминай имена файлов, функций, компонентов, библиотек, хуков, коммитов, номера PR и авторов.
- Объединяй мелкие правки одной темы в один пункт. Не повторяйся.
- Каждый пункт — одно-два коротких предложения без технического жаргона. Если из данных нельзя понять пользу для пользователя, опиши изменение нейтрально и коротко.
- Чисто технические изменения (рефакторинг, обновление зависимостей, настройка сборки, тесты) объединяй в один общий пункт в последнем разделе, без деталей.

Правила оформления:
- Каждый пункт начинается с одного яркого эмодзи, подходящего по смыслу (например: 🎉 ✨ 🛒 💳 📦 🔔 📊 🔍 ⚡ 🛡️ 🧹 🐞 ✅ 🚀 📱 💬 🎨 🗂️). Ровно один эмодзи в начале пункта, внутри текста эмодзи не ставь.
- Подбирай разные эмодзи, не повторяй один и тот же подряд.
- Заголовки разделов — строго такие, как в шаблоне ниже.

Формат ответа — только markdown, без вступлений, без заключений и без кода:

### ✨ Что нового
- 🎉 ...

### 🐞 Что исправлено
- ✅ ...

### 🚀 Улучшения и прочее
- ⚡ ...

Пустые разделы не выводи.`;

// Короткая выжимка поверх всех репозиториев для общего файла
const OVERVIEW_SYSTEM_PROMPT = `Ты пишешь короткую выжимку «главное за неделю» для руководителей по уже готовым дайджестам нескольких проектов.
Пиши только на русском языке, живо и позитивно, без технического жаргона, без имён файлов и номеров PR.
Выбери 3–5 самых заметных для бизнеса и пользователей изменений из всех проектов. Ничего не добавляй от себя — только то, что есть в дайджестах.
Каждый пункт — одно предложение, начинается с одного яркого эмодзи по смыслу, в скобках в конце укажи название проекта, например «(LazarReact)».
Формат ответа — только markdown-список из пунктов, без заголовков, вступлений и заключений.`;

function buildUserPrompt(repo, prs, period) {
  const lines = [`Проект: ${repo.fullName}. Период: ${humanPeriod(period)}. Изменений: ${prs.length}.`, ""];
  prs.forEach((pr, i) => {
    lines.push(`--- Изменение ${i + 1}: ${pr.title}`);
    if (pr.labels.length) lines.push(`Метки: ${pr.labels.join(", ")}`);
    if (pr.body) lines.push(pr.body);
    else if (!pr.hasSummary) lines.push("(описания нет — опирайся только на заголовок)");
    lines.push("");
  });
  return lines.join("\n");
}

// ---------- LLM: Ollama или OpenRouter ----------
const TIMEOUT_MS = Number(SUMMARY_TIMEOUT_MINUTES) * 60_000;

function stripFences(text) {
  return text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/, "").trim();
}

async function ollamaChat(messages) {
  const body = {
    model: MODEL,
    stream: false,
    messages,
    options: { num_ctx: Number(SUMMARY_NUM_CTX), temperature: 0.3 },
  };
  if (SUMMARY_THINK) body.think = SUMMARY_THINK;

  const call = async (payload) => {
    const res = await fetch(`${OLLAMA_URL.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  let data;
  try {
    data = await call(body);
  } catch (err) {
    // модель не поддерживает параметр think — повторяем без него
    if (body.think && /think/i.test(err.message)) {
      delete body.think;
      data = await call(body);
    } else throw err;
  }
  const content = (data.message?.content ?? "").trim();
  if (!content) {
    throw new Error(`пустой ответ модели (done_reason: ${data.done_reason ?? "?"}); ` +
      `если done_reason=length — увеличь SUMMARY_NUM_CTX`);
  }
  return stripFences(content);
}

// OpenAI-совместимый chat/completions OpenRouter
async function openrouterChat(messages) {
  const body = { model: MODEL, messages, temperature: 0.3 };
  if (SUMMARY_THINK) body.reasoning = { effort: SUMMARY_THINK };

  const res = await fetch(`${OPENROUTER_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "https://github.com/xGum/llm_review",
      "X-Title": "PR Review Bot weekly digest",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(`OpenRouter: ${data.error.message ?? JSON.stringify(data.error)}`);
  const choice = data.choices?.[0];
  const content = (choice?.message?.content ?? "").trim();
  if (!content) throw new Error(`пустой ответ модели (finish_reason: ${choice?.finish_reason ?? "?"})`);
  if (data.usage) {
    console.log(`[дайджест]   токены: ${data.usage.prompt_tokens} вход / ${data.usage.completion_tokens} выход`);
  }
  return stripFences(content);
}

const llmChat = SUMMARY_PROVIDER === "openrouter" ? openrouterChat : ollamaChat;

// ---------- сборка markdown ----------
function fmtDate(d) { return d ? `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}` : "?"; }
function shortName(repo) { return repo.fullName.split("/")[1]; }

function generatedLine(generatedAt) {
  return `_Сформировано ${ymd(generatedAt)} ${pad2(generatedAt.getHours())}:${pad2(generatedAt.getMinutes())} по смердженным PR в GitHub. Модель: ${MODEL} (${SUMMARY_PROVIDER})._`;
}

function prListLines(prs) {
  return prs.map((pr) =>
    `- [#${pr.number} ${pr.title}](${pr.url}) — @${pr.author}, ${fmtDate(pr.mergedAt)}` +
    (pr.hasSummary ? "" : " _(без саммари pr-agent)_"));
}

// Общий файл: главное за неделю + разделы по репозиториям + свёрнутый список всех PR
function renderGeneral({ period, generatedAt, sections, overview, repoFiles }) {
  const out = [];
  out.push(`# 🗓️ Релиз-дайджест: ${humanPeriod(period)}`, "", generatedLine(generatedAt), "");
  const total = sections.reduce((n, s) => n + s.prs.length, 0);
  const active = sections.filter((s) => s.prs.length);
  out.push(`За неделю смерджено **${total} PR** в ${active.length} ${plural(active.length, "проекте", "проектах", "проектах")}.`, "");

  if (overview) out.push("## 🌟 Главное за неделю", "", overview, "");

  for (const s of sections) {
    out.push(`## 📦 ${shortName(s.repo)}`, "");
    if (s.prs.length === 0) { out.push("😴 За неделю смердженных изменений нет.", ""); continue; }
    out.push(s.summary, "");
    out.push(`📄 Подробнее: [${repoFiles[s.repo.fullName]}](./${repoFiles[s.repo.fullName]})`, "");
  }

  out.push("---", "", "<details>", `<summary>🔗 Список изменений (${total} PR)</summary>`, "");
  for (const s of sections) {
    if (!s.prs.length) continue;
    out.push(`**${s.repo.fullName}**`, "", ...prListLines(s.prs), "");
  }
  out.push("</details>", "");
  return out.join("\n");
}

// Файл по одному репозиторию
function renderRepo({ period, generatedAt, section }) {
  const s = section;
  const out = [];
  out.push(`# 📦 ${shortName(s.repo)} — ${humanPeriod(period)}`, "", generatedLine(generatedAt), "");
  if (s.prs.length === 0) {
    out.push("😴 За неделю смердженных изменений нет.", "");
    return out.join("\n");
  }
  out.push(`Смерджено **${s.prs.length} PR** в ветку \`${s.repo.branch}\`.`, "");
  out.push(s.summary, "");
  out.push("---", "", `## 🔗 Список изменений (${s.prs.length} PR)`, "", ...prListLines(s.prs), "");
  return out.join("\n");
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function reportDirName(period) {
  const last = new Date(period.to.getTime() - 1);
  return `${ymd(period.from)}_${ymd(last)}`;
}

// имена файлов по репозиториям: LazarReact.md; при совпадении имён у разных owner — owner_repo.md
function repoFileNames(sections) {
  const counts = {};
  for (const s of sections) counts[shortName(s.repo)] = (counts[shortName(s.repo)] ?? 0) + 1;
  const names = {};
  for (const s of sections) {
    const short = shortName(s.repo);
    names[s.repo.fullName] = (counts[short] > 1 ? s.repo.fullName.replace("/", "_") : short) + ".md";
  }
  return names;
}

// ---------- основной сценарий ----------
// Возвращает { ok, reason?, file?, sections }. ok=false — отчёт не записан.
export async function runWeeklySummary({
  period, repos = ALL_REPOS, dryRun = false, outDir, allowMissing = false, describe = true,
} = {}) {
  period ??= previousFullWeek();
  const dir = join(resolve(ROOT, outDir || RELEASE_NOTES_DIR), reportDirName(period));
  const file = join(dir, "summary.md");
  const log = (m) => console.log(`[дайджест] ${m}`);
  if (!describe) allowMissing = true;

  log(`период ${ymd(period.from)} — ${ymd(new Date(period.to.getTime() - 1))}, репозиториев: ${repos.length}, модель ${SUMMARY_PROVIDER}/${MODEL}`);

  // ---- фаза 1: список PR и саммари для каждого ----
  const sections = [];
  const problems = [];
  for (const repo of repos) {
    const section = { repo, prs: [], summary: "", error: null, missing: [] };
    sections.push(section);
    try {
      section.prs = await fetchMergedPRs(repo, period);
      log(`${repo.fullName}: смерджено PR — ${section.prs.length}`);
      section.missing = await ensureSummaries(repo, section.prs, { dryRun, describe });
      if (section.missing.length && !allowMissing && !dryRun) {
        problems.push(`${repo.fullName}: нет саммари у ${section.missing.map((p) => "#" + p.number).join(", ")}`);
      }
    } catch (err) {
      section.error = err.message;
      problems.push(`${repo.fullName}: ${err.message}`);
      console.error(`[дайджест] ${repo.fullName}: ✗ ${err.message}`);
    }
  }

  if (problems.length) {
    const reason = problems.join("; ");
    log(`отчёт не собираю — ${reason}`);
    return { ok: false, reason, file, sections };
  }

  // ---- фаза 2: общий дайджест по каждому репозиторию ----
  for (const section of sections) {
    const { repo, prs } = section;
    if (!prs.length) continue;
    const userPrompt = buildUserPrompt(repo, prs, period);
    if (dryRun) {
      console.log(`\n===== промпт для ${repo.fullName} (${userPrompt.length} символов) =====\n${userPrompt}\n`);
      section.summary = "_(dry-run: модель не вызывалась)_";
      continue;
    }
    try {
      const started = Date.now();
      section.summary = await llmChat([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ]);
      log(`${repo.fullName}: саммари готово за ${Math.round((Date.now() - started) / 1000)} с`);
    } catch (err) {
      section.error = err.message;
      console.error(`[дайджест] ${repo.fullName}: ✗ ${err.message}`);
    }
  }

  const repoFiles = repoFileNames(sections);
  if (dryRun) {
    log(`dry-run: папка ${dir} не создана (файлы: summary.md, ${Object.values(repoFiles).join(", ")})`);
    return { ok: true, dir, file, sections };
  }
  const failed = sections.filter((s) => s.error);
  if (failed.length) {
    const reason = failed.map((s) => `${s.repo.fullName}: ${s.error}`).join("; ");
    log(`отчёт не записан — ${reason}`);
    return { ok: false, reason, dir, file, sections };
  }

  // ---- фаза 3: «главное за неделю» поверх всех репозиториев (если изменения были не в одном) ----
  let overview = "";
  const active = sections.filter((s) => s.prs.length);
  if (active.length > 1) {
    try {
      const started = Date.now();
      const digest = active.map((s) => `## ${shortName(s.repo)}\n${s.summary}`).join("\n\n");
      overview = await llmChat([
        { role: "system", content: OVERVIEW_SYSTEM_PROMPT },
        { role: "user", content: `Период: ${humanPeriod(period)}.\n\n${digest}` },
      ]);
      log(`главное за неделю готово за ${Math.round((Date.now() - started) / 1000)} с`);
    } catch (err) {
      console.error(`[дайджест] главное за неделю не получилось (${err.message}) — общий файл будет без этого блока`);
    }
  }

  const generatedAt = new Date();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, renderGeneral({ period, generatedAt, sections, overview, repoFiles }), "utf8");
  for (const section of sections) {
    writeFileSync(join(dir, repoFiles[section.repo.fullName]), renderRepo({ period, generatedAt, section }), "utf8");
  }
  log(`записано в ${dir}: summary.md, ${Object.values(repoFiles).join(", ")}`);
  return { ok: true, dir, file, sections };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--from") opts.from = next();
    else if (a === "--to") opts.to = next();
    else if (a === "--days") opts.days = Number(next());
    else if (a === "--repo") opts.repo = next();
    else if (a === "--out") opts.out = next();
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--allow-missing") opts.allowMissing = true;
    else if (a === "--no-describe") opts.describe = false;
    else if (a === "--help" || a === "-h") opts.help = true;
    else { console.error(`Неизвестный аргумент: ${a}`); process.exit(1); }
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`node weekly-summary.mjs [--days N | --from YYYY-MM-DD --to YYYY-MM-DD] [--repo owner/repo] [--out папка] [--dry-run] [--allow-missing] [--no-describe]`);
    process.exit(0);
  }
  let period;
  if (opts.from || opts.to) {
    if (!opts.from || !opts.to) { console.error("--from и --to нужны вместе"); process.exit(1); }
    period = dayRange(opts.from, opts.to);
  } else if (opts.days) {
    period = lastDays(opts.days);
  }
  let repos = ALL_REPOS;
  if (opts.repo) {
    repos = ALL_REPOS.filter((r) => r.fullName.toLowerCase() === opts.repo.toLowerCase());
    if (!repos.length) { console.error(`Репозиторий ${opts.repo} не найден в REPOS`); process.exit(1); }
  }
  runWeeklySummary({ period, repos, dryRun: opts.dryRun, outDir: opts.out, allowMissing: opts.allowMissing, describe: opts.describe !== false })
    .then(({ ok }) => process.exit(ok ? 0 : 1))
    .catch((err) => { console.error(`[дайджест] ✗ ${err.message}`); process.exit(1); });
}
