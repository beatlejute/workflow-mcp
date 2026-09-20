# workflow-mcp — MCP-сервер для workflow-проектов

MCP-сервер, агрегирующий операции по нескольким workflow-ai проектам и обеспечивающий единое управление тикетами, планами и скилами.

## Что такое workflow-mcp

`workflow-mcp` — Node.js MCP-сервер, предоставляющий:
- управление несколькими проектами одновременно;
- поддержку human-first воркфлоу;
- мониторинг здоровья пайплайнов;
- единую конфигурацию.

## Новые возможности версии 1.4.0

### Health-мониторинг начал работать

Детекторы, дедуп алертов и ресурсы `workflow://alerts` и `workflow://alerts/history` существовали по отдельности, но не были связаны ничем: наблюдателя никто не запускал, и список алертов всегда был пуст. Теперь сервер поднимает службу здоровья при старте и останавливает при завершении.

Значения поля `type` — ровно те, по которым алерты можно фильтровать: `crashed` (процесс раннера умер, а лог свежий), `stuck` (стадия идёт дольше своего таймаута плюс запас), `stage_error`, `retry_loop`, `blocked_accumulation`, `approval_pending`, `branch_diverged`, `ghost_execution`.

Алерт пишется в `alerts-history.jsonl` в каталоге состояния и отдаётся ресурсом `workflow://alerts`. Уведомление `resources/updated` уходит только тем, кто подписался на этот URI (см. ниже). Повторы внутри `dedup_fingerprint_ttl_sec` глушатся.

`workflow://alerts` отвечает на вопрос «что не так сейчас»: на каждое чтение детекторы прогоняются заново по всем проектам рабочей области — тем же обходом, что и тик службы здоровья (`health/sweep.mjs`). Разрешившееся условие исчезает из списка сразу, дедуп по отпечатку к ответу не применяется: он глушит повторные уведомления, а не ответ на вопрос о текущем состоянии. Что публиковалось раньше — в `workflow://alerts/history`.

Цена чтения равна цене тика: на проект с живым lock'ом приходится вызов `tasklist`, на git-проект — `git status`, таймаут у каждого 5 секунд. Обход синхронный, и пока он идёт, сервер не отвечает клиенту.

Отключается целиком: `health.enabled: false`.

### Подписка на ресурсы

`resources/subscribe` и `resources/unsubscribe` реализованы. Прежде сервер отвечал на них `Method not found`, хотя три ресурса — `workflow://alerts`, `workflow://pipeline-state` и `workflow://human-queue` — числились подписываемыми и под них поднимались наблюдатели за файлами. Уведомления `resources/updated` уходят только по тем URI, на которые клиент подписался.

Оговорки:

- `workflow://pipeline-state` строится заново на каждое чтение, кеша снимка нет вовсе. Уведомление о подписке лишь просит клиента перечитать ресурс. Прежде снимок кешировался, а инвалидировали его только наблюдатели за файлами — встают они при подписке, и лог прогона их намеренно не будит: клиент без подписки видел первый снимок до конца жизни сервера, вплоть до `killed` от прошлого прогона, пока `list_running_pipelines` рядом отвечал `running`.

