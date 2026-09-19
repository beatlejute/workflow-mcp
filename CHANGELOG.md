# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — 2026-09-20

### Security
- **Path traversal в `get_ticket`, `create_ticket` и `move_ticket`.** `ticket_id` и `type` попадают прямо в имя файла, но не проверялись: пока это были внутренние функции, значения приходили от своих же модулей. После регистрации как MCP-tools значение стал задавать клиент — `ticket_id: '../../../../secret'` читал любой `.md` за пределами проекта, перезаписывал его при перемещении, а `type: '../../../evil'` создавал тикет где угодно. Оба параметра теперь обязаны быть одним сегментом пути (`[A-Za-z0-9_-]+`), как это уже делали `get_report` и `get_plan`.

### Fixed
- **Импорты соседнего репозитория заменены на объявленную зависимость.** Девять модулей `src/` тянули код по пути `../../../workflowAi/src/lib/...` — то есть требовали, чтобы репозиторий workflowAi был распакован рядом и назывался именно так. Из `node_modules/workflow-mcp` такой путь не разрешается вообще, поэтому опубликованный на npm пакет был неработоспособен, хотя `workflow-ai` всё это время значился в зависимостях и не использовался. Теперь всё идёт через `exports` пакета (`workflow-ai/lib/...`); то, что не является модулем — SKILL.md скилов и шаблоны — резолвится через новый `src/lib/workflow-ai.mjs`. Зависимость поднята с `^1.2.0` до `^1.6.0` — это первая версия, где в `exports` есть `operations/plans.mjs` и `operations/skills.mjs`. С 1.5.1 четыре tool'а (`list_plans`, `get_plan`, `get_project_status`, `list_skills`) молча не загрузились бы, поэтому `loadTools` теперь отдельной строкой предупреждает о неполном наборе. **1.6.0 ещё не опубликована**: локально пакет подключён через `npm link` на рабочее дерево workflowAi, `package-lock.json` записывает это как `link: true`, и до публикации установка из реестра невозможна.
- **`move_ticket` сообщал о недопустимом переходе как `undefined`.** Раннер бросает голый объект `{code: 'INVALID_TRANSITION', from, to, id}`, а не `Error`; обработчик сервера берёт `err.message`, и клиент получал `Error executing tool move_ticket: undefined`. Теперь приводится к `Error` с внятным текстом.
- **Ключ `state.dir` не читался.** `server.mjs` звал `resolveStateDir(process.cwd())` без конфига, хотя функция принимает его вторым аргументом, а собственное предупреждение сервера советует «Set state.dir in .workflow-mcp.yaml to enable». Конфиг теперь передаётся.
- **Шаблоны тикетов, планов и отчётов** резолвились от cwd процесса (`process.cwd()/node_modules/workflow-ai/templates`) — работало только когда сервер запущен из корня workflow-mcp. Добраться до самого ресурса клиент всё равно не мог — см. ниже про регистрацию ресурсов.
- **Сервер падал на старте при не-semver спецификаторе зависимости.** `semver.minVersion('file:../workflowAi')` бросает «Invalid comparator»; теперь такой спецификатор пропускается с сообщением, а проверка версии выполняется только для настоящих диапазонов.
- **Половина tools игнорировала `MCP_CWD`.** Рабочий каталог процесса задаёт клиент, поэтому корнем рабочей области служит `MCP_CWD`, но читали его не все. При `MCP_CWD ≠ cwd` один и тот же `project: "projA"` одни tools находили, а пятнадцать отвечали «не найден»: `list_reports`, `get_report`, `pause_pipeline`, `resume_pipeline`, `abort_pipeline`, `stop_pipeline`, все пять `git_*`, `get_project_status`, `get_velocity`, `get_cycle_time`, `get_ticket_stats`. Резолв собран в `src/lib/project-root.mjs` и теперь один на все tools и ресурсы.
- **`mcp_instance_id` считался от двух разных корней.** Писатель маркера (`process/marker.mjs`) брал `process.cwd()`, а читатель (`resources/pipeline-state.mjs`) — переданный корень. При `MCP_CWD ≠ cwd` свой же пайплайн выглядел чужим. Идентификатор теперь считается в одном месте. **Разовый эффект при обновлении:** если `MCP_CWD` задан и не совпадает с cwd, маркеры пайплайнов, запущенных старым сервером, перестанут считаться своими для `pause`/`resume`/`abort`/`stop` — до завершения тех пайплайнов. Причиной будет `INSTANCE_MISMATCH`: pid в маркере остался тем же (pid раннера), а расходится именно идентификатор рабочей области.
- **Кеш пути к `gh` шёл мимо `state.dir`.** `git/client.mjs` читал конфиг из корня проекта, а сервер — из корня рабочей области; у проекта своего `.workflow-mcp.yaml` обычно нет, и заданный вручную каталог состояния клиент git не видел. Путь к бинарнику один на машину, поэтому кеш лежит там же, где остальное состояние сервера.
- **`notifications.coalesce_window_ms` читался от `process.cwd()`**, хотя сам конфиг сервер берёт от `MCP_CWD`.
- **Подписка на `workflow://{project}/logs/pipeline/latest` не работала при `MCP_CWD ≠ cwd`.** `start_pipeline_log_watch` принимал корень от сервера и не передавал его в `startWatching`; тот звал discovery от рабочего каталога процесса, проекта не находил и молча не ставил watcher. Чтение ресурса при этом работало, поэтому дефект был виден только по отсутствию `resources/updated`.
- **Кеш пути к `gh` игнорировал `WORKFLOW_STATE_DIR` и `WORKFLOW_STATE_MODE`.** Клиент повторял лишь вторую половину резолва сервера: при заданной переменной состояние сервера шло в неё, а кеш — в XDG-каталог; в read-only режиме клиент всё равно писал. Порядок резолва вынесен в `serverStateDir()`.
- **Имя скила не кодировалось в URI ресурса.** SDK ищет ресурс по нормализованной строке `new URL(...)`, поэтому скил с пробелом или не-ASCII в имени попадал в `resources/list`, но не читался ни по какому написанию. Все десять реальных скилов — ASCII, так что дефект был латентным. Заодно отбрасываются временные `__test-*`, как это делает workflow-ai, а шаблоны регистрируются только существующие.
- **Пять локальных копий `resolveProjectRoot`** (`tickets`, `plans`, `human`, `approvals`, `coach`) заменены общей: четыре из них бросали Error без `code`, и клиент получал от них ошибку без `[INVALID_PROJECT]`, в отличие от соседних.
- **Мёртвые импорты.** `findProjectRoot` импортировался в `coach.mjs`, `reports.mjs` и `tickets.mjs`, но не вызывался ни разу; `getNextId` — в `coach.mjs` и `tickets.mjs`, где упоминался только в комментарии.
- **Двойная обёртка ответа у `list_ghost_executions`, `list_reports`, `get_report`.** Обработчик в `server.mjs` заворачивает результат `execute()` в `content: [{type: 'text', text: JSON.stringify(...)}]`; эти три tools делали такую же обёртку внутри себя, и клиент получал `{"content":[{"type":"text","text":"<данные>"}]}` вместо данных — на уровень глубже, чем все остальные tools. **Breaking для тех, кто разбирал их вывод с поправкой на вложенность.** Ошибки теперь тоже пробрасываются наверх: текст (`Error executing tool <name>: …`) и `isError` формирует сервер, как и для прочих tools.
- **`workflow://templates/*` и `workflow://skills/*/SKILL.md` никогда не были зарегистрированы.** Оба числятся в `resources_list()` и описаны в README, но `server.mjs` их не регистрировал: `resources/list` отдавал 8 URI, `resources/templates/list` — пустой список, а сам `resources_list()` никто не вызывал. Теперь регистрируются поштучно: три шаблона и по одному ресурсу на каждый скил пакета (`resources/list` — 21 URI вместо 8).
- **Код ошибки не доезжал до клиента.** Tools выставляют `err.code` (`INVALID_ARGUMENT`, `TICKET_NOT_FOUND`, `INVALID_TRANSITION`…), но обработчик сервера пробрасывал один `message`, и вид отказа приходилось разбирать по тексту. Теперь ответ выглядит как `Error executing tool <name> [<CODE>]: <message>`.
- **`pause`/`resume`/`abort`/`stop` не работали ни на одном реальном пайплайне.** Две причины сразу.
  Первая: `start_pipeline` помечал запуск маркером `.mcp-started-by`, но четвёрка сверяла поле `pid` с `process.pid` самого сервера, а там лежал pid раннера — совпасть невозможно, и ответом всегда было `PID_MISMATCH`.
  Вторая: pid для сигналов брался из `<project>/.runner-pids`, который не пишет никто — ни workflow-ai, ни расширение VS Code, ни сам сервер; читают его четыре модуля, и два из них — по другому пути (`.workflow/logs/.runner-pids`). Теперь источник pid — `.pipeline.lock` раннера, `.runner-pids` остался запасным путём.
  **Владение теперь привязано к запуску, а не к процессу:** в маркере лежит pid раннера, и проверка сверяет его с живым pid из lock'а. Привязка к `process.pid` сервера делала бы свой пайплайн чужим после каждого рестарта (stdio-сервер живёт одну сессию клиента, detached-раннер — часами) и заодно разрешала бы убить чужой пайплайн по протухшему маркеру. Формат маркера не изменился, так что старые маркеры остаются действительными. Тесты дефекта не видели, потому что писали маркер руками с `pid: process.pid` и клали рядом `.runner-pids`.
