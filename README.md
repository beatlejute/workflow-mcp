# workflow-mcp

MCP-сервер к [workflow-ai](https://www.npmjs.com/package/workflow-ai).

workflow-ai — канбан-пайплайн для AI-агентов: тикеты, планы, отчёты и скилы лежат в `.workflow/` каждого проекта, раннер `workflow run` ведёт тикеты по стадиям. workflow-mcp даёт MCP-клиенту (Claude Code и другим) доступ к этому сразу по всем проектам рабочей области: запуск и контроль пайплайнов, тикеты, планы, human-очередь, отчёты, git, аналитика, мониторинг здоровья.

Без workflow-ai сервер не работает: он запускает его раннер и работает с тикетами, планами и скилами его же модулями.

- [Связь с workflow-ai](#связь-с-workflow-ai)
- [Требования](#требования)
- [Установка и подключение](#установка-и-подключение)
- [Рабочая область и проекты](#рабочая-область-и-проекты)
- [Инструменты](#инструменты)
- [Ресурсы](#ресурсы)
- [Мониторинг здоровья](#мониторинг-здоровья)
- [Конфигурация](#конфигурация)
- [Разработка](#разработка)

## Связь с workflow-ai

workflow-ai — зависимость пакета (`dependencies` в `package.json`). Из него сервер берёт:

| Что | Где используется |
|-----|------------------|
| Раннер `bin/workflow.mjs` | `start_pipeline` запускает его отдельным процессом. Путь можно задать явно переменной `WORKFLOW_AI_BIN` |
| Модули `workflow-ai/lib/operations/{tickets,plans,skills}.mjs` и `lib/utils.mjs` | Тикеты, планы и скилы (`move_ticket`, `create_ticket`, `list_plans`, `list_skills` и другие) — по тем же правилам, что у раннера |
| `SKILL.md` скилов и шаблоны тикета, плана, отчёта | Ресурсы `workflow://skills/…` и `workflow://templates/…` |

В проектах нужна структура `.workflow/`, которую создаёт `workflow init`. `run_skill_tests` вызывает скрипт проекта `.workflow/src/scripts/run-skill-tests.js`.

**Версия.** При старте сервер сверяет установленный workflow-ai с диапазоном из `package.json` (сейчас `^1.7.4`):

- workflow-ai не найден — сервер не стартует: `FATAL: workflow-ai not found. Run npm install.`;
- другая мажорная версия — не стартует;
- версия ниже диапазона в пределах мажорной — стартует с предупреждением в stderr.

Обновление workflow-ai: `npm install workflow-ai@<версия>` в каталоге сервера, затем переподключить сервер в клиенте (в Claude Code — `/mcp`).

## Требования

- Node.js и npm.
- workflow-ai — ставится вместе с зависимостями сервера.
- Внешние программы — только для части инструментов:

| Программа | Нужна для |
|-----------|-----------|
| `git` | `git_*` и детектора `branch_diverged` |
| `gh` ([GitHub CLI](https://cli.github.com)) | только `git_open_pr` |
| `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep)) | только `cross_project_search` |
| `pssuspend.exe` ([PsTools](https://learn.microsoft.com/sysinternals/downloads/pssuspend)), только Windows | `pause_pipeline` и `resume_pipeline`; без неё — `PAUSE_UNSUPPORTED` |

## Установка и подключение

Имя `workflow-mcp` в npm занято чужим пакетом — сервер ставится из репозитория:

```bash
git clone https://github.com/beatlejute/workflow-mcp.git
cd workflow-mcp
npm install
```

Сервер работает по stdio. Запуск — `node bin/server.mjs [--root <каталог>]`, где `--root` — корень рабочей области (см. ниже).

Подключение к Claude Code — `.mcp.json` в корне рабочей области:

```json
{
  "mcpServers": {
    "workflow": {
      "command": "node",
      "args": ["D:\\Dev\\workflow-mcp\\bin\\server.mjs", "--root", "D:\\Dev"]
    }
  }
}
```

Эту запись можно создать командой из корня рабочей области: `node <путь>/workflow-mcp/bin/server.mjs --init-mcp-json`. Она добавляет или обновляет сервер `workflow` в `.mcp.json` текущего каталога, без `--root`.

После изменения кода сервера или обновления workflow-ai сервер нужно переподключить в клиенте.

## Рабочая область и проекты

**Корень рабочей области** — `MCP_CWD`, если переменная задана, иначе рабочий каталог процесса сервера (его меняет `--root`). От корня сервер ищет проекты, читает `.workflow-mcp.yaml` и считает каталог состояния по умолчанию. Рабочий каталог stdio-сервера выбирает клиент, поэтому корень лучше задать явно.

**Проекты** — прямые подкаталоги корня, в которых есть `.workflow/`. Если `.workflow/` лежит в самом корне, сервер работает в режиме одного проекта. Список сужают `projects.whitelist` и `projects.blacklist`.

**Параметр `project`** в инструментах резолвится двумя способами:

- `git_*` — только имя проекта из обнаруженных, абсолютный путь не принимается;
- остальные — путь относительно корня или абсолютный; проверяется, что в нём есть `.workflow/`.

Когда проекты — прямые подкаталоги корня, имя проекта подходит для всех инструментов. В режиме одного проекта `git_*` понимают только имя, остальные — только путь.

## Инструменты

37 инструментов. Сервер регистрирует всё, что экспортируют модули `src/tools/*.mjs` в форме инструмента (`name`, `description`, `inputSchema`, `execute`). Если модуль не загрузился (например, у слишком старого workflow-ai нет нужного модуля), сервер пишет в stderr, что список неполный, и перечисляет незагруженные файлы.

Параметры ниже: `?` — необязательный. У `get_pipeline_log`, `abort_pipeline` и `stop_pipeline` дополнительные параметры лежат во вложенном объекте `options`, у остальных — рядом с `project`.

```javascript
const run = await client.callTool('start_pipeline', { project: 'my-project', plan: 'PLAN-017' });
// { ok: true, run_id: 'pipeline_2026-09-19_14-30-00', pid: 12345, started_at: '…', log_path: '…' }

const log = await client.callTool('get_pipeline_log', {
  project: 'my-project',
  options: { tail_lines: 50, run_id: run.run_id }
});
```

### Пайплайн (7)

| Инструмент | Что делает |
|-----------|------------|
| `start_pipeline(project, plan?, config?)` | Запускает `workflow run` отдельным процессом. Ответ `{ok, run_id, pid, started_at, log_path}` |
| `get_pipeline_log(project, options: {tail_lines?, offset_bytes?, run_id?})` | Лог прогона с курсором. `tail_lines` по умолчанию 200, максимум 5000 (иначе `TOO_MANY_LINES`); без `run_id` — последний прогон |
| `list_running_pipelines()` | Идущие пайплайны по всем проектам: состояние, стадия, шаг, `awaiting_approval`, владение |
| `pause_pipeline(project)` | Приостанавливает раннер: `SIGSTOP` на POSIX, `pssuspend.exe` на Windows. Повторный вызов — `ALREADY_PAUSED` |
| `resume_pipeline(project)` | Снимает паузу: `SIGCONT` / `pssuspend -r` |
| `abort_pipeline(project, options: {grace_sec?})` | Мягкая остановка: `SIGINT`, ожидание, затем `SIGTERM`. `grace_sec` от 0 до 60, по умолчанию 10. Ответ `{ok, pid, state: 'aborted', duration_ms, escalated}` |
| `stop_pipeline(project, options: {force?})` | Жёсткая остановка: `SIGKILL` / `taskkill /F /T` |

**`start_pipeline`.** Единственный запуск на проект держит сам раннер через `.workflow/logs/.pipeline.lock`:

- lock живого раннера — `ALREADY_RUNNING`;
- lock мёртвого процесса снимается автоматически;
- pid из lock'а жив, но процесс стартовал позже записи lock'а — это посторонний процесс с тем же номером: `STALE_PIPELINE_LOCK`, lock остаётся, удаляет его человек;
- ОС не отдала время старта процесса — в ответе `start_time_unknown: true`, решение за человеком;
- лог не появился за 10 секунд — `RUNNER_NO_LOG`.

**Состояния в `list_running_pipelines`.** В списке — проекты с живым lock'ом. Раннер снимает lock при любом упорядоченном выходе, поэтому завершённый прогон из списка исчезает; состояния `completed` нет.

| `state` | Значение |
|---------|----------|
| `running` | pid раннера жив |
| `paused` | файл паузы с тем же pid или ожидающее одобрение |
| `aborting` | идёт `abort_pipeline`, раннер ещё жив (`.workflow/state/abort-state.json`). На Windows мягкий `taskkill` консольному процессу ничего не делает, и состояние держится всё grace-окно |
| `killed` | pid мёртв, lock остался, остановку сделал этот сервер (`stop_pipeline` или эскалация `abort_pipeline`, запись в `.workflow/state/last-kill.json`); кто добивал — в `killed_by` |
| `stale` | раннера нет: pid мёртв по неизвестной причине, или номер занят посторонним процессом (`pid_reused: true`) |

У `killed` и `stale` стоит `stale_lock` — lock нужно убрать.

### Владение пайплайном

`pause`, `resume`, `abort` и `stop` управляют только пайплайном, который запустила эта рабочая область. Владение привязано к запуску, а не к процессу сервера, и переживает перезапуск клиента. Всё для проверки лежит в `.workflow/logs/.pipeline.lock`, который пишет раннер:

| Поле lock'а | Проверка | Отказ |
|-------------|----------|-------|
| `pid` | сигнал уходит номеру, который записал раннер | `PID_MISMATCH` |
| `started_by` | запуск из CLI или расширения VS Code — не свой | `STARTED_BY_MISMATCH` |
| `started_by_id` | метка рабочей области: `start_pipeline` передаёт её раннеру в `WORKFLOW_STARTED_BY_ID` | чужая — `INSTANCE_MISMATCH`, нет метки — `INSTANCE_UNKNOWN` |
| время старта процесса | раннер стартовал не позже записи lock'а (`Get-Process` на Windows, `ps -o lstart=` на POSIX) | `PID_REUSED` |

Метку `started_by_id` пишет раннер workflow-ai с версии 1.7.0. Раннер 1.6.x её не пишет, и запуск помечается `INSTANCE_UNKNOWN`: доказательства владения нет, поэтому в списке он `foreign`. `start_pipeline` предупреждает об этом сразу: `warning: 'RUNNER_WITHOUT_INSTANCE_ID'`.

Если ОС не отдала время старта, проверка пропускается. Ответ ОС помнится минуту, но только для чтения состояния — перед сигналом он запрашивается заново.

Обойти проверку владения можно `force: true` у `stop_pipeline` или переменной `WORKFLOW_MCP_FORCE_FOREIGN=1`. Ни то ни другое не снимает `STALE_PIPELINE_LOCK`: номер из lock'а принадлежит постороннему процессу, и сигнал ушёл бы ему. Это верно для всех четырёх операций и для эскалации внутри grace-окна `abort_pipeline`. Такой lock удаляют руками — сервер его не трогает ни в `stop_pipeline`, ни в `start_pipeline`, чтобы ошибка проверки не подняла второй пайплайн поверх живого.

Отказ проверки у `pause_pipeline` и `resume_pipeline` приходит кодом `OWNERSHIP_VALIDATION_FAILED`. Если владение потеряно за grace-окно `abort_pipeline` — `OWNERSHIP_LOST`.

**Цена проверки.** Проверка «процесс жив» — `tasklist` на Windows (около 110 мс на номер, ответ помнится секунду), `kill(pid, 0)` на POSIX. Обход проектов синхронный: пока он идёт, сервер не отвечает клиенту.

### Одобрения, диагностика, отчёты (5)

| Инструмент | Что делает |
|-----------|------------|
| `approve_step(project, step_id, decision, comment?, decided_by?)` | Решение по manual-gate стадии: `decision` — `approve` или `reject`, `comment` до 1000 символов, `decided_by` по умолчанию `mcp-client`. Пишет `.workflow/approvals/{step_id}.json`. `step_id` можно задать префиксом: подходит один ожидающий шаг — берётся он, несколько — `AMBIGUOUS_STEP_ID` со списком. Повторное решение — `ALREADY_DECIDED` |
| `list_blocked_tickets(project?)` | Тикеты из `blocked/` по всем проектам или по одному |
| `list_ghost_executions(project?, since?)` | Строки `[GHOST-EXECUTION]` в логах пайплайна (маркер задаёт `health.ghost_execution_log_marker`); `since` — ISO 8601. Маркер печатает `verify-artifacts` из workflow-ai, когда заявленные в тикете файлы не менялись после его начала или заявленного экспорта в модуле нет |
| `list_reports(project, since?, limit?)` | Отчёты проекта, новые первыми; `limit` по умолчанию 50 |
| `get_report(project, report_id)` | Один отчёт: `{frontmatter, body, path}` |

### Тикеты, планы, скилы, human-очередь (11)

| Инструмент | Что делает |
|-----------|------------|
| `list_tickets(project, status?, plan_id?, priority?, type?)` | Тикеты с фильтрами. `status` — каталог: `backlog`, `ready`, `in-progress`, `review`, `blocked`, `done`, `archive`; без него — все |
| `get_ticket(project, ticket_id)` | `{frontmatter, body, status_from_dir, path}`; статус — по каталогу, а не по frontmatter |
| `create_ticket(project, type, title, priority?, plan_id?, body?)` | Тикет в `backlog/`. `priority` — число, 1 — высший, по умолчанию 3. У `type: 'human'` в frontmatter добавляется `executor_type: human` |
| `move_ticket(project, ticket_id, target)` | Перенос в другой статус с проверкой допустимости перехода |
| `pick_next_ticket(project)` | Следующий тикет в работу по правилам проекта |
| `list_plans(project, status?)` | Планы: `draft`, `approved`, `active`, `completed`, `archived` |
| `get_plan(project, plan_id)` | План с телом и тикетами — обычными и human отдельно |
| `list_skills(project?)` | Скилы проекта: общие из установки workflow-ai (`shared`) и скопированные в проект (`ejected`); без `project` — только общие |
| `list_human_queue(project?, status?)` | HUMAN-тикеты по всем проектам или по одному, по приоритету и возрасту |
| `get_human_context(project, ticket_id)` | HUMAN-тикет с планом, зависимостями, связанными отчётами и шагами пайплайна |
| `resolve_human_ticket(project, ticket_id, decision, result_body, next_status?, strict?)` | Дописывает результат и переводит тикет в следующий статус (по умолчанию `done`). `strict` включает строгую проверку результата на этот вызов (см. [Проверка результата human-тикета](#проверка-результата-human-тикета)) |

### Проект и аналитика (5)

Метрики считаются по frontmatter тикетов, отдельного хранилища нет.

| Инструмент | Что делает |
|-----------|------------|
| `get_project_status(project)` | Счётчики тикетов по статусам, активный план, последние шаги пайплайна, висящие human-задачи |
| `get_velocity(project, window_days?, group_by?)` | Завершённые тикеты по дням или неделям |
| `get_cycle_time(project, window_days?, percentiles?)` | Время от создания тикета до завершения: перцентили (по умолчанию p50, p90) и среднее, в секундах |
| `get_ticket_stats(project, window_days?)` | Распределение по статусам и типам, 10 дольше всех заблокированных тикетов |
| `aggregate_metrics(projects?, window_days?)` | Velocity, cycle time и статистика по нескольким проектам |

### Git (5)

Нужен `git`; для `git_open_pr` — ещё `gh`. Таймаут git-команд — `GIT_TIMEOUT` в мс, по умолчанию 30000.

| Инструмент | Что делает |
|-----------|------------|
| `git_status(project)` | Ветка, ahead/behind, изменённые, staged, неотслеживаемые и конфликтные файлы |
| `git_create_branch(project, name, from?, switch?)` | Новая ветка, при `switch` — с переключением; незакоммиченные изменения при переключении защищены |
| `git_diff(project, staged?, path?, max_lines?)` | Diff с фильтром по пути и лимитом строк; бинарные файлы помечаются `[binary]` |
| `git_commit(project, message, paths?, co_authors?)` | Коммит staged-изменений или явных путей. `git add -A` не делает никогда. `message` — 1–5000 символов |
| `git_open_pr(project, title, body?, base?, head?, draft?)` | Pull request через `gh`. Проверяет чистое дерево и запушенную ветку |

### Скилы и коуч (3)

| Инструмент | Что делает |
|-----------|------------|
| `list_skill_tests(project, skill_name?)` | Тест-кейсы скила из `index.yaml`, ничего не запускает |
| `run_skill_tests(project, skill_name, test_ids?, parallel?, timeout_sec?)` | Прогон тестов скила скриптом проекта `.workflow/src/scripts/run-skill-tests.js`; нет скрипта — `SCRIPT_NOT_FOUND` |
| `create_coach_ticket(project, target_skill, gap_description, evidence_path?, priority?)` | Тикет коуча на улучшение скила |

### Поиск (1)

| Инструмент | Что делает |
|-----------|------------|
| `cross_project_search(query, projects?, type?, max_results?)` | Поиск кода по проектам через ripgrep: файл, строка, фрагмент |

## Ресурсы

| URI | Содержимое | Подписка |
|-----|-----------|----------|
| `workflow://pipeline-state` | Идущие пайплайны по всем проектам — те же данные, что `list_running_pipelines`. Строится заново на каждое чтение | да |
| `workflow://alerts` | Что не так сейчас: детекторы здоровья прогоняются на каждое чтение | да |
| `workflow://alerts/history` | Опубликованные алерты из `alerts-history.jsonl`; параметр `since` | — |
| `workflow://human-queue` | HUMAN-тикеты по всем проектам | да |
| `workflow://<проект>/logs/pipeline/latest` | Последний лог пайплайна с курсором для чтения по мере записи | да |
| `workflow://<проект>/config/pipeline` | `pipeline.yaml` проекта | — |
| `workflow://<проект>/config/ticket-movement-rules` | Правила движения тикетов проекта | — |
| `project://<проект>` | Запись проекта из обнаружения | — |
| `workflow://skills/<скил>/SKILL.md` | `SKILL.md` скила из установленного workflow-ai | — |
| `workflow://templates/{ticket,plan,report}` | Шаблоны из установленного workflow-ai | — |

Подписка — `resources/subscribe` и `resources/unsubscribe`. Уведомление `resources/updated` уходит только по URI, на которые клиент подписан; изменения внутри `notifications.coalesce_window_ms` (по умолчанию 200 мс) схлопываются в одно.

## Мониторинг здоровья

Служба здоровья стартует вместе с сервером и раз в `health.tick_interval_sec` (по умолчанию 15 с) прогоняет детекторы по всем проектам:

| Тип алерта | Условие |
|-----------|---------|
| `crashed` | процесс раннера умер, а лог свежий |
| `stuck` | стадия идёт дольше своего таймаута плюс `stuck_headroom_sec`; только у проектов с живым lock'ом |
| `stage_error` | последний завершённый шаг в свежем логе закончился ошибкой или ненулевым кодом выхода |
| `retry_loop` | задача дошла до последней попытки: счётчик `task_attempts` из `pipeline.yaml` на единицу меньше лимита |
| `blocked_accumulation` | в `blocked/` накопилось `blocked_accumulation_threshold` тикетов и больше |
| `approval_pending` | одобрение ждёт дольше `approval_pending_threshold_sec` |
| `branch_diverged` | ветка отстала или ушла вперёд от upstream больше порога; только проекты со своим `.git` |
| `ghost_execution` | в логе есть `[GHOST-EXECUTION]` |

- `workflow://alerts` отвечает, что не так сейчас: разрешившееся условие сразу исчезает из ответа.
- Опубликованные алерты пишутся в `alerts-history.jsonl` каталога состояния (`workflow://alerts/history`). Повторы в пределах `dedup_fingerprint_ttl_sec` (по умолчанию час) глушатся.
- Подписчик `workflow://alerts` получает уведомление, когда набор условий меняется, — с отставанием не больше одного тика.

Обход синхронный: на проект с живым lock'ом — вызов `tasklist`, на git-проект — `git status`, при `branch_diverged_auto_fetch: true` ещё и `git fetch`; таймаут у каждого 5 секунд. Пока идёт обход, сервер не отвечает клиенту. Обход короче только при меньшем числе проектов (`projects.whitelist`); `tick_interval_sec` делает обходы реже, но не короче.

Выключается целиком: `health.enabled: false`.

## Конфигурация

### `.workflow-mcp.yaml`

Файл в корне рабочей области, необязательный: без него работают значения по умолчанию. Все ключи с умолчаниями и пояснениями — в [`.workflow-mcp.yaml.example`](.workflow-mcp.yaml.example). Ключи, которых код не читает, молча игнорируются.

| Секция | Что задаёт |
|--------|-----------|
| `projects.whitelist`, `projects.blacklist` | какие проекты видит сервер |
| `discovery.depth`, `discovery.debounce_sec` | поиск проектов; реализована только глубина 1 |
| `state.dir` | каталог состояния |
| `health.*` | служба здоровья и пороги детекторов |
| `notifications.coalesce_window_ms` | окно схлопывания уведомлений |
| `human_ticket.*` | проверка результата human-тикета; читается из корня проекта, а не рабочей области |

### Переменные окружения

| Переменная | Назначение |
|-----------|------------|
| `MCP_CWD` | корень рабочей области вместо рабочего каталога процесса |
| `WORKFLOW_AI_BIN` | путь к `bin/workflow.mjs` раннера в обход установленного пакета |
| `WORKFLOW_STATE_DIR` | каталог состояния; перекрывает `state.dir` и забирает всё состояние сервера |
| `WORKFLOW_STATE_MODE` | `writable` или `read-only` для каталога из `WORKFLOW_STATE_DIR` |
| `WORKFLOW_MCP_FORCE_FOREIGN` | `1` — управлять чужим пайплайном (кроме `STALE_PIPELINE_LOCK`) |
| `WORKFLOW_MCP_FORCE_POLLING` | `1` — наблюдатели за файлами опрашивают вместо `fs.watch` |
| `GIT_TIMEOUT` | таймаут git-команд, мс, по умолчанию 30000 |
| `WORKFLOW_AI_RESOLVE_PATH` | база поиска пакета workflow-ai; для тестов |

### Каталог состояния

Там лежит история алертов. Порядок выбора:

1. `WORKFLOW_STATE_DIR`;
2. `state.dir` из конфига — абсолютный путь или относительный от корня;
3. по умолчанию — `%LOCALAPPDATA%\workflow-mcp\<хеш корня>` на Windows, `$XDG_STATE_HOME/workflow-mcp/<хеш корня>` (или `~/.local/state/…`) на POSIX.

Если корень — защищённое место (корень диска, `C:\Users`, домашний каталог) и каталог не задан явно, запись состояния отключается. Каталог создаётся первой записью, а не запуском. На Windows регистр пути в хеш не входит: `d:\Dev` и `D:\Dev` — одна рабочая область.

### Проверка результата human-тикета

По умолчанию проверка мягкая. Строгая включается для всех вызовов в `.workflow-mcp.yaml` проекта или для одного вызова `resolve_human_ticket` параметром `strict: true`:

```yaml
human_ticket:
  strict_validation: true   # по умолчанию false
  min_result_length: 50     # минимальная длина результата
  evidence_required: true   # нужен пруф: ссылка, путь к файлу или блок кода
```

Свои правила — файл `human-task-rules.md` в корне проекта, по правилу на строку: `- rule: <регулярное выражение> | <сообщение>`. Строгая проверка применяет их вместе со стандартными.

## Разработка

```bash
npx vitest run   # тесты один раз; npm test запускает vitest в режиме наблюдения
```

| Каталог | Что там |
|---------|---------|
| `bin/server.mjs` | точка входа: `--root`, `--init-mcp-json`, `--help` |
| `src/server.mjs` | регистрация инструментов, ресурсов, подписок, проверка версии workflow-ai |
| `src/tools/` | инструменты; каждый экспорт с `name`, `description`, `inputSchema`, `execute` регистрируется сам |
| `src/resources/` | ресурсы |
| `src/health/` | служба здоровья и детекторы |
| `src/process/` | lock раннера, владение, сигналы, пауза |
| `src/lib/workflow-ai.mjs` | поиск установленного workflow-ai |

История изменений — [CHANGELOG.md](CHANGELOG.md). Руководства по переходу на 1.1.0 и 1.2.0 — [MIGRATION.md](MIGRATION.md).
