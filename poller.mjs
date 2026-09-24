// PR Review Bot — локальный поллер
// Следит за открытыми PR в базовую ветку в нескольких репозиториях,
// при новых коммитах запускает pr-agent (describe + review [+ improve]) через локальную LLM (Ollama).
// Раз в неделю собирает релиз-дайджест для бизнеса (см. weekly-summary.mjs).
// Node 18+, без зависимостей.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadEnv, parseRepos, githubJson, ymd } from "./common.mjs";
import { runWeeklySummary, previousFullWeek } from "./weekly-summary.mjs";
import { runPrAgent, PR_AGENT_ARGS, BUILTIN_PR_AGENT_ARGS, LOCAL_CONFIG_NAME, checkPrAgentInstalled } from "./pr-agent.mjs";

const STATE_FILE = join(ROOT, "state.json");

const env = loadEnv();
const {
  GITHUB_TOKEN,               // один токен на все репозитории
  REPOS,                      // "owner/repo1, owner/repo2:develop, owner/repo3"
  REPO,                       // старый формат: один "owner/repo" (для совместимости)
  BASE_BRANCH = "master",     // ветка по умолчанию, если у репо не указана своя
  POLL_MINUTES = "5",
  SKIP_DRAFTS = "true",
  PR_AGENT_COMMANDS = "describe,review", // команды pr-agent по порядку; например describe,review,improve
  WEEKLY_SUMMARY = "true",          // собирать релиз-дайджест раз в неделю
  WEEKLY_SUMMARY_DAY = "1",         // день недели: 1 = понедельник … 7 = воскресенье
  WEEKLY_SUMMARY_HOUR = "9",        // начиная с какого часа (локальное время)
  WEEKLY_SUMMARY_MAX_ATTEMPTS = "3", // после стольких неудач собрать дайджест даже без саммари у части PR
  AUTO_APPROVE = "false",           // ставить предварительный approve, если ревью без замечаний
  AUTO_APPROVE_MAX_EFFORT = "3",    // и оценка усилий на ревью не выше этой (1–5); 0 — не учитывать
} = env;

