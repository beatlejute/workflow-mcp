# workflow-mcp — MCP-сервер для workflow-проектов

MCP-сервер, агрегирующий операции по нескольким workflow-ai проектам и обеспечивающий единое управление тикетами, планами и скилами.

## Что такое workflow-mcp

`workflow-mcp` — Node.js MCP-сервер, предоставляющий:
- управление несколькими проектами одновременно;
- поддержку human-first воркфлоу;
- мониторинг здоровья пайплайнов;
- единую конфигурацию.

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

- `run_skill(project, {skill_name, args?, context?, timeout_sec?})` — выполнить скил с опциональными аргументами и контекстом
- `list_skill_tests(project, {skill_name?})` — список тест-кейсов скила из `index.yaml`
- `run_skill_tests(project, {skill_name, test_ids?, parallel?, timeout_sec?})` — прогон тестов скила со структурированным результатом
- `create_coach_ticket(project, {target_skill, gap_description, evidence_path?, priority?})` — создание coach-gap тикета на улучшение скила

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

### Аналитические инструменты (4 новых tools)

Прикладные метрики скорости и эффективности воркфлоу проекта. Метрики вычисляются по frontmatter тикетов (отдельное хранилище аналитики не требуется).

- `get_velocity(project, {window_days?, group_by?})` — метрика velocity, сгруппированная по дням или неделям
- `get_cycle_time(project, {window_days?, percentiles?})` — статистика cycle time (p50, p90, среднее в секундах)
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

`get_cycle_time` (p50/p90) помогает понять эффективность:
- **p50** — медиана времени от создания до завершения тикета (типичная длительность);
- **p90** — 90-й перцентиль (как долго длятся «самые медленные» 10% тикетов; индикатор выбросов и сложных задач);
- комбинация velocity + cycle_time позволяет ловить узкие места (например, высокий p90 + низкая velocity = задержки в процессе).

### Инструмент поиска
- `cross_project_search({query, projects?, type?, max_results?})` — быстрый поиск кода по нескольким проектам через ripgrep

### Health-мониторинг
- детектор расхождения веток (branch divergence) с настраиваемыми порогами
- алёрты на висящие approval-тикеты

## Конфигурация

### Health-мониторинг

```yaml
health:
  tick_interval_sec: 15
  stuck_headroom_sec: 60
  blocked_accumulation_threshold: 5
  ghost_execution_log_marker: "ghost-execution"
  crash_mtime_freshness_sec: 60
  dedup_fingerprint_ttl_sec: 3600
  approval_pending_threshold_sec: 600
  # Детектор расхождения веток (Sprint 3)
  branch_diverged_max_behind: 10      # Алёрт, если ветка отстаёт от remote
  branch_diverged_max_ahead: 30       # Алёрт, если ветка опережает
  branch_diverged_auto_fetch: false   # Запускать `git fetch` перед проверкой (опционально)
```

### Конфигурация Git-инструментов

```yaml
git:
  default_remote: origin
  default_base_branch: main
  enable_open_pr: auto  # auto | always | never (auto = автоопределение наличия gh CLI)
```

### Конфигурация аналитики

```yaml
analytics:
  default_window_days: 14
  cycle_time_percentiles: [50, 90]
```

### Конфигурация поиска

```yaml
search:
  ripgrep_path: rg        # путь к бинарю ripgrep (по умолчанию: "rg")
  exclude_patterns:
    - "node_modules/**"
    - ".git/**"
    - ".workflow/.cache/**"
```

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

## Migration Guide: переход на workflow-mcp 1.2.0 (Sprint 3)

### Breaking changes отсутствуют

Все существующие tools и конфигурации из версии 1.1.0 остаются без изменений. Новые возможности 1.2.0 полностью обратно-совместимы.

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
  ticket_id: 'HUMAN-001',
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

См. секцию [Конфигурация](#конфигурация) выше:
- ключи `git.*` — управление default remote и поведением PR
- ключи `analytics.*` — окна метрик
- ключи `search.*` — поведение поиска

Полные детали — в [MIGRATION.md](MIGRATION.md).
