// Запуск pr-agent CLI с локальными переопределениями конфига.
// Используется поллером (describe/review/improve по открытым PR) и недельным дайджестом
// (describe для смердженных PR без саммари).

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT, loadEnv } from "./common.mjs";

const env = loadEnv();
const {
  GITHUB_TOKEN,
  PYTHON_CMD = "python",      // на Windows иногда "py"
  CLI_TIMEOUT_MINUTES = "20", // локальная модель может думать долго
  PR_AGENT_LOCAL_CONFIG = "pr_agent.local.toml", // какой локальный конфиг активен (ollama / openrouter)
  OPENROUTER_API_KEY = "",    // ключ OpenRouter; в toml его не кладём
} = env;

const LOCAL_CONFIG_FILE = join(ROOT, PR_AGENT_LOCAL_CONFIG);
export const LOCAL_CONFIG_NAME = PR_AGENT_LOCAL_CONFIG;

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

function sectionNode(root, parts) {
  let node = root;
  for (const part of parts) node = node[part];
  return node;
}

// "custom_labels.\"Bug fix\"" → ["custom_labels", "Bug fix"]
function splitSectionName(name, where) {
  const parts = [];
  let cur = "", quote = null;
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ".") { parts.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  parts.push(cur.trim());
  if (quote || parts.some((p) => !p)) throw new Error(`${where}: некорректное имя секции «${name}»`);
  return parts;
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
      sectionNode(result, section)[pending.key] = parseTomlValue(pending.text, where);
      pending = null;
      continue;
    }
    if (!line) continue;

    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      // [section] или вложенная [section.sub] / [section."sub with spaces"]
      const parts = splitSectionName(sec[1].trim(), where);
      section = parts;
      let node = result;
      for (const part of parts) node = (node[part] ??= {});
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
    sectionNode(result, section)[key] = parseTomlValue(valueText, where);
  }
  if (pending) throw new Error(`${fileName}: незакрытый массив у ключа «${pending.key}»`);
  return result;
}

function loadLocalPrAgentArgs() {
  if (!existsSync(LOCAL_CONFIG_FILE)) return [];
  let config;
  try {
    config = parseTomlSubset(readFileSync(LOCAL_CONFIG_FILE, "utf8"), PR_AGENT_LOCAL_CONFIG);
  } catch (err) {
    console.error(`Ошибка в ${PR_AGENT_LOCAL_CONFIG}: ${err.message}`);
    process.exit(1);
  }
  const args = [];
  for (const [section, keys] of Object.entries(config)) {
    // Секция с вложенными таблицами (например [custom_labels."bug fix"]) передаётся целиком
    // одним JSON-аргументом: имена вложенных ключей могут содержать пробелы и точки,
    // через `--section.key=` их не передать.
    const isPlainObject = (v) => v && typeof v === "object" && !Array.isArray(v);
    if (Object.values(keys).some(isPlainObject)) {
      args.push(`--${section}=${JSON.stringify(keys)}`);
      continue;
    }
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
export const BUILTIN_PR_AGENT_ARGS = ["--config.propagate_tool_errors=true"];
export const PR_AGENT_ARGS = [...BUILTIN_PR_AGENT_ARGS, ...loadLocalPrAgentArgs()];

// ---------- pr-agent ----------
// pr-agent CLI (кроме самых свежих версий с propagate_tool_errors) при провале печатает
// help и выходит с кодом 0, поэтому успех определяем ещё и по маркерам в логе.
const PR_AGENT_FAILURE_MARKERS = [
  /Failed to process the command/,
  /Failed to generate prediction with any model/,
  /Failed to review PR/,
  /Error generating PR description/,
  /Failed to generate code suggestions/,
  /Traceback \(most recent call last\)/,
];

export function runPrAgent(prUrl, command) {
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
        // ключ OpenRouter (если задан): pr-agent читает его как настройку openrouter.key,
        // litellm — как OPENROUTER_API_KEY; кладём оба
        ...(OPENROUTER_API_KEY ? { OPENROUTER__KEY: OPENROUTER_API_KEY, OPENROUTER_API_KEY } : {}),
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