- **Владение сводилось к равенству pid — этого мало.** Ни одна из четырёх операций не проверяла, что процесс с этим номером всё ещё наш раннер. Раннер, убитый без снятия lock'а (`kill -9`, `taskkill /F` — ровно то, что делают `stop` и `abort`, — или перезагрузка), оставляет файлы с номером, который система переиспользует — на Windows охотно. После этого `stop_pipeline` без `force` отправлял `taskkill /F /T` чужому дереву процессов. Теперь поверх маркера сверяются три вещи: `started_by` из lock'а (запуск из CLI не наш), `run_id` (маркер и lock одного запуска) и время старта процесса (`src/process/process-start.mjs`): настоящий раннер стартовал не позже записи lock'а. Новые причины отказа: `STARTED_BY_MISMATCH`, `RUN_MISMATCH`, `PID_REUSED`. Если время старта узнать не удалось (нет прав, нет утилиты), проверка пропускается — запрет управлять своим же пайплайном хуже остаточного риска.
  Запрос времени старта — внешний вызов ценой в сотни миллисекунд, поэтому он делается только перед отправкой сигнала. `list_running_pipelines` и ресурс `workflow://pipeline-state` делают только дешёвые проверки, поэтому протухший lock с переиспользованным pid в списке выглядит идущим своим, а управляющие tools по нему откажут. Расхождение описано в README.
