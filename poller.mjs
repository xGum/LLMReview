// PR Review Bot — локальный поллер
// Следит за открытыми PR в базовую ветку в нескольких репозиториях,
// при новых коммитах запускает pr-agent (describe + review) через локальную LLM (Ollama).
// Node 18+, без зависимостей.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(ROOT, "state.json");
const LOCAL_CONFIG_FILE = join(ROOT, "pr_agent.local.toml");

// ---------- .env ----------
function loadEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) {
    console.error("Нет файла .env — скопируй .env.example в .env и заполни.");
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const {
  GITHUB_TOKEN,               // один токен на все репозитории
  REPOS,                      // "owner/repo1, owner/repo2:develop, owner/repo3"
  REPO,                       // старый формат: один "owner/repo" (для совместимости)
  BASE_BRANCH = "master",     // ветка по умолчанию, если у репо не указана своя
  POLL_MINUTES = "5",
  PYTHON_CMD = "python",      // на Windows иногда "py"
  SKIP_DRAFTS = "true",
  CLI_TIMEOUT_MINUTES = "20", // локальная модель может думать долго
} = env;

// ---------- список репозиториев ----------
// Формат элемента: "owner/repo" или "owner/repo:branch".
// Разделители — запятая, точка с запятой или перенос строки.
function parseRepos(raw) {
  const repos = [];
  for (const item of (raw ?? "").split(/[,;\n]/)) {
    const s = item.trim();
    if (!s) continue;
    const [fullName, branch] = s.split(":");
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      console.error(`Некорректный репозиторий в .env: «${s}» (ожидается owner/repo или owner/repo:branch)`);
      process.exit(1);
    }
    repos.push({ fullName, branch: (branch || BASE_BRANCH).trim() });
  }
  // убираем дубли
  const seen = new Set();
  return repos.filter((r) => !seen.has(r.fullName) && seen.add(r.fullName));
}

const REPO_LIST = parseRepos(REPOS || REPO);

if (!GITHUB_TOKEN || REPO_LIST.length === 0) {
  console.error("В .env обязательны GITHUB_TOKEN и REPOS (список owner/repo через запятую).");
  process.exit(1);
}

// ---------- локальный конфиг pr-agent ----------
// pr_agent.local.toml перекрывает .pr_agent.toml из репозитория: pr-agent применяет
// CLI-аргументы `--section.key=value` ПОСЛЕ репозиторного файла, поэтому каждый ключ
// локального файла передаётся как аргумент. Значение кодируется в JSON — pr-agent
// парсит его как YAML, а JSON является валидным YAML.
//
// Поддерживаемое подмножество TOML: [секции], key = "строка" | 'строка' | число |
// true/false | [массив, в т.ч. многострочный], комментарии через #.

function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;      // экранирование в basic-строке
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function bracketBalance(text) {
  let depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0, quote = null, cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') cur += text[++i];
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") { quote = ch; cur += ch; }
    else if (ch === "[") { depth++; cur += ch; }
    else if (ch === "]") { depth--; cur += ch; }
    else if (ch === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function parseTomlValue(text, where) {
  const s = text.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) return JSON.parse(s);
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("[") && s.endsWith("]")) {
    return splitTopLevel(s.slice(1, -1)).map((item) => parseTomlValue(item, where));
  }
  throw new Error(`${where}: не могу разобрать значение «${s}» (поддерживаются строки в кавычках, числа, true/false, массивы)`);
}

function parseTomlSubset(text, fileName) {
  const result = {};
  let section = null;
  let pending = null; // накопитель многострочного массива
  const lines = text.split(/\r?\n/);

  for (let n = 0; n < lines.length; n++) {
    const where = `${fileName}:${n + 1}`;
    let line = stripTomlComment(lines[n]).trim();

    if (pending) {
      pending.text += " " + line;
      if (bracketBalance(pending.text) > 0) continue;
      result[section][pending.key] = parseTomlValue(pending.text, where);
      pending = null;
      continue;
    }
    if (!line) continue;

    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      result[section] ??= {};
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`${where}: не понимаю строку «${line}»`);
    if (!section) throw new Error(`${where}: ключ «${kv[1]}» вне секции — в pr-agent все ключи живут в [секциях]`);

    const [, key, valueText] = kv;
    if (valueText.startsWith("[") && bracketBalance(valueText) > 0) {
      pending = { key, text: valueText };
      continue;
    }
    result[section][key] = parseTomlValue(valueText, where);
  }
  if (pending) throw new Error(`${fileName}: незакрытый массив у ключа «${pending.key}»`);
  return result;
}