- Детекторы `crashed` и `stuck` определяли pid раннера по `.runner-pids` — файлу, которого не пишет никто, — и не срабатывали ни разу; теперь pid берётся из `.workflow/logs/.pipeline.lock`.
- Детектор `stuck` смотрит только на проекты с живым `.workflow/logs/.pipeline.lock`. Без него прогона нет вовсе, а прежде детектор брал самый свежий лог в каталоге и объявлял зависшей последнюю незакрытую стадию давно законченного прогона — в рабочей области так висел critical-алерт о прогоне полугодовой давности.
- Детектор `ghost_execution` по-прежнему молчит: маркер `[GHOST-EXECUTION]` в лог не пишет ни раннер, ни сервер, так что истинных срабатываний у него не будет до правки workflow-ai.
- Детектор `branch_diverged` не срабатывал никогда по другой причине: к `git status` дописывался флаг `--no-fetch`, которого у этой команды нет. Флаг убран; при `branch_diverged_auto_fetch: true` перед проверкой по-прежнему делается `git fetch`.
- Детектор `branch_diverged` смотрит только на проекты со своим `.git`. Проект внутри чужого репозитория (монорепо, `.git` у родителя) он пропускает: иначе на каждом не-репозитории раз в тик порождался бы процесс `git`.
- Обход проектов синхронный: на каждый тик приходится до одного вызова `tasklist` на проект с живым lock'ом и до одного `git status` на git-проект, каждый с таймаутом в 5 секунд. Пока идёт обход, сервер не отвечает клиенту. Длительность одного обхода уменьшает только сокращение списка проектов (`projects.whitelist`); `tick_interval_sec` делает обходы реже, но не короче.

## Новые возможности версии 1.3.0

### 14 инструментов, которых клиент не видел

Функции лежали в `src/tools/` незарегистрированными с первого коммита: `get_velocity`, `get_cycle_time`, `resolve_human_ticket`, `list_human_queue`, `get_human_context`, `list_plans`, `get_plan`, `get_project_status`, `list_skills`, `list_tickets`, `get_ticket`, `pick_next_ticket`, `move_ticket`, `create_ticket`. Инструментов стало 38 вместо 24.

### Владение пайплайном

`start_pipeline` реализован; `pause`, `resume`, `stop` и `abort` работают на реальных запусках. Владение привязано к запуску, а не к процессу сервера, и переживает его перезапуск. Подробности — раздел «Владение процессом».

### Breaking changes

- **Код отказа `NO_RUNNER_PIDS` заменён на `PIPELINE_NOT_RUNNING`.** Источником pid был `.runner-pids` — файл, которого не пишет никто; прежний ответ описывал несуществующий файл (`Failed to read .runner-pids: ENOENT`), а не положение дел. Единственный источник pid теперь `.workflow/logs/.pipeline.lock`.
- **`list_ghost_executions`, `list_reports` и `get_report` больше не заворачивают ответ дважды.** Эти три инструмента делали обёртку `content: [{type:'text', …}]` внутри себя, хотя её и так делает сервер, и клиент получал данные на уровень глубже остальных. Если вы разбирали их вывод с поправкой на вложенность — поправку надо снять.

## Новые возможности версии 1.2.0

### Git-инструменты (5 новых tools)

Управление Git-репозиториями в проектах через MCP. **Требования к окружению:** `git` CLI (обязательно), `gh` CLI (опционально, нужен только для `git_open_pr`).

- `git_status(project)` — структурированный статус Git-репозитория (ветка, ahead/behind, modified/staged/untracked файлы)
- `git_create_branch(project, {name, from?, switch?})` — создание новой ветки с опциональным переключением
- `git_diff(project, {staged?, path?, max_lines?})` — снимок diff'а с фильтрацией по пути и лимитом строк
- `git_commit(project, {message, paths?, co_authors?})` — коммит staged-изменений или явных путей; поддерживает Co-Authored-By trailers
- `git_open_pr(project, {title, body?, base?, head?, draft?})` — открытие GitHub pull request через gh CLI

**Пример:**
```javascript
const status = await client.callTool('git_status', { project: 'my-project' });
// Возвращает: { branch: 'main', ahead: 0, behind: 2, modified: [...], staged: [...] }

const diff = await client.callTool('git_diff', { project: 'my-project', staged: true });
// Возвращает diff-снимок staged-изменений
```

### Coach-инструменты (4 новых tools)

Запуск и управление скилами проекта и их тестовыми наборами через MCP.