- **Переиспользованный pid заклинивал проект насовсем.** `start_pipeline` считал lock живым по одной только живости pid и отвечал `ALREADY_RUNNING`, `stop` отказывал по переиспользованию, а `force` убил бы посторонний процесс — безопасного выхода через MCP не было. Теперь `start_pipeline` отвечает `STALE_PIPELINE_LOCK` с указанием удалить lock. Автоматически сносить его сервер не берётся: цена ошибки несимметрична — ложное срабатывание (например, шаг системных часов вперёд на Linux, где `ps` считает время старта от смещающегося `btime`) подняло бы второй пайплайн поверх живого. Отказ же требует одного явного действия человека.
- **`PID_REUSED` больше не советует `force`.** Это не «чужой пайплайн», а протухший lock без пайплайна вовсе, и `force` означал бы «убейте процесс, занявший номер». Отдельный код `STALE_PIPELINE_LOCK` и подсказка удалить lock.
- **Эскалация `abort` различает два исхода.** Штатно завершаясь, раннер снимает lock — и проверка владения вырождалась в сравнение pid, то есть жёсткий сигнал всё равно уходил. Теперь исчезнувший lock значит «раннер вышел» (`escalated: false`, успех), а потеря владения — `OWNERSHIP_LOST`.
- **`abort_pipeline` теперь возвращает `ok: true` при успехе**, как соседние `pause`/`resume`/`stop`; раньше поле было только у отказов, и успех приходилось определять по отсутствию поля.
- **Эскалация `abort_pipeline` била вслепую.** Между мягким сигналом и жёстким проходит до минуты — достаточно, чтобы раннер завершился штатно, а его pid достался другому процессу. Перед эскалацией владение проверяется заново; если оно потеряно — `OWNERSHIP_LOST` вместо убийства.
- **Битый маркер в одном проекте ронял `list_running_pipelines` и ресурс `workflow://pipeline-state` для всей рабочей области**: `readMarker` пробрасывает всё, кроме ENOENT, а результат чтения даже не использовался.
- **`get_report` отдавал ошибку без кода** и с меткой `INVALID_FRONTMATTER` там, где отклонялся аргумент. Теперь `INVALID_ARGUMENT` и `REPORT_NOT_FOUND`.
- **Признак `foreign` в `list_running_pipelines` был инвертирован.** Чужим считался только `PID_MISMATCH`, то есть ровно свой же пайплайн (см. выше), а запущенный из CLI — без маркера вовсе — своим. Теперь чужой — любой, чей маркер не доказывает владения.
- **`list_skill_tests` падал с ENOENT на битой ссылке в `.workflow/src/skills`.** Скилы подключаются junction'ами; удалённый канон (или остаток тестового прогона) ронял `fs.statSync` и вместе с ним весь вызов. Битые записи теперь пропускаются.
- **`list_skill_tests` молча отдавал `[]` для всех скилов.** Схема ждала форму `{tests: [{test_id, description, expected_verdict}]}`, а канонический `tests/index.yaml` в workflow-ai — это `{cases: [{id, file, tags, severity}]}`. Валидация не проходила, предупреждение уходило в stderr, ответ оставался пустым. Принимаются обе формы; по живым скилам возвращается 42 кейса вместо нуля. Поля `tags` и `severity` из канона попали в ответ, `description` и `expected_verdict` для него `null` — они лежат внутри файла кейса, а не в индексе.
- **Ресурсы `workflow://{project}/config/*` были пусты у любого проекта.** Резолв искал `.workflow/configs/`, тогда как `workflow init` создаёт `.workflow/config/` — множественное число только внутри пакета и в глобальной установке. Исправлено и в резолве файла, и в перечислении ресурсов; фикстура теста воспроизводила ту же ошибку.