function loadLocalPrAgentArgs() {
  if (!existsSync(LOCAL_CONFIG_FILE)) return [];
  let config;
  try {
    config = parseTomlSubset(readFileSync(LOCAL_CONFIG_FILE, "utf8"), "pr_agent.local.toml");
  } catch (err) {
    console.error(`Ошибка в pr_agent.local.toml: ${err.message}`);
    process.exit(1);
  }
  const args = [];
  for (const [section, keys] of Object.entries(config)) {
    for (const [key, value] of Object.entries(keys)) {
      // Dynaconf 3.3 (в pr-agent до 15.09.2026) при set() ДОПИСЫВАЕТ списки к существующим,
      // а не заменяет. Поэтому список сначала удаляем через @del, потом ставим заново —
      // работает и на старом, и на новом Dynaconf, остальные ключи секции не трогает.
      if (Array.isArray(value)) args.push(`--${section}.${key}=@del`);
      args.push(`--${section}.${key}=${JSON.stringify(value)}`);
    }
  }
  return args;
}

// Встроенные аргументы: propagate_tool_errors заставляет свежие версии pr-agent выходить
// с кодом 1 при провале (старые версии всегда выходят с 0 — для них ниже есть разбор лога).
const BUILTIN_PR_AGENT_ARGS = ["--config.propagate_tool_errors=true"];
const PR_AGENT_ARGS = [...BUILTIN_PR_AGENT_ARGS, ...loadLocalPrAgentArgs()];

// ---------- state ----------
// Формат: { "owner/repo": { "<номер PR>": "<head sha>" } }
function loadState() {
  let state;
  try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
  if (!state || typeof state !== "object") return {};

  // миграция старого плоского формата { "<номер PR>": "<sha>" } → привязываем к первому репо
  const values = Object.values(state);
  if (values.length && values.every((v) => typeof v === "string")) {
    console.log(`state.json в старом формате — переношу под ${REPO_LIST[0].fullName}`);
    return { [REPO_LIST[0].fullName]: state };
  }
  return state;
}
function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- GitHub API ----------
async function listOpenPRs(repo) {
  const res = await fetch(
    `https://api.github.com/repos/${repo.fullName}/pulls?base=${encodeURIComponent(repo.branch)}&state=open&per_page=50`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------- pr-agent ----------
// pr-agent CLI (кроме самых свежих версий с propagate_tool_errors) при провале печатает
// help и выходит с кодом 0, поэтому успех определяем ещё и по маркерам в логе.
const PR_AGENT_FAILURE_MARKERS = [
  /Failed to process the command/,
  /Failed to generate prediction with any model/,
  /Failed to review PR/,
  /Error generating PR description/,
  /Traceback \(most recent call last\)/,
];

function runPrAgent(prUrl, command) {
  return new Promise((resolve) => {
    const args = ["-m", "pr_agent.cli", `--pr_url=${prUrl}`, command, ...PR_AGENT_ARGS];
    console.log(`  → ${PYTHON_CMD} -m pr_agent.cli --pr_url=${prUrl} ${command}` +
      (PR_AGENT_ARGS.length ? ` (+${PR_AGENT_ARGS.length} переопределений)` : ""));

    const child = spawn(PYTHON_CMD, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        GITHUB__USER_TOKEN: GITHUB_TOKEN, // токен для pr-agent
        PYTHONIOENCODING: "utf-8",        // кириллица в консоли Windows
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let failureSeen = null;
    const watch = (stream, out) => {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        out.write(chunk);
        if (!failureSeen) {
          const m = PR_AGENT_FAILURE_MARKERS.find((re) => re.test(chunk));
          if (m) failureSeen = m.source;
        }
      });
    };
    watch(child.stdout, process.stdout);
    watch(child.stderr, process.stderr);

    const timeout = setTimeout(() => {
      console.error(`  ✗ ${command}: таймаут ${CLI_TIMEOUT_MINUTES} мин, убиваю процесс`);
      child.kill();
    }, Number(CLI_TIMEOUT_MINUTES) * 60_000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error(`  ✗ ${command}: pr-agent завершился с кодом ${code}`);
        return resolve(false);
      }
      if (failureSeen) {
        console.error(`  ✗ ${command}: в логе pr-agent есть признак провала (${failureSeen})`);
        return resolve(false);
      }
      resolve(true);
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      console.error(`  ✗ не удалось запустить ${PYTHON_CMD}: ${err.message}`);
      resolve(false);
    });
  });
}