- `run_skill(project, {skill_name, args?, context?, timeout_sec?})` — выполнить скил с опциональными аргументами и контекстом. Отвечает конвертом запуска (`exit_code`, `stdout`, `stderr`, `duration_ms`) — как и `run_skill_tests`: оба действительно запускают процесс
- `list_skill_tests(project, {skill_name?})` — тест-кейсы скила из `index.yaml`: `{tests, warnings}`, при отказе — `{error, message, tests: [], warnings: []}`. Ничего не запускает, поэтому конверта CLI (`exit_code`/`stdout`) у ответа нет
- `run_skill_tests(project, {skill_name, test_ids?, parallel?, timeout_sec?})` — прогон тестов скила со структурированным результатом
- `create_coach_ticket(project, {target_skill, gap_description, evidence_path?, priority?})` — создание coach-gap тикета на улучшение скила

> **`run_skill` требует раннера, которого нет.** Tool зовёт
> `<project>/.workflow/src/scripts/run-skill.js`; этот скрипт не поставляется
> ни пакетом `workflow-ai`, ни `workflow init`, поэтому в реальном проекте
> вызов возвращает `SKILL_RUNNER_UNAVAILABLE`. `run_skill_tests` этим не
> затронут — его скрипт `run-skill-tests.js` на месте.

**Пример:**
```javascript
// Запуск скила
const result = await client.callTool('run_skill', {
  project: 'my-project',
  skill_name: 'decompose-plan',
  args: ['--plan-id', 'PLAN-001']
});
// Возвращает: { exit_code: 0, stdout: '...', duration_ms: 1234, artifacts: [...] }

// Прогон тестов скила
const testResult = await client.callTool('run_skill_tests', {
  project: 'my-project',
  skill_name: 'execute-task'
});
// Возвращает: { skill_name: 'execute-task', summary: { pass: 5, fail: 0, skipped: 1 }, results: [...] }
```

### Аналитические инструменты (4 tools)

Прикладные метрики скорости и эффективности воркфлоу проекта. Метрики вычисляются по frontmatter тикетов (отдельное хранилище аналитики не требуется).

- `get_velocity(project, {window_days?, group_by?})` — метрика velocity, сгруппированная по дням или неделям
- `get_cycle_time(project, {window_days?, percentiles?})` — статистика cycle time (перцентили и среднее в секундах)
- `get_ticket_stats(project, {window_days?})` — распределение тикетов по статусам, типам, top-N заблокированных
- `aggregate_metrics({projects?, window_days?})` — агрегация аналитики по нескольким проектам

**Пример: понимание velocity**
```javascript
const velocity = await client.callTool('get_velocity', {
  project: 'my-project',
  window_days: 14,
  group_by: 'day'
});
// Возвращает:
// {
//   window_days: 14,
//   points: [
//     { date: '2026-04-14', count: 3, total_complexity: 9 },
//     { date: '2026-04-15', count: 2, total_complexity: 6 }
//   ]
// }
```

**Интерпретация:** velocity показывает количество завершённых тикетов в единицу времени. Отслеживайте по дням или неделям, чтобы:
- определить пропускную способность: если 2–3 тикета/день — планируйте спринты под эту мощность;
- ловить тренды: проседание velocity сигнализирует о блокерах или расширении scope;
- прогнозировать: оценивать срок завершения спринта по текущей velocity и остатку тикетов.

`get_cycle_time` (по умолчанию p50/p90) помогает понять эффективность:
- **p50** — медиана времени от создания до завершения тикета (типичная длительность);
- **p90** — 90-й перцентиль (как долго длятся «самые медленные» 10% тикетов; индикатор выбросов и сложных задач);
- комбинация velocity + cycle_time позволяет ловить узкие места (например, высокий p90 + низкая velocity = задержки в процессе).

> `get_velocity` и `get_cycle_time` существовали как функции с первого коммита,
> но зарегистрированы как MCP-tools были только сейчас — до этого `callTool`
> по этим именам возвращал `Tool not found`, хотя README и CHANGELOG 1.2.0
> обещали обратное.

### Инструмент поиска
- `cross_project_search({query, projects?, type?, max_results?})` — быстрый поиск кода по нескольким проектам через ripgrep