### Removed
- **`.runner-pids` убран целиком.** Файла с таким именем не пишет никто — ни workflow-ai, ни расширение VS Code, ни сам сервер; проверено grep'ом по всем трём репозиториям. Читали его пять модулей, причём по двум разным путям: `tools/pipeline.mjs`, `resources/pipeline-state.mjs` и `resources/index.mjs` — из корня проекта, а детекторы `health/crashed.mjs` и `health/stuck.mjs` — из `.workflow/logs/`. Единственный источник pid теперь `.workflow/logs/.pipeline.lock`.
  **Breaking для тех, кто разбирал коды отказа:** `NO_RUNNER_PIDS` заменён на `PIPELINE_NOT_RUNNING`. Прежний ответ описывал не положение дел, а несуществующий файл: `Failed to read .runner-pids: ENOENT` вместо «пайплайн не запущен».
  Детекторы здоровья намеренно оставлены как были: модуль `src/health/` не импортируется ничем, его наблюдатель сервером не запускается, и чинить в нём чтение файла — работа над кодом, который не исполняется. Судьба модуля (поднять или удалить) — отдельный вопрос, зафиксирован в PLAN-001.

### Fixed
- **Уведомления об изменении состояния пайплайна не приходили вовсе.** `startProjectWatchers` подписывался на `<project>/.runner-pids`; `fs.watch` по несуществующему пути молча ничего не даёт, а вызов обёрнут в пустой `catch`. Подписчик `workflow://pipeline-state` получал только начальный снимок, дальше ресурс обновлялся исключительно по явному чтению. Теперь наблюдение идёт за каталогом `.workflow/logs` — он существует к моменту подписки, а `.pipeline.lock` в нём появляется и исчезает вместе с пайплайном.
- **Версия сервера бралась из хардкода.** `McpServer` объявлял клиенту `0.1.0` при пакете 1.2.0 — третий несовпадающий номер одного сервера. Берётся из `package.json`.

### Testing
- **`tests/tools/list-running-pipelines.test.mjs` не проверял ничего.** 26 тестов, один `expect()` на весь файл, сам инструмент не вызывался ни разу — единственный вызов был закомментирован. Файл оставался зелёным при любом поведении кода. Фикстуры вдобавок были неверны дважды: `.runner-pids` клался в `.workflow/logs/`, хотя читается из корня проекта, а лог писался в формате, которого парсер не понимает. Переписан: 20 тестов, каждый вызывает `list_running_pipelines` и проверяет результат. Отключение веток `stale`, `foreign`, повышения `running` до `paused` и приоритета lock над `.runner-pids` даёт 2, 4, 1 и 18 падений соответственно.
- **`tests/tools/all-schemas-serializable.test.mjs`** — последний незакрытый пункт PLAN-001. Каждая схема проходит через `normalizeObjectSchema` и `toJsonSchemaCompat` с теми же опциями, что у `McpServer`; набор сверяется со снимком `tools/list`, чтобы тест не начал молча проверять меньше инструментов. Возврат `z.record(z.any())` роняет его с той самой `TypeError: Cannot read properties of undefined (reading '_zod')` — локально, а не в живой сессии клиента.
- **`tests/process/run-lock.test.mjs`** — у модуля, реализующего проверку владения и служащего единственной защитой от отправки сигнала постороннему процессу, своего теста не было. 30 проверок; пять веток подтверждены поломкой кода.
- **`tests/resources/pipeline-state-watcher.test.mjs`** — у наблюдателя за состоянием пайплайна не было ни одного теста, поэтому подписка, не работавшая вовсе, выглядела исправной. Три проверки: появление lock-файла, его изменение, снятие наблюдения после отписки. Возврат подписки на `.runner-pids` валит две из трёх.
- Фикстуры двенадцати тестовых файлов переведены с `.runner-pids` на lock раннера через общий помощник `tests/helpers/pipeline-lock.mjs`. Прежние фикстуры воспроизводили контракт, которого не существует.
- `coverage/` выведен из индекса: там лежал HTML-отчёт от 29 апреля на два модуля, выглядевший как покрытие репозитория. Правила в `.gitignore` для него не было.

