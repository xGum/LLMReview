// Общие утилиты поллера и еженедельного дайджеста.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = dirname(fileURLToPath(import.meta.url));

// ---------- .env ----------
export function loadEnv() {
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

// ---------- список репозиториев ----------
// Формат элемента: "owner/repo" или "owner/repo:branch".
// Разделители — запятая, точка с запятой или перенос строки.
export function parseRepos(raw, defaultBranch) {
  const repos = [];
  for (const item of (raw ?? "").split(/[,;\n]/)) {
    const s = item.trim();
    if (!s) continue;
    const [fullName, branch] = s.split(":");
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      console.error(`Некорректный репозиторий в .env: «${s}» (ожидается owner/repo или owner/repo:branch)`);
      process.exit(1);
    }
    repos.push({ fullName, branch: (branch || defaultBranch).trim() });
  }
  const seen = new Set();
  return repos.filter((r) => !seen.has(r.fullName) && seen.add(r.fullName));
}

// ---------- GitHub API ----------
export async function githubJson(pathOrUrl, token, { method = "GET", body } = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `https://api.github.com${pathOrUrl}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status}: ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

// ---------- даты ----------
export function pad2(n) { return String(n).padStart(2, "0"); }

// YYYY-MM-DD в локальном времени
export function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ISO 8601 с локальным смещением: 2026-09-08T00:00:00+03:00 (GitHub search такое понимает)
export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${ymd(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}