### Health-мониторинг
- детектор расхождения веток (branch divergence) с настраиваемыми порогами
- алёрты на висящие approval-тикеты

## Управление пайплайном (7 tools)

Запуск и контроль раннера workflow-ai. Все tools принимают `project` — путь
относительно корня рабочей области (`MCP_CWD`) либо абсолютный.

Схемы резолва две, и они не совпадают. `git_*` требуют имя из discovery и
абсолютный путь не принимают; остальные tools делают `path.resolve(MCP_CWD, project)`
и проверяют наличие `.workflow/`, не заглядывая в discovery. В multi-project
раскладке (проекты — прямые потомки `MCP_CWD`) обе схемы дают один результат
для имени проекта. В single-project (`.workflow/` в самом `MCP_CWD`) расходятся:
`git_*` понимают имя проекта, остальные — только путь.

- `start_pipeline(project, {plan?, config?})` — запускает `workflow run` detached-процессом. Возвращает `{ok, run_id, pid, started_at, log_path}`. Синглтон держит сам раннер через `.workflow/logs/.pipeline.lock`; если lock жив — `{ok: false, code: 'ALREADY_RUNNING', pid, started_at}`; lock мёртвого процесса снимается автоматически. Если pid жив, но сам процесс стартовал позже записи lock'а — это не раннер, а занявший номер посторонний процесс: ответ `{ok: false, code: 'STALE_PIPELINE_LOCK', pid}`, а lock остаётся на месте — удалять его решает человек, чтобы ошибка проверки не подняла второй пайплайн поверх живого. Ждёт появления лога до 10 секунд, иначе `RUNNER_NO_LOG`.
- `get_pipeline_log(project, options: {tail_lines?, offset_bytes?, run_id?})` — содержимое лога с курсором. `tail_lines` по умолчанию 200, максимум 5000 (иначе `TOO_MANY_LINES`); без `run_id` берётся последний прогон. Возвращает `{run_id, lines, log_path, log_size_bytes, truncated}`.
- `list_running_pipelines()` — все идущие пайплайны по обнаруженным проектам: `state` (`running|paused|aborting|killed|stale`), текущая стадия, номер шага, `awaiting_approval`, `marker_valid`, а также `foreign`, `stale_lock`, `marker_reason` и `killed_by`, когда они применимы. Параметров нет.
  В списке появляется проект, у которого жив `.workflow/logs/.pipeline.lock`. Раннер снимает lock при любом упорядоченном выходе — своём, по `SIGINT` и по `SIGTERM`, — поэтому **завершившийся прогон из списка просто исчезает**; состояния `completed` у инструмента нет. Откуда берутся остальные:

  - `aborting` — идёт `abort_pipeline` и раннер ещё жив. Признак — `.workflow/state/abort-state.json`, он сверяется с pid и `run_id` текущего прогона. На POSIX раннер обычно выходит по первому же сигналу и состояние наблюдаемо доли секунды; на Windows мягкий `taskkill` консольному процессу ничего не делает, и состояние держится всё grace-окно.
  - `paused` — файл паузы с тем же pid либо ожидающее одобрение.
  - `running` — pid раннера жив.
  - `killed` — pid мёртв, lock остался, и остановку сделали мы: `stop_pipeline` или эскалация `abort_pipeline` записывают исход в `.workflow/state/last-kill.json`. Раннер после `taskkill /F` ни лог дописать, ни lock снять не успевает, поэтому иначе отличить это от аварии нельзя. Кто именно добивал, видно в `killed_by`. Запись об исходе — второе доказательство владения: маркер запуска после убийства снимаем мы сами, поэтому по одному его отсутствию такой прогон считался чужим (`foreign: true`) — теперь нет.
  - `stale` — pid мёртв, lock остался, и чем кончилось, неизвестно: падение, ребут, убийство со стороны. Признак `stale_lock` при этом стоит и у `killed`: файл в обоих случаях надо убирать.
