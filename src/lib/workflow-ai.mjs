/**
 * Резолв путей внутри пакета `workflow-ai`.
 *
 * До этого девять модулей импортировали код соседнего репозитория напрямую:
 * `../../../workflowAi/src/lib/...`. Это работало только если workflowAi
 * распакован рядом с workflow-mcp и под этим самым именем; из
 * `node_modules/workflow-mcp` такой путь не разрешается вообще, то есть
 * опубликованный пакет был нерабочим. При этом `workflow-ai` всё время был
 * объявлен в зависимостях и просто не использовался.
 *
 * Модули пакета импортируются по имени через его `exports`
 * (`workflow-ai/lib/utils.mjs` и т.д.). Здесь остаётся только то, что через
 * `exports` не достать, потому что это не модули: SKILL.md скилов и шаблоны
 * тикетов, планов и отчётов.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

/** Кеш корня, ключ — база резолва: она может меняться между вызовами в тестах. */
let cached = null;

/**
 * Корень установленного пакета workflow-ai.
 *
 * Резолвим через subpath, который пакет объявляет в `exports`, и поднимаемся
 * до каталога с его package.json.
 *
 * @returns {string} абсолютный путь к корню пакета
 * @throws {Error} если пакет не установлен
 */
export function workflowAiRoot() {
  // WORKFLOW_AI_RESOLVE_PATH переопределяет базу резолва (используется в
  // тестах для изоляции версии).
  const base = process.env.WORKFLOW_AI_RESOLVE_PATH || '';
  if (cached && cached.base === base) {
    return cached.root;
  }

  // Якоримся на подпуть из `exports`: сам package.json пакет не экспортирует.
  // Перебор, а не один путь: этот резолв использует и проверка версии на
  // старте, которой нужно увидеть и старый пакет — чтобы сказать про него внятное
  // слово вместо «не найден». `lib/find-root.mjs` есть в `exports` с самых ранних
  // версий, `lib/utils.mjs` мог появиться позже.
  const ANCHORS = ['workflow-ai/lib/find-root.mjs', 'workflow-ai/lib/utils.mjs'];
  let dir;
  let lastErr;
  for (const anchor of ANCHORS) {
    try {
      dir = path.dirname(require.resolve(anchor, base ? { paths: [base] } : undefined));
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!dir) {
    // Код пробрасываем: по нему сервер отличает «не установлен» от прочих бед.
    const wrapped = new Error(`Пакет workflow-ai не найден: ${lastErr.message}`);
    wrapped.code = lastErr.code;
    throw wrapped;
  }

  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'workflow-ai') {
          cached = { base, root: dir };
          return dir;
        }
      } catch {
        // битый package.json — продолжаем подниматься
      }
    }
    dir = path.dirname(dir);
  }

  throw new Error('Корень пакета workflow-ai не найден выше его модулей');
}

/**
 * Путь внутри пакета workflow-ai.
 *
 * @param {...string} segments сегменты пути относительно корня пакета
 * @returns {string} абсолютный путь
 */
export function workflowAiPath(...segments) {
  return path.join(workflowAiRoot(), ...segments);
}

/**
 * Манифест установленного пакета workflow-ai.
 *
 * Тот же самый обход вверх до package.json жил ещё в трёх местах: в проверке
 * версии на старте сервера, в резолве bin раннера и в `startup-guard.mjs`,
 * который вдобавок никем не импортировался.
 *
 * @returns {Object} содержимое package.json пакета
 * @throws {Error} если пакет не установлен или манифест не читается
 */
export function workflowAiPackageJson() {
  const pkgPath = path.join(workflowAiRoot(), 'package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}