### Added
- **14 MCP-tools из функций, которые лежали в `src/tools/` незарегистрированными** (24 → 38). Код существовал с первого коммита и покрыт тестами, но клиенту был не виден: `get_velocity`, `get_cycle_time`, `resolve_human_ticket`, `list_human_queue`, `get_human_context`, `list_plans`, `get_plan`, `get_project_status`, `list_skills`, `list_tickets`, `get_ticket`, `pick_next_ticket`, `move_ticket`, `create_ticket`. Сами функции остались экспортированными — их зовут соседние модули; обёртки лежат рядом под суффиксом `_tool`.
  `list_skills` потребовала починки на стороне workflow-ai: `listSkills` искала каталог общих скилов как `<projectRoot>/../src/skills` и для любого проекта в `D:\Dev` возвращала пустой список. Теперь берётся `<WORKFLOW_HOME>/skills`, и tool отдаёт 10 общих скилов плюс вытесненные в проекте. Заодно скилом считается только каталог со `SKILL.md` — иначе в выдачу попадала, например, папка `shared` с общими документами, — и скилы проекта больше не теряются, когда глобального каталога нет вовсе.
- **Smoke-тест `tests/server.tools-list.smoke.test.mjs`** — поднимает сервер, делает настоящий JSON-RPC handshake и сверяет `tools/list` со снапшотом `tests/server.tools-list.snapshot.json`. Ловит класс поломок, при котором один кривой `inputSchema` делает невидимым весь список (как `z.record(z.any())` в coach.mjs), а unit-тесты остаются зелёными.
- **`tests/tools/mcp-cwd-project-resolution.test.mjs`** — все ранее сломанные tools вызываются с `MCP_CWD ≠ cwd` и должны найти проект по имени.
- **`tests/process/process-start.test.mjs`** — время старта процесса: границы допуска, fail-open на недоступном pid, отказ выдать свежий процесс за раннер из древнего lock'а.
- **`tests/tools/pipeline-marker-ownership.test.mjs`** — девять случаев вокруг владения: реальный запуск через `start_pipeline` и `pause`/`resume`; сохранение владения после рестарта сервера (проверяется из отдельного процесса); `RUN_MISMATCH`, `STARTED_BY_MISMATCH`, `PID_REUSED`; два исхода эскалации `abort`; признак `foreign` в списке.
- **`tests/tools/ticket-argument-guards.test.mjs`** — обход каталога и нормализация ошибок перехода.
- **`.workflow-mcp.yaml.example`** в корне репозитория — полный список ключей конфигурации с дефолтами и ссылками на модули-потребители, плюс переменные окружения.

### Removed
- `list_projects` и `refresh_projects` из `src/tools/projects.mjs`: первый дублировал ресурс `project://*`, второй по собственному комментарию в коде не умел сравнивать с прошлым состоянием и всегда возвращал всё как «added». Вместе с ними ушёл ставший ненужным хелпер `checkPipelineRunning` (на Windows он к тому же всегда возвращал `false` — внутри ESM-модуля вызывался `require('child_process')`) и тест `tests/tools/list-projects.test.mjs`, чьё покрытие целиком лежит в `tests/discovery.test.mjs` и `tests/tools/get-project-status.test.mjs`.
- `convert-schemas.mjs`, `fix-schemas.js`, `debug-test.mjs` — разовые скрипты миграции JSON Schema → zod и отладочный огрызок, нигде не использовались.
- `src/health/detectors/index.mjs` — недописанный re-export, детекторы импортируются напрямую в `watcher.mjs`.
- `src/startup-guard.mjs` — 158 строк собственного парсера semver, который никто не импортировал: проверка версии живёт в `server.mjs` и делается через `semver`. Вместе с ним ушли четыре копии одного и того же обхода «найти корень workflow-ai» — осталась одна, в `src/lib/workflow-ai.mjs`.
- Дубликаты `loadTools()` в `src/tools/analytics.mjs` и `src/tools/coach.mjs` вместе с их `export default` — auto-discovery в `server.mjs` собирает tools из именованных экспортов.
- Зомби-тесты `src/caches/frontmatter-cache.test.mjs` и `tests/tools/check-pipeline-health.test.mjs` (оба были исключены из прогона; первый — console.log-скрипт под несуществующий тикет, второй — про несуществующий tool).