- `pause_pipeline(project)` — `SIGSTOP` на POSIX, `pssuspend.exe` на Windows. Возвращает `{ok, pid, state: 'paused', paused_at}`; повторный вызов идемпотентен и отдаёт `code: 'ALREADY_PAUSED'`. Если средство приостановки недоступно — `PAUSE_UNSUPPORTED`.
- `resume_pipeline(project)` — снимает паузу (`SIGCONT` / `pssuspend -r`).
- `abort_pipeline(project, options: {grace_sec?})` — мягкая остановка: `SIGINT` → ожидание → `SIGTERM`. `grace_sec` зажимается в `[0, 60]`, по умолчанию 10. Возвращает `{ok, pid, state: 'aborted', duration_ms, escalated}`. Если раннер успел выйти сам за grace-окно — `escalated: false` без жёсткого сигнала; если за это время владение потеряно — `{ok: false, code: 'OWNERSHIP_LOST'}`.
- `stop_pipeline(project, options: {force?})` — жёсткое убийство (`SIGKILL` / `taskkill /F /T`). Возвращает `{ok, pid, state: 'killed'}`.

Обратите внимание: у `get_pipeline_log`, `abort_pipeline` и `stop_pipeline`
дополнительные параметры лежат во вложенном объекте `options`, а не рядом с
`project` — в отличие от `start_pipeline` и всех `git_*`-tools.

**Пример:**
```javascript
const run = await client.callTool('start_pipeline', {
  project: 'my-project',
  plan: 'PLAN-017'
});
// { ok: true, run_id: 'pipeline_2026-09-19_14-30-00', pid: 12345, started_at: '...', log_path: '...' }

const log = await client.callTool('get_pipeline_log', {
  project: 'my-project',
  options: { tail_lines: 50, run_id: run.run_id }
});
```

> **Владение процессом.** `pause`/`resume`/`abort`/`stop` отказываются трогать пайплайн,
> запущенный не этой рабочей областью. Владение привязано к запуску, а не к процессу
> сервера: пайплайн остаётся своим и после перезапуска клиента. Сверяются четыре вещи:
>
> - `.workflow/logs/.mcp-started-by` — pid раннера и `mcp_instance_id` рабочей области;
> - `started_by` из `.pipeline.lock` — запуск из CLI не наш (`STARTED_BY_MISMATCH`);
> - `run_id` — маркер и lock должны описывать один запуск (`RUN_MISMATCH`);
> - время старта процесса — настоящий раннер стартовал не позже записи lock'а
>   (`PID_REUSED`). Время берётся у ОС (`Get-Process` на Windows, `ps -o lstart=` на
>   POSIX); если узнать не удалось — проверка пропускается, чтобы недоступная
>   системная утилита не запрещала управлять своим же пайплайном.
>
> Обход — `force: true` у `stop_pipeline` либо `WORKFLOW_MCP_FORCE_FOREIGN=1`. **Кроме случая
> `STALE_PIPELINE_LOCK`:** там pid из lock'а принадлежит уже другому процессу, и `force`
> убьёт постороннее дерево. Такой lock нужно удалить руками: сервер его не сносит
> ни в `stop`, ни в `start_pipeline` — ошибка проверки стоила бы второго пайплайна
> поверх живого.
>
> Список `list_running_pipelines` делает только три дешёвые проверки из четырёх: время
> старта процесса там не запрашивается (это внешний вызов на каждый проект при
> каждом запросе). Поэтому протухший lock с переиспользованным pid в списке выглядит
> как идущий свой пайплайн, а `stop`/`pause`/`abort` откажут с `STALE_PIPELINE_LOCK`.

## Approvals, диагностика и отчёты (5 tools)