const COMMANDS = PR_AGENT_COMMANDS.split(/[,;\s]+/).map((c) => c.trim().replace(/^\//, "")).filter(Boolean);
if (COMMANDS.length === 0) {
  console.error("PR_AGENT_COMMANDS пуст — нужна хотя бы одна команда (describe, review, improve...).");
  process.exit(1);
}

const REPO_LIST = parseRepos(REPOS || REPO, BASE_BRANCH);

if (!GITHUB_TOKEN || REPO_LIST.length === 0) {
  console.error("В .env обязательны GITHUB_TOKEN и REPOS (список owner/repo через запятую).");
  process.exit(1);
}

// ---------- state ----------
// Формат: { "owner/repo": { "<номер PR>": "<head sha>" } }
function loadState() {
  let state;
  try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
  if (!state || typeof state !== "object") return {};

  // миграция старого плоского формата { "<номер PR>": "<sha>" } → привязываем к первому репо
  const values = Object.entries(state).filter(([k]) => !k.startsWith("_")).map(([, v]) => v);
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
function listOpenPRs(repo) {
  return githubJson(
    `/repos/${repo.fullName}/pulls?base=${encodeURIComponent(repo.branch)}&state=open&per_page=50`,
    GITHUB_TOKEN,
  );
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

    // команды последовательно (одна GPU — один запрос за раз);
    // на первом провале останавливаемся — остальные почти наверняка упадут так же
    let allOk = true;
    for (const command of COMMANDS) {
      if (!(await runPrAgent(pr.html_url, command))) { allOk = false; break; }
    }

    if (allOk) {
      repoState[pr.number] = headSha;
      saveState(state);
      console.log(`  ✓ ${repo.fullName}#${pr.number} обработан`);
      if (AUTO_APPROVE === "true" && COMMANDS.includes("review")) {
        try { await autoApprove(repo, pr); }
        catch (err) { console.error(`  ✗ автоапрув ${repo.fullName}#${pr.number}: ${err.message}`); }
      }
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

// ---------- предварительный апрув ----------
// Читаем персистентный комментарий ревью pr-agent («PR Reviewer Guide») и смотрим на его
// статические маркеры (они на английском независимо от языка ответов модели):
//   «No major issues detected»          — ключевых проблем нет
//   «No security concerns identified»   — замечаний по безопасности нет
//   «Merge recommendation: Safe to merge» — если включён require_merge_recommendation
//   «Estimated effort to review: N»      — оценка усилий 1–5
// Всё чисто → ставим approve от имени владельца токена. Ревью нашло проблемы → снимаем
// наш прошлый approve (если был). Апрув на тот же head SHA повторно не ставим.

const REVIEW_HEADING = "PR Reviewer Guide";
const APPROVE_MARKER = "<!-- pr-review-bot:auto-approve -->";
let botLogin = null;

function parseReviewVerdict(body) {
  const effort = body.match(/Estimated effort to review[^:]*:\s*(\d)/i);
  const rec = body.match(/Merge recommendation[^:]*:\s*([A-Za-z ]+)/i);
  return {
    noIssues: /No major issues detected/i.test(body),
    securityOk: /No security concerns identified/i.test(body),
    effort: effort ? Number(effort[1]) : null,
    mergeRecommendation: rec ? rec[1].trim().toLowerCase().replace(/\s+/g, "_") : null, // safe_to_merge | merge_with_caution | changes_required
  };
}

async function findReviewComment(repo, pr) {
  const comments = await githubJson(`/repos/${repo.fullName}/issues/${pr.number}/comments?per_page=100`, GITHUB_TOKEN);
  const reviews = comments.filter((c) => (c.body ?? "").includes(REVIEW_HEADING));
  reviews.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return reviews[0] ?? null;
}

async function autoApprove(repo, pr) {
  const tag = `${repo.fullName}#${pr.number}`;
  const comment = await findReviewComment(repo, pr);
  if (!comment) { console.log(`  · автоапрув ${tag}: комментарий ревью не найден, пропускаю`); return; }

  const v = parseReviewVerdict(comment.body);
  const maxEffort = Number(AUTO_APPROVE_MAX_EFFORT);
  const reasons = [];
  if (!v.noIssues) reasons.push("есть ключевые проблемы");
  if (!v.securityOk) reasons.push("есть замечания по безопасности");
  if (v.mergeRecommendation && v.mergeRecommendation !== "safe_to_merge") reasons.push(`рекомендация: ${v.mergeRecommendation}`);
  if (maxEffort > 0 && v.effort != null && v.effort > maxEffort) reasons.push(`оценка усилий ${v.effort} > ${maxEffort}`);
  const clean = reasons.length === 0;

  botLogin ??= (await githubJson("/user", GITHUB_TOKEN)).login;
  const reviews = await githubJson(`/repos/${repo.fullName}/pulls/${pr.number}/reviews?per_page=100`, GITHUB_TOKEN);
  const ourApprovals = reviews.filter((r) => r.user?.login === botLogin && r.state === "APPROVED");

  if (!clean) {
    console.log(`  · автоапрув ${tag}: не ставлю (${reasons.join(", ")})`);
    for (const r of ourApprovals) {
      await githubJson(`/repos/${repo.fullName}/pulls/${pr.number}/reviews/${r.id}/dismissals`, GITHUB_TOKEN, {
        method: "PUT",
        body: { message: `Предварительный апрув снят: новое автоматическое ревью нашло замечания (${reasons.join(", ")}).` },
      });
      console.log(`  ↩ автоапрув ${tag}: снял прошлый approve`);
    }
    return;
  }

  if (ourApprovals.some((r) => r.commit_id === pr.head.sha)) {
    console.log(`  · автоапрув ${tag}: approve на этот коммит уже стоит`);
    return;
  }
  const details = [
    "ключевых проблем нет",
    "замечаний по безопасности нет",
    v.effort != null ? `оценка усилий на ревью — ${v.effort}/5` : null,
    v.mergeRecommendation ? "рекомендация модели — safe to merge" : null,
  ].filter(Boolean).join(", ");
  try {
    await githubJson(`/repos/${repo.fullName}/pulls/${pr.number}/reviews`, GITHUB_TOKEN, {
      method: "POST",
      body: {
        event: "APPROVE",
        body: `${APPROVE_MARKER}\n✅ **Предварительный апрув от бота**\n\nАвтоматическое ревью не нашло замечаний: ${details}.\n\n_Это не заменяет ревью человека. Апрув снимается автоматически, если следующее ревью найдёт проблемы._`,
      },
    });
    console.log(`  ✅ автоапрув ${tag}: approve поставлен`);
  } catch (err) {
    if (err.status === 422 && /own pull request/i.test(err.message)) {
      console.log(`  · автоапрув ${tag}: GitHub не даёт апрувить собственный PR (автор — владелец токена)`);
      return;
    }
    throw err;
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
    if (!key.startsWith("_") && !tracked.has(key)) delete state[key];
  }
  saveState(state);

  await maybeRunWeeklySummary(state);
}

// ---------- еженедельный дайджест ----------
// Запускается один раз за неделю: в день WEEKLY_SUMMARY_DAY, начиная с часа WEEKLY_SUMMARY_HOUR,
// за прошлую полную неделю (пн–вс). Факт запуска хранится в state.json → _meta.lastWeeklySummary.
// Если бот был выключен в назначенный день, дайджест соберётся при первом же тике позже на той же неделе.
async function maybeRunWeeklySummary(state) {
  if (WEEKLY_SUMMARY !== "true") return;
  const now = new Date();
  const dow = ((now.getDay() + 6) % 7) + 1; // 1 = пн … 7 = вс
  if (dow < Number(WEEKLY_SUMMARY_DAY)) return;
  if (dow === Number(WEEKLY_SUMMARY_DAY) && now.getHours() < Number(WEEKLY_SUMMARY_HOUR)) return;

  const period = previousFullWeek(now);
  const key = ymd(period.from);
  const meta = (state._meta ??= {});
  if (meta.lastWeeklySummary === key) return;

  // счётчик неудачных попыток за эту неделю: если саммари для каких-то PR так и не получается
  // сгенерировать (или GitHub/Ollama недоступны), после MAX_ATTEMPTS собираем дайджест без них
  meta.weeklyAttempts ??= {};
  const attempts = meta.weeklyAttempts[key] ?? 0;
  const allowMissing = attempts >= Number(WEEKLY_SUMMARY_MAX_ATTEMPTS);

  console.log(`Пора собирать недельный дайджест за неделю с ${key}` +
    (allowMissing ? ` (попытка ${attempts + 1}, PR без саммари войдут как есть)` : ` (попытка ${attempts + 1})`));
  try {
    const result = await runWeeklySummary({ period, allowMissing });
    if (!result.ok) {
      meta.weeklyAttempts[key] = attempts + 1;
      saveState(state);
      console.error(`  ✗ дайджест не собран: ${result.reason}; попробую в следующем цикле`);
      return;
    }
    meta.lastWeeklySummary = key;
    delete meta.weeklyAttempts[key];
    saveState(state);
  } catch (err) {
    meta.weeklyAttempts[key] = attempts + 1;
    saveState(state);
    console.error(`  ✗ дайджест не собран: ${err.message}; попробую в следующем цикле`);
  }
}

async function main() {
  const intervalMs = Number(POLL_MINUTES) * 60_000;
  checkPrAgentInstalled();
  console.log(`PR Review Bot запущен, опрос каждые ${POLL_MINUTES} мин, команды: ${COMMANDS.join(" → ")}. Репозитории:`);
  if (AUTO_APPROVE === "true") {
    console.log(`Автоапрув: включён (ревью без замечаний${Number(AUTO_APPROVE_MAX_EFFORT) > 0 ? `, усилия ≤ ${AUTO_APPROVE_MAX_EFFORT}/5` : ""}).`);
  }
  if (WEEKLY_SUMMARY === "true") {
    const days = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
    console.log(`Недельный дайджест: ${days[Number(WEEKLY_SUMMARY_DAY) - 1] ?? "?"} после ${WEEKLY_SUMMARY_HOUR}:00 за прошлую неделю (ручной запуск: npm run summary).`);
  }
  for (const r of REPO_LIST) console.log(`  • ${r.fullName} → ${r.branch}`);
  const localArgs = PR_AGENT_ARGS.slice(BUILTIN_PR_AGENT_ARGS.length);
  if (localArgs.length) {
    console.log(`Локальные переопределения pr-agent (${LOCAL_CONFIG_NAME}), перекрывают .pr_agent.toml из репо:`);
    for (const a of localArgs) console.log(`  ${a}`);
  } else {
    console.log(`${LOCAL_CONFIG_NAME} не найден — используется только .pr_agent.toml из репозиториев.`);
  }
  for (;;) {
    await tick();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main();