### Documentation
- README: описаны 12 ранее недокументированных tools — pipeline (7), `approve_step`, diagnostics (2), reports (2).
- README и `.workflow-mcp.yaml.example`: отмечено, что сервер не запускает health-watcher, поэтому из десяти ключей `health.*` влияет только `ghost_execution_log_marker` (и читается он из конфига проекта, а не из cwd сервера), а `discovery.depth` реализован единственным значением 1.
- README: у `approve_step` при неоднозначном префиксе код ответа — `AMBIGUOUS_STEP_ID`, а не `AMBIGUOUS`.
- README: удалены секции конфигурации `git.*`, `analytics.*`, `search.*` — ни один из семи ключей код не читает; исправлен дефолт `ghost_execution_log_marker` (`[GHOST-EXECUTION]`, а не `ghost-execution`).
- README: описаны 12 tools из тикетов, планов, скилов и human-очереди; примеры `callTool` для `get_velocity`, `get_cycle_time` и `resolve_human_ticket` теперь соответствуют действительности, потому что эти tools зарегистрированы.
- README: отмечено, что `run_skill` требует `.workflow/src/scripts/run-skill.js`, которого не поставляет ни `workflow-ai`, ни `workflow init`.

## [1.1.0] - 2026-04-27

### Added

#### Pipeline Controls (12 new tools)
- **`start_pipeline(project, {detach?, env?})`** — Start a pipeline for a project by spawning `workflow run`. Returns `{run_id, pid, started_at, log_path}`. **(shipped as a stub; реализован позже, FIX-002)** — в 1.1.0 и 1.2.0 возвращал `{ok: false, code: 'NOT_IMPLEMENTED'}`. Сигнатура тоже изменилась: вместо `{detach?, env?}` — `{plan?, config?}`.
- **`pause_pipeline(project)`** — Pause a running pipeline via `SIGSTOP` (POSIX) or `pssuspend.exe` (Windows). Returns `{pid, state: "paused", paused_at}`.
- **`resume_pipeline(project)`** — Resume a paused pipeline via `SIGCONT` (POSIX) or `pssuspend.exe -r` (Windows). Returns `{pid, state: "running"}`.
- **`abort_pipeline(project, {grace_sec=10})`** — Graceful shutdown: `SIGINT` → wait `grace_sec` → `SIGTERM` (POSIX). Windows uses `taskkill /PID` → wait → `taskkill /F`. Returns `{pid, state: "aborted", duration_ms, escalated: bool}`.
- **`stop_pipeline(project, {force=false})`** — Hard kill via `SIGKILL` (POSIX) or `taskkill /F /T` (Windows). Returns `{pid, state: "killed"}`.
- **`list_running_pipelines()`** — List all running pipelines with state (`running|paused|aborting|killed|completed`), current stage, step number, and `awaiting_approval` status.
- **`get_pipeline_log(project, {run_id?, tail_lines=200})`** — Retrieve pipeline log with pagination support and cursor-based reading.
- **`approve_step(project, step_id, {decision, comment?})`** — Approve or reject a manual gate step. Decision must be `approve` or `reject`. Writes to `<project>/.workflow/approvals/{step_id}.json`.
- **`list_blocked_tickets({project?})`** — Aggregate blocked tickets from `<project>/.workflow/tickets/blocked/` across all projects or a specific project.
- **`list_ghost_executions({project?, since?})`** — Scan pipeline logs for `ghost_execution` markers indicating stuck or orphaned pipeline runs.
- **`list_reports({project?, since?, limit=50})`** — List all project reports sorted by creation date.
- **`get_report(project, report_id)`** — Retrieve a specific report's content.