- `approve_step(project, {step_id, decision, comment?, decided_by?})` — решение по manual-gate стадии. `decision` — `approve` или `reject`, `comment` до 1000 символов, `decided_by` по умолчанию `mcp-client`. Пишет `.workflow/approvals/{step_id}.json`. `step_id` можно задавать и префиксом: раннер именует файлы как `{TICKET}_{stage}_{N}`, и если под префикс подходит ровно один pending — он и берётся; если несколько, вернётся `AMBIGUOUS_STEP_ID` со списком кандидатов. Идемпотентен: повторное решение по тому же шагу возвращает `{ok: false, code: 'ALREADY_DECIDED', previous_decision, decided_at, decided_by}`.
- `list_blocked_tickets({project?})` — тикеты из `.workflow/tickets/blocked/` по всем проектам или по одному. Возвращает `{project_filter, count, tickets[]}`.
- `list_ghost_executions({project?, since?})` — скан логов пайплайна на маркеры ghost-execution (маркер настраивается через `health.ghost_execution_log_marker`). `since` — ISO 8601. Возвращает `{project_filter, count, truncated, executions[]}`.
- `list_reports(project, {since?, limit?})` — отчёты проекта, отсортированные по `created_at` убыванию. `limit` по умолчанию 50.
- `get_report(project, {report_id})` — один отчёт: `{frontmatter, body, path}`. `report_id` — только буквы, цифры и дефисы.

**Пример:**
```javascript
await client.callTool('approve_step', {
  project: 'my-project',
  step_id: 'manual-gate-human',
  decision: 'approve',
  comment: 'Проверено вручную'
});

const blocked = await client.callTool('list_blocked_tickets', {});
// { project_filter: 'all', count: 3, tickets: [{ project, id, title, ... }] }
```

> **Изменение формата ответа.** До этой версии `list_ghost_executions`,
> `list_reports` и `get_report` заворачивали результат в `content[]` внутри
> себя, а сервер оборачивал его ещё раз — клиент получал
> `{"content":[{"type":"text","text":"<данные>"}]}` вместо самих данных.
> Лишняя обёртка убрана, теперь эти три tools отдают данные так же, как все
> остальные. Код, который разбирал их результат с поправкой на вложенность,
> нужно поправить.

## Тикеты, планы, скилы и human-очередь (12 tools)

Операции над содержимым `.workflow` конкретного проекта.

**Тикеты:**
- `list_tickets(project, {status?, plan_id?, priority?, type?})` — список тикетов с фильтрами. `status` — одна из директорий `backlog`, `ready`, `in-progress`, `review`, `blocked`, `done`, `archive`; без него сканируются все.
- `get_ticket(project, {ticket_id})` — `{frontmatter, body, status_from_dir, path}`. Статус берётся из имени директории, а не из frontmatter.
- `create_ticket(project, {type, title, priority?, plan_id?, body?})` — создание тикета в backlog. `priority` — число, 1 = высший, по умолчанию 3. При `type: 'human'` в frontmatter дополнительно проставляется `executor_type: human`.
- `move_ticket(project, {ticket_id, target})` — перемещение между статусами с проверкой допустимости перехода.
- `pick_next_ticket(project)` — следующий тикет в работу по правилам приоритизации проекта.

**Планы:**
- `list_plans(project, {status?})` — планы проекта; статусы `draft`, `approved`, `active`, `completed`, `archived`.
- `get_plan(project, {plan_id})` — план с телом и присоединёнными тикетами, разделёнными на обычные и human.

**Скилы:**
- `list_skills({project?})` — скилы проекта: подключённые из глобальной установки (`shared`) и скопированные в проект (`ejected`); без `project` — только общие.

**Human-очередь:**
- `list_human_queue({project?, status?})` — HUMAN-тикеты по всем обнаруженным проектам или по одному.
- `get_human_context(project, {ticket_id})` — расширенный контекст HUMAN-тикета: сам тикет, родительский план, зависимости, связанные отчёты и шаги пайплайна.
- `resolve_human_ticket(project, {ticket_id, decision, result_body, next_status?, strict?})` — дописывает секцию результата и переводит тикет в следующий статус (по умолчанию `done`).

