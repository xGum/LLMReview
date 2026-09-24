# Развёртывание на сервере (Ubuntu 24.04, systemd)

Ниже — под Hostinger KVM 1 (1 vCPU, 4 ГБ) или любой другой Ubuntu/Debian VPS. GPU не нужна:
модель — через OpenRouter. Путь установки `/opt/pr-review-bot`, сервисный пользователь `prbot`;
если хочешь другие — поправь их в `deploy/pr-review-bot.service` и в командах ниже.

## 1. Базовые пакеты

```bash
sudo apt update && sudo apt install -y git curl python3 python3-venv python3-pip
```

Node.js 22 LTS (в репозиториях Ubuntu версия старая):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v22.x
```

Часовой пояс сервера — чтобы недельный дайджест стартовал в понедельник по местному времени:

```bash
sudo timedatectl set-timezone Europe/Istanbul
```

## 2. Пользователь и код

```bash
sudo useradd --system --create-home --home-dir /opt/pr-review-bot --shell /usr/sbin/nologin prbot
sudo -u prbot git clone https://github.com/xGum/llm_review.git /opt/pr-review-bot/src
# если репозиторий приватный — клонируй по deploy key или скопируй папку через scp
sudo -u prbot bash -c 'cd /opt/pr-review-bot && shopt -s dotglob && mv src/* . && rmdir src'
```

(Можно и проще: `scp -r C:\Projects\llm_review\* user@server:/tmp/bot && sudo mv ...` — код без
`node_modules`, зависимостей у поллера нет.)

## 3. pr-agent в виртуальном окружении

```bash
sudo -u prbot python3 -m venv /opt/pr-review-bot/.venv
sudo -u prbot /opt/pr-review-bot/.venv/bin/pip install --upgrade pip
# Ставим с GitHub, а не с PyPI: релиз на PyPI (0.2.4) сильно отстаёт от main,
# в нём нет propagate_tool_errors и исправления слияния списков в Dynaconf.
sudo -u prbot /opt/pr-review-bot/.venv/bin/pip install "git+https://github.com/qodo-ai/pr-agent.git"
cd /opt/pr-review-bot && sudo -u prbot .venv/bin/python -m pr_agent.cli --help | head -3
```

Проверять обязательно из `/opt/pr-review-bot`: pr-agent при старте ищет `.git` вверх от текущей
папки, и из `/root` пользователь `prbot` получит `Permission denied: '/root/.git'`. Сервису это
не грозит — у юнита задан `WorkingDirectory`.

Чтобы обновления pr-agent не ломали бота внезапно, можно зафиксировать коммит:
`pip install "git+https://github.com/qodo-ai/pr-agent.git@<sha>"`.

## 4. Конфигурация

```bash
sudo -u prbot cp /opt/pr-review-bot/.env.example /opt/pr-review-bot/.env
sudo -u prbot nano /opt/pr-review-bot/.env
sudo chmod 600 /opt/pr-review-bot/.env
```

Обязательно в `.env`:

```
GITHUB_TOKEN=ghp_...                                  # classic PAT, scope repo
REPOS=xGum/Lazar, xGum/LazarCart, xGum/LazarReact, Azshar/DeliDrive
PYTHON_CMD=/opt/pr-review-bot/.venv/bin/python        # python из venv, не системный
PR_AGENT_LOCAL_CONFIG=pr_agent.local.openrouter.toml
OPENROUTER_API_KEY=sk-or-...
SUMMARY_PROVIDER=openrouter
RELEASE_NOTES_DIR=release-notes
```

Проверка вручную от имени сервисного пользователя (dry-run ничего не пишет и модель не зовёт):

```bash
cd /opt/pr-review-bot
sudo -u prbot node weekly-summary.mjs --days 7 --dry-run
sudo -u prbot timeout 60 node poller.mjs      # должен показать репозитории и открытые PR, Ctrl+C
```

Если переносишь бота с Windows — скопируй ещё `state.json`, иначе поллер посчитает все открытые
PR новыми и прогонит их через модель заново (это не страшно, просто лишние запросы).

## 5. Автостарт через systemd

```bash
sudo cp /opt/pr-review-bot/deploy/pr-review-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pr-review-bot
sudo systemctl status pr-review-bot
```

Логи (поллер пишет в stdout, systemd складывает в journald):

```bash
sudo journalctl -u pr-review-bot -f            # хвост в реальном времени
sudo journalctl -u pr-review-bot --since today # за сегодня
sudo journalctl -u pr-review-bot -p err        # только ошибки
```

Управление:

```bash
sudo systemctl restart pr-review-bot   # после правки .env или pr_agent.local.*.toml
sudo systemctl stop pr-review-bot
sudo systemctl disable --now pr-review-bot   # убрать из автостарта
```

Ручной запуск дайджеста на сервере (не мешает работающему сервису):

```bash
cd /opt/pr-review-bot && sudo -u prbot node weekly-summary.mjs --days 7
```

## 6. Обновление кода

```bash
cd /opt/pr-review-bot
sudo -u prbot git pull
sudo systemctl restart pr-review-bot
```

Обновление pr-agent:

```bash
sudo -u prbot /opt/pr-review-bot/.venv/bin/pip install --upgrade "git+https://github.com/qodo-ai/pr-agent.git"
sudo systemctl restart pr-review-bot
```

## 7. Где лежат дайджесты

`/opt/pr-review-bot/release-notes/<период>/` — папка на сервере. Забрать на свою машину:

```bash
scp -r user@server:/opt/pr-review-bot/release-notes ./release-notes
```

Если удобнее хранить историю в git — можно раз в неделю коммитить папку с сервера, но проще
держать бота на сервере, а дайджесты смотреть по `scp` или через `cat` в SSH.

## Если что-то не так

- **`status` показывает `activating (auto-restart)`** — сервис падает на старте; смотри
  `journalctl -u pr-review-bot -n 50`. Чаще всего: нет `.env`, неверный `PYTHON_CMD`, права на папку.
- **`spawn python ENOENT` / «Не удалось запустить PYTHON_CMD»** — в `.env` нет или неверный
  `PYTHON_CMD`; должен быть `/opt/pr-review-bot/.venv/bin/python` (в Ubuntu команды `python` нет,
  а системный `python3` без pr-agent не подойдёт). Поллер проверяет это при старте.
- **`PermissionError: '/root/.git'` при ручной проверке** — команда запущена не из папки бота;
  сначала `cd /opt/pr-review-bot`.
- **Права**: всё в `/opt/pr-review-bot` должно принадлежать `prbot`
  (`sudo chown -R prbot:prbot /opt/pr-review-bot`), иначе не запишутся `state.json` и дайджесты.
- **Дайджест стартует не в то время** — проверь `timedatectl` и `Environment=TZ=` в юните;
  `WEEKLY_SUMMARY_DAY/HOUR` считаются по локальному времени процесса.