// ---------- обработка одного репозитория ----------
async function processRepo(repo, state) {
  let prs;
  try {
    prs = await listOpenPRs(repo);
  } catch (err) {
    console.error(`[${repo.fullName}] Ошибка GitHub API: ${err.message}`);
    return; // state этого репо не трогаем — обработаем в следующем цикле
  }

  const repoState = (state[repo.fullName] ??= {});
  console.log(`[${new Date().toLocaleTimeString()}] ${repo.fullName} (${repo.branch}): открытых PR ${prs.length}`);

  for (const pr of prs) {
    if (SKIP_DRAFTS === "true" && pr.draft) continue;

    const headSha = pr.head.sha;
    if (repoState[pr.number] === headSha) continue; // уже обработан

    console.log(`[${repo.fullName}] PR #${pr.number} «${pr.title}» — новый head ${headSha.slice(0, 7)}`);

    // последовательно: одна GPU — один запрос за раз
    const okDescribe = await runPrAgent(pr.html_url, "describe");
    // если describe упал (модель/сеть), review почти наверняка упадёт так же — не жжём GPU
    const okReview = okDescribe && await runPrAgent(pr.html_url, "review");

    if (okDescribe && okReview) {
      repoState[pr.number] = headSha;
      saveState(state);
      console.log(`  ✓ ${repo.fullName}#${pr.number} обработан`);
    } else {
      console.error(`  ✗ ${repo.fullName}#${pr.number}: не всё прошло, попробую в следующем цикле`);
    }
  }

  // чистим состояние закрытых PR этого репо
  const openNumbers = new Set(prs.map((p) => String(p.number)));
  for (const key of Object.keys(repoState)) {
    if (!openNumbers.has(key)) delete repoState[key];
  }
}

// ---------- основной цикл ----------
async function tick() {
  const state = loadState();

  // репозитории обрабатываем последовательно — GPU одна
  for (const repo of REPO_LIST) {
    await processRepo(repo, state);
  }

  // чистим состояние репозиториев, которых больше нет в списке
  const tracked = new Set(REPO_LIST.map((r) => r.fullName));
  for (const key of Object.keys(state)) {
    if (!tracked.has(key)) delete state[key];
  }
  saveState(state);
}

async function main() {
  const intervalMs = Number(POLL_MINUTES) * 60_000;
  console.log(`PR Review Bot запущен, опрос каждые ${POLL_MINUTES} мин. Репозитории:`);
  for (const r of REPO_LIST) console.log(`  • ${r.fullName} → ${r.branch}`);
  const localArgs = PR_AGENT_ARGS.slice(BUILTIN_PR_AGENT_ARGS.length);
  if (localArgs.length) {
    console.log(`Локальные переопределения pr-agent (pr_agent.local.toml), перекрывают .pr_agent.toml из репо:`);
    for (const a of localArgs) console.log(`  ${a}`);
  } else {
    console.log(`pr_agent.local.toml не найден — используется только .pr_agent.toml из репозиториев.`);
  }
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main();