**Проект:**
- `get_project_status(project)` — счётчики тикетов по статусам, активный план, последние шаги пайплайна и висящие human-задачи.

**Пример:**
```javascript
const plan = await client.callTool('get_plan', {
  project: 'my-project',
  plan_id: 'PLAN-017'
});
// { frontmatter, body, tickets: [...], human_tickets: [...] }

await client.callTool('move_ticket', {
  project: 'my-project',
  ticket_id: 'IMPL-12',
  target: 'review'
});
```

> Все эти функции существовали в `src/tools/` с первого коммита и покрыты
> тестами, но как MCP-tools зарегистрированы не были — клиент их не видел.

## Конфигурация

Полный список ключей, которые действительно читает код, с дефолтами и ссылками
на модули-потребители — в [`.workflow-mcp.yaml.example`](.workflow-mcp.yaml.example).
Разделы ниже описывают отдельные группы настроек.

Корнем рабочей области служит `MCP_CWD`, а не рабочий каталог процесса: его
задаёт клиент, и у stdio-клиентов он произвольный. От `MCP_CWD` резолвятся
имена проектов во всех tools, читается `.workflow-mcp.yaml` и считается
каталог состояния по умолчанию.

### Health-мониторинг

```yaml
health:
  enabled: true          # false — служба здоровья не запускается вовсе
  tick_interval_sec: 15
  stuck_headroom_sec: 60
  blocked_accumulation_threshold: 5
  ghost_execution_log_marker: "[GHOST-EXECUTION]"
  crash_mtime_freshness_sec: 60
  dedup_fingerprint_ttl_sec: 3600
  approval_pending_threshold_sec: 600
  # Детектор расхождения веток (Sprint 3)
  branch_diverged_max_behind: 10      # Алёрт, если ветка отстаёт от remote
  branch_diverged_max_ahead: 30       # Алёрт, если ветка опережает
  branch_diverged_auto_fetch: false   # Запускать `git fetch` перед проверкой (опционально)
```

### Обнаружение проектов

```yaml
projects:
  whitelist: []   # непустой — берутся только перечисленные проекты
  blacklist: []   # применяется после whitelist

discovery:
  depth: 1        # глубина сканирования подпапок cwd в поисках `.workflow/`
  debounce_sec: 2 # пауза перед схлопыванием пачки изменений в одно событие
```

### Каталог состояния

```yaml
state:
  dir: ""   # пусто → XDG-путь; в защищённом cwd запись отключается
```

Путь считается от `MCP_CWD` и на Windows не зависит от регистра: `d:\Dev` и
`D:\Dev` — одна рабочая область. Раньше регистр входил в хеш, и одна и та же
область получала два каталога и два разных `mcp_instance_id`.

Каталог создаётся первой записью, а не запуском сервера: пустых каталогов от
разовых запусков больше не остаётся. Кеш пути к `gh` лежит уровнем выше — он
один на машину, а не на рабочую область. Оба каталога подчиняются и
`WORKFLOW_STATE_DIR`, и `state.dir` из конфига: заданный каталог забирает всё
состояние сервера целиком.

Смена правила (2.0.0) меняет и `mcp_instance_id`. Маркер прогона, запущенного
сервером прежней версии, принимается и дальше: `acceptedInstanceIds(cwd)`
отдаёт текущий ключ и, на Windows, прежний, а `validateMarker` сверяет маркер
только с этим списком. Поэтому обновление посреди прогона не делает его чужим.

### Валидация human-тикетов (Sprint 3)

```yaml
human_ticket:
  strict_validation: false       # Включить строгую валидацию (по умолчанию: false)
  min_result_length: 50          # Минимальная длина тела (по умолчанию: 50)
  evidence_required: true        # Требовать маркеры evidence (по умолчанию: true)
```

Кастомные правила валидации можно добавить через файл `human-task-rules.md` в корне проекта.

### Объединение нотификаций (coalescing)

```yaml
notifications:
  coalesce_window_ms: 200  # Окно объединения нотификаций
```

## Migration Guide

### Переход на 1.3.0

Два изменения, ломающих совместимость, перечислены выше в разделе «Новые возможности версии 1.3.0»: код отказа `PIPELINE_NOT_RUNNING` вместо `NO_RUNNER_PIDS` и снятая двойная обёртка ответа у трёх инструментов. Конфигурация не менялась.

Требуется `workflow-ai` не ниже 1.6.0 — первая версия, в `exports` которой есть `operations/plans.mjs` и `operations/skills.mjs`. На более старой сервер стартует с предупреждением и без четырёх инструментов.

### Переход на 1.2.0 (Sprint 3)

Breaking changes отсутствуют. Все существующие tools и конфигурации из версии 1.1.0 остаются без изменений.

### Новые runtime-зависимости

В зависимости от используемых возможностей могут потребоваться дополнительные CLI-инструменты:

| Инструмент | Назначение | Опциональный | Установка |
|------------|------------|--------------|-----------|
| `git` | Требуется для всех `git_*` tools | Нет | Обычно предустановлен |
| `gh` | Требуется только для `git_open_pr` | Да | [Установить GitHub CLI](https://cli.github.com) |
| `ripgrep` (`rg`) | Требуется только для `cross_project_search` | Да | [Установить ripgrep](https://ripgrep.org) |

### Включение строгой валидации human-тикетов

По умолчанию валидация human-тикетов остаётся мягкой (обратно-совместимо с 1.1.0). Чтобы включить строгую:

**Вариант 1: глобальная конфигурация** (на все проекты)

Добавьте в `.workflow-mcp.yaml`:

```yaml
human_ticket:
  strict_validation: true         # Включить строгую валидацию
  min_result_length: 50           # Требовать минимум 50 символов
  evidence_required: true         # Требовать маркеры evidence (URL, путь, code block)
```

**Вариант 2: переопределение на конкретный вызов**

При вызове `resolve_human_ticket` передайте `strict: true`:

```javascript
const result = await client.callTool('resolve_human_ticket', {
  project: 'my-project',
  ticket_id: 'HUMAN-001',
  decision: 'Проверено вручную',
  result_body: 'Скриншот: https://example.com/shot.png',
  strict: true  // Переопределить конфиг для этого вызова
});
```

**Вариант 3: кастомные правила валидации**

Создайте `human-task-rules.md` в корне проекта для добавления своих правил:

```markdown
# Human Task Rules

- rule: https?://[^\s]+ | Внешняя ссылка (тикет, документация) обязательна
- rule: \.png|\.jpg|\.gif | Рекомендуется evidence в виде скриншота
- rule: \`\`\`[\s\S]*?\`\`\` | Требуется блок кода или вывод теста
```

При наличии кастомных правил строгая валидация применяет их в дополнение к стандартным проверкам.

### Настройка детектора расхождения веток

При работе с Git в нескольких проектах можно настроить алёрты расхождения:

```yaml
health:
  branch_diverged_max_behind: 10      # Алёрт, если ветка отстаёт >10 коммитов
  branch_diverged_max_ahead: 30       # Алёрт, если ветка опережает >30 коммитов
  branch_diverged_auto_fetch: false   # true для автоматического `git fetch` перед проверкой
```

Детектор запускается автоматически при health-проверках для всех Git-репозиториев. Если возможность не нужна — оставьте дефолты.

### Дополнительная конфигурация для новых возможностей

См. секцию [Конфигурация](#конфигурация) выше и полный список ключей в
[`.workflow-mcp.yaml.example`](.workflow-mcp.yaml.example).

> Прошлые версии README описывали здесь секции `git.*`, `analytics.*` и
> `search.*`. Ни один из этих ключей код не читает — они удалены, чтобы не
> создавать впечатление настраиваемости. Поведение `git_*`-tools, аналитики и
> `cross_project_search` задаётся параметрами вызова, а не конфигом.

Полные детали — в [MIGRATION.md](MIGRATION.md).
