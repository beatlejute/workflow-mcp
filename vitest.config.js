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
    // Run all test files in a single fork to prevent process.chdir() conflicts
    // and parallel resource contention. Each test file still runs in isolation
    // via vitest's module registry reset between files.
    singleFork: true,
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
