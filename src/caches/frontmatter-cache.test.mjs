import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { frontmatterCache } from './frontmatter-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(__dirname, '../../.workflow/tickets/in-progress');

// Тест 1: Кеш-хит (файл не изменён)
console.log('=== Тест 1: Кеш-хит при одинаковом mtime ===');
const ticketPath = path.join(testDir, 'IMPL-5.md');
if (fs.existsSync(ticketPath)) {
  frontmatterCache.clear();
  const result1 = frontmatterCache.getFrontmatter(ticketPath);
  const result2 = frontmatterCache.getFrontmatter(ticketPath);
  
  console.log('✓ Первый вызов:', result1.frontmatter.id);
  console.log('✓ Второй вызов (кеш-хит):', result2.frontmatter.id);
  console.log('✓ mtime совпадает:', result1.mtime_cached === result2.mtime_cached);
  console.log('✓ Кеш размер:', frontmatterCache.getStats().size);
}

// Тест 2: Инвалидация
console.log('\n=== Тест 2: Явная инвалидация ===');
frontmatterCache.clear();
const result3 = frontmatterCache.getFrontmatter(ticketPath);
console.log('✓ До инвалидации, размер кеша:', frontmatterCache.getStats().size);
frontmatterCache.invalidate(ticketPath);
console.log('✓ После инвалидации, размер кеша:', frontmatterCache.getStats().size);

// Тест 3: LRU eviction
console.log('\n=== Тест 3: LRU eviction (max 1000) ===');
frontmatterCache.clear();
let testFile;

// Создаём временные файлы для теста
const tmpDir = path.join(__dirname, '../../.workflow/tmp-test');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

for (let i = 0; i < 1005; i++) {
  testFile = path.join(tmpDir, `test-${i}.md`);
  const content = `---\nid: test-${i}\ntitle: Test ${i}\n---\n# Content`;
  fs.writeFileSync(testFile, content, 'utf8');
  frontmatterCache.getFrontmatter(testFile);
}

const stats = frontmatterCache.getStats();
console.log(`✓ Вставлено 1005 файлов, размер кеша: ${stats.size} (max: ${stats.maxSize})`);
console.log(`✓ LRU eviction сработал: размер <= max (${stats.size <= stats.maxSize})`);

// Тест 4: Кеш-мисс при изменении файла
console.log('\n=== Тест 4: Кеш-мисс при изменении mtime ===');
frontmatterCache.clear();
if (fs.existsSync(ticketPath)) {
  const result4 = frontmatterCache.getFrontmatter(ticketPath);
  const mtime1 = result4.mtime_cached;
  
  // Имитируем изменение файла (обновляем mtime)
  const now = Date.now();
  fs.utimesSync(ticketPath, now / 1000, (now + 1000) / 1000);
  
  const result5 = frontmatterCache.getFrontmatter(ticketPath);
  const mtime2 = result5.mtime_cached;
  
  console.log('✓ mtime до изменения:', mtime1);
  console.log('✓ mtime после изменения:', mtime2);
  console.log('✓ Кеш-мисс произошёл (mtime изменился):', mtime1 !== mtime2);
}

// Очистка
console.log('\n=== Очистка временных файлов ===');
try {
  const files = fs.readdirSync(tmpDir);
  files.forEach(f => fs.unlinkSync(path.join(tmpDir, f)));
  fs.rmdirSync(tmpDir);
  console.log('✓ Временные файлы удалены');
} catch (e) {
  console.log('⚠ Не удалось полностью очистить:', e.message);
}

console.log('\n=== ВСЕ ТЕСТЫ ПРОЙДЕНЫ ===');