#### Resources (3 new)
- **`workflow://pipeline-state`** (JSON, Subscribable) — Aggregated state of all running pipelines. Notifies via `resources/updated` on state changes. Includes fields: `project`, `pid`, `state`, `current_stage`, `step_number`, `awaiting_approval`, `run_id`, `started_at`, `last_log_at`.
- **`workflow://{project}/config/pipeline`** (YAML) — Pipeline configuration for a project.
- **`workflow://{project}/config/ticket-movement-rules`** (YAML) — Ticket movement rules configuration.

#### New Resource URIs (existing)
- **`workflow://{project}/logs/pipeline/latest`** (text/plain, Subscribable) — Live-tail of the latest pipeline log with cursor-based delta reading.

#### Cross-Platform Process Control
- **`src/process/control.mjs`** — New module providing `pause(pid)`, `resume(pid)`, `abort(pid, {grace_sec})`, `kill(pid)` functions. POSIX uses `process.kill()` with signals. Windows uses `pssuspend.exe`, `taskkill`, with graceful degradation when tools are unavailable.

#### Marker System
- **`src/process/marker.mjs`** — Functions `writeMarker()`, `readMarker()`, `validateMarker()`, `removeMarker()` for `.workflow/logs/.mcp-started-by` marker file. Protects against killing foreign pipelines.

#### Approval System
- **`src/approvals/model.mjs`** — Approval file read/write with atomic temp+rename operations and schema validation.
- **`src/tools/approvals.mjs`** — `approve_step` tool implementation.
- Manual gate stages in pipeline.yaml now create `.workflow/approvals/{step_id}.json` files for `runner@1.2.0+`.

#### Health Monitoring
- **`approval_pending`** alert type — Warns when approval files remain pending beyond `health.approval_pending_threshold_sec` (default 600s).
- Added to `src/health/detectors/approval-pending.mjs`.

#### Configuration
- **`.workflow-mcp.yaml`** — New `notifications.coalesce_window_ms` (default 200) for notification coalescing.
- **`.workflow-mcp.yaml`** — New `health.approval_pending_threshold_sec` (default 600) for approval timeout.

### Changed

- **`list_running_pipelines`** now includes `state` (running/paused/aborting/killed/completed), `current_stage`, `step_number`, `awaiting_approval`, `foreign` fields.
- **Pipeline notifications** via `resources/updated` on `workflow://pipeline-state` when any pipeline state changes.
- **Marker validation** prevents accidental killing of foreign pipelines. Override with `WORKFLOW_MCP_FORCE_FOREIGN=1`.
- **Coalescing** reduces notification bursts: multiple changes within 200ms trigger one `resources/updated`.

### Fixed

- Graceful abort now properly waits `grace_sec` before sending SIGTERM on POSIX.
- Parallel abort operations now detected via state-dir flag, returning `ALREADY_ABORTING`.
- Marker removal after successful abort/stop/kill is now atomic and idempotent.
- Resume on non-paused pipeline returns `NOT_PAUSED` instead of error.
- Approval file race conditions resolved via `O_EXCL` atomic writes.

### Security

- Foreign pipeline protection: `pause_pipeline`, `resume_pipeline`, `abort_pipeline`, `stop_pipeline` validate marker ownership before sending signals.
- Path traversal protection on all config and report resources.
- Override available via `WORKFLOW_MCP_FORCE_FOREIGN=1` for emergency scenarios.

### Documentation

- Added **Pipeline Controls** section to README.md with 12 tool descriptions and usage examples.
- Added migration guide for upgrading to `workflow-ai@1.2.0` (see MIGRATION.md).

### Notes

- **Dependency**: Requires `workflow-ai@^1.2.0` for full compatibility (manual gate support). Previous versions work but approval tools return `RUNNER_VERSION_TOO_OLD`.
- Windows pause/resume requires `pssuspend.exe` (Sysinternals PsTools) in PATH. Without it, pause/resume return `PAUSE_UNSUPPORTED`.
- Graceful abort `escalated` flag is `true` when SIGTERM is required (grace period elapsed or graceful exit failed).

---

## [1.2.0] - 2026-04-28

### Added

#### Git Tools (5 new tools) ([#3](https://github.com/beatlejute/workflow-mcp/pull/3))
- **`git_status(project)`** — Get structured Git repository status: branch, ahead/behind, modified/staged/untracked/conflicted files.
- **`git_create_branch(project, {name, from?, switch?})`** — Create a new git branch with optional checkout.
- **`git_diff(project, {staged?, path?, max_lines?})`** — Get a diff snapshot with configurable limits and path filter.
- **`git_commit(project, {message, paths?, co_authors?})`** — Commit staged changes or explicit paths; supports `Co-Authored-By` trailers.
- **`git_open_pr(project, {title, body?, base?, head?, draft?})`** — Open a GitHub pull request via `gh` CLI.

