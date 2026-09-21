import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    pool: 'forks',
    // Дефолтных 5 секунд не хватает интеграционным тестам, которые поднимают
    // настоящие git-репозитории и сервер: на Windows один такой тест делает
    // десятки spawn'ов. При полном прогоне они то и дело упирались в лимит —
    // падал каждый раз другой файл, то git-create-branch, то git-client.
    testTimeout: 20000,
    // Здесь стоял `singleFork: true` с обещанием прогнать все файлы в одном
    // процессе. Идентификатора `singleFork` в vitest 4.1.5 нет вовсе (`grep -rl
    // singleFork node_modules/vitest node_modules/@vitest` — пусто), и файлы
    // шли в трёх процессах одновременно (замер: три пробника, pid 10224/20836/
    // 16728, старт в одну миллисекунду, 969 мс при сумме тестов 1.85 с).
    // `poolOptions` в Vitest 4 удалён — сам vitest отвечает на него
    // «`poolOptions` was removed in Vitest 4. All previous `poolOptions` are
    // now top-level options». Последовательный прогон здесь включается
    // верхнеуровневым `fileParallelism: false` (замер: те же пробники, 2.69 с,
    // интервалы не пересекаются). Не включаем: полный прогон в параллельных
    // форках зелёный, а состояние разводит `setupFiles` ниже.
    // Каталог состояния и машинный кеш `gh` уводятся во временный каталог:
    // иначе набор тестов пишет в настоящий профиль пользователя — оставлял
    // пустые каталоги на каждый прогон и подсовывал живому серверу путь к
    // своему stub'у `gh`.
    setupFiles: ['./tests/setup/isolate-state-dir.mjs'],
    exclude: [
      // Рабочая папка пайплайна: там лежат тикеты и логи, а также скрипты
      // скилов с именами вида *.test.mjs, которые vitest'у не принадлежат.
      '.workflow/**',
      // Конфиг стороннего расширения, не код проекта.
      '.kilocode/**',
      // Default vitest excludes
      '**/node_modules/**',
      '**/dist/**',
    ],
  },
});