#### Coach Tools (4 new tools) ([#4](https://github.com/beatlejute/workflow-mcp/pull/4))
- **`run_skill(project, {skill_name, args?, context?, timeout_sec?})`** — Run a skill via the project's skill runner.
- **`list_skill_tests(project, {skill_name?})`** — List skill test cases from `index.yaml` files.
- **`run_skill_tests(project, {skill_name, test_ids?, parallel?, timeout_sec?})`** — Run skill tests and parse structured results.
- **`create_coach_ticket(project, {target_skill, gap_description, evidence_path?, priority?})`** — Create a coach-gap ticket in the backlog.

#### Analytics Tools (заявлено 4, зарегистрировано 2) ([#5](https://github.com/beatlejute/workflow-mcp/pull/5))
- **`get_velocity(project, {window_days?, group_by?})`** — Velocity metrics grouped by day or week. **(announced here, shipped in Unreleased)** — в 1.2.0 существовала только как функция, не зарегистрированная как MCP-tool.
- **`get_cycle_time(project, {window_days?, percentiles?})`** — Cycle time statistics (p50, p90, mean). **(announced here, shipped in Unreleased)** — то же самое.
- **`get_ticket_stats(project, {window_days?})`** — Ticket distribution by status, type, and top blocked tickets.
- **`aggregate_metrics({projects?, window_days?})`** — Aggregate analytics across multiple projects.

#### Search Tool ([#5](https://github.com/beatlejute/workflow-mcp/pull/5))
- **`cross_project_search({query, projects?, type?, max_results?})`** — Fast code search across projects using ripgrep.

#### Health Monitoring
- **`branch_diverged`** detector — Warns when local branch diverges from remote tracking branch beyond configured thresholds.

#### Human Ticket Validation
- **`isValidHumanTicket`** validator with configurable rules via `human_ticket` configuration and optional `human-task-rules.md`.

#### Configuration
- **`.workflow-mcp.yaml`** — New `health.branch_diverged_max_behind` (default 10), `health.branch_diverged_max_ahead` (default 30), `health.branch_diverged_auto_fetch` (default false) for branch divergence detection.
- **`.workflow-mcp.yaml`** — New `human_ticket` section with keys: `strict_validation` (default false), `min_result_length` (default 50), `evidence_required` (default true).

### Changed
- **`resolve_human_ticket`** accepts optional `strict` parameter to enable strict validation (overrides config). **(announced here, shipped in Unreleased)** — в 1.2.0 как MCP-tool зарегистрирована не была, доступна была только прямым импортом из `src/tools/human.mjs`.

### Documentation
- Added **Git Tools**, **Coach Tools**, **Analytics**, and **Search** sections to README with usage examples.
- Updated **Configuration** section with new health and human_ticket keys.
- Added migration guide for `human_ticket.strict_validation` in MIGRATION.md.

### Migration Guide

#### Enabling `human_ticket.strict_validation`

By default, strict validation is **disabled**. To enable it, add to your `.workflow-mcp.yaml`:

```yaml
human_ticket:
  strict_validation: true
  min_result_length: 50    # optional, default: 50
  evidence_required: true  # optional, default: true
```

When `strict_validation: true`:
- Ticket result must be at least `min_result_length` characters
- Evidence field is required when `evidence_required: true`
- Calls to `resolve_human_ticket` with invalid tickets return `VALIDATION_FAILED`

You can also enable strict validation per-call without changing the config:
```javascript
await client.callTool('resolve_human_ticket', {
  project: 'my-project',
  ticket_id: 'HT-001',
  strict: true
});
```

### Notes
- **Runtime dependencies**: `git` required for all git tools; `gh` CLI optional (for `git_open_pr`); `ripgrep` required for search.
- **Backward compatibility**: All existing tools remain unchanged; new tools are opt-in via configuration.

## [1.0.0] - 2026-04-20

### Added
- Initial release of workflow-mcp MCP server
- Multi-project discovery and management
- Ticket management (list, get, create, move)
- Plan management (list, get)
- Human ticket queue aggregation
- Health monitoring with 6 alert types: `crashed`, `stuck`, `stage_error`, `retry_loop`, `blocked_accumulation`, `ghost_execution`
- Basic resources: projects, board, tickets, human-queue, alerts
- Skills framework and execution engine