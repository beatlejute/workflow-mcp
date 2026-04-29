import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'fs';
import { FrontmatterCache } from '../../src/caches/frontmatter-cache.mjs';

// Мокируем fs и parseFrontmatter
vi.mock('fs');
vi.mock('../../workflowAi/src/lib/utils.mjs', () => ({
  parseFrontmatter: (content) => {
    // Простой парсер frontmatter для тестов
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (match) {
      const frontmatterStr = match[1];
      const obj = {};
      frontmatterStr.split('\n').forEach(line => {
        const [key, ...valueParts] = line.split(':');
        if (key && valueParts.length > 0) {
          obj[key.trim()] = valueParts.join(':').trim();
        }
      });
      return { frontmatter: obj };
    }
    return { frontmatter: {} };
  }
}));

describe('FrontmatterCache', () => {
  let cache;

  beforeEach(() => {
    cache = new FrontmatterCache(1000);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Cache Hit', () => {
    it('should NOT call fs.readFileSync when mtime unchanged', () => {
      const filePath = '/test/ticket.md';
      const mockContent = '---\nid: test-1\ntitle: Test\n---\nContent';
      const mtime = 1000;

      // Первый вызов - должен прочитать файл
      fs.statSync.mockReturnValue({ mtimeMs: mtime });
      fs.readFileSync.mockReturnValue(mockContent);

      const result1 = cache.getFrontmatter(filePath);
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);

      // Очистим счётчик вызовов
      fs.readFileSync.mockClear();

      // Второй вызов - должен вернуть из кеша БЕЗ вызова fs.readFileSync
      fs.statSync.mockReturnValue({ mtimeMs: mtime });
      const result2 = cache.getFrontmatter(filePath);

      expect(fs.readFileSync).toHaveBeenCalledTimes(0);
      expect(result1.frontmatter).toEqual(result2.frontmatter);
      expect(result1.mtime_cached).toBe(result2.mtime_cached);
    });

    it('should return cached frontmatter with correct mtime', () => {
      const filePath = '/test/ticket.md';
      const mockContent = '---\nid: test-1\ntitle: Test\n---\nContent';
      const mtime = 1000;

      fs.statSync.mockReturnValue({ mtimeMs: mtime });
      fs.readFileSync.mockReturnValue(mockContent);

      const result = cache.getFrontmatter(filePath);

      expect(result.mtime_cached).toBe(mtime);
      expect(result.frontmatter.id).toBe('test-1');
    });
  });

  describe('Cache Miss', () => {
    it('should call fs.readFileSync when mtime changed', () => {
      const filePath = '/test/ticket.md';
      const mockContent1 = '---\nid: test-1\ntitle: Test 1\n---\nContent';
      const mockContent2 = '---\nid: test-1\ntitle: Test 2\n---\nContent';
      const mtime1 = 1000;
      const mtime2 = 2000;

      // Первый вызов
      fs.statSync.mockReturnValue({ mtimeMs: mtime1 });
      fs.readFileSync.mockReturnValue(mockContent1);
      const result1 = cache.getFrontmatter(filePath);

      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(result1.mtime_cached).toBe(mtime1);

      // Очистим счётчик
      fs.readFileSync.mockClear();

      // Второй вызов с изменённым mtime
      fs.statSync.mockReturnValue({ mtimeMs: mtime2 });
      fs.readFileSync.mockReturnValue(mockContent2);
      const result2 = cache.getFrontmatter(filePath);

      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
      expect(result2.mtime_cached).toBe(mtime2);
      expect(result2.mtime_cached).not.toBe(result1.mtime_cached);
    });
  });

  describe('Invalidate', () => {
    it('should immediately remove cached entry', () => {
      const filePath = '/test/ticket.md';
      const mockContent = '---\nid: test-1\n---\nContent';

      fs.statSync.mockReturnValue({ mtimeMs: 1000 });
      fs.readFileSync.mockReturnValue(mockContent);

      cache.getFrontmatter(filePath);
      expect(cache.getStats().size).toBe(1);

      cache.invalidate(filePath);
      expect(cache.getStats().size).toBe(0);

      // После инвалидации следующий вызов должен прочитать файл заново
      fs.readFileSync.mockClear();
      fs.statSync.mockReturnValue({ mtimeMs: 1000 });
      fs.readFileSync.mockReturnValue(mockContent);

      cache.getFrontmatter(filePath);
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('LRU Eviction', () => {
    it('should evict LRU entry when cache exceeds maxSize', () => {
      const smallCache = new FrontmatterCache(3);
      const mockContent = '---\nid: test\n---\nContent';

      fs.statSync.mockReturnValue({ mtimeMs: 1000 });
      fs.readFileSync.mockReturnValue(mockContent);

      // Добавляем 4 файла в кеш размером 3
      smallCache.getFrontmatter('/test/file1.md');
      smallCache.getFrontmatter('/test/file2.md');
      smallCache.getFrontmatter('/test/file3.md');

      expect(smallCache.getStats().size).toBe(3);

      // 4-й файл должен вытеснить первый (LRU)
      smallCache.getFrontmatter('/test/file4.md');
      expect(smallCache.getStats().size).toBe(3);

      // Проверяем что первый файл вытеснен
      fs.readFileSync.mockClear();
      fs.statSync.mockReturnValue({ mtimeMs: 1000 });
      fs.readFileSync.mockReturnValue(mockContent);

      smallCache.getFrontmatter('/test/file1.md');
      expect(fs.readFileSync).toHaveBeenCalledTimes(1);
    });

    it('should maintain max size of 1000 when adding 1001 entries', () => {
      const mockContent = '---\nid: test\n---\nContent';

      fs.statSync.mockReturnValue({ mtimeMs: 1000 });
      fs.readFileSync.mockReturnValue(mockContent);

      // Добавляем 1005 файлов
      for (let i = 0; i < 1005; i++) {
        cache.getFrontmatter(`/test/file${i}.md`);
      }

      expect(cache.getStats().size).toBe(1000);
      expect(cache.getStats().maxSize).toBe(1000);
    });

    it('should correctly track LRU order when accessing entries', () => {
      const smallCache = new FrontmatterCache(2);
      const mockContent = '---\nid: test\n---\nContent';

      fs.statSync.mockReturnValue({ mtimeMs: 1000 });
      fs.readFileSync.mockReturnValue(mockContent);

      // Добавляем 2 файла
      smallCache.getFrontmatter('/test/file1.md');
      smallCache.getFrontmatter('/test/file2.md');

      // Обращаемся к file1 (обновляем его LRU позицию)
      fs.readFileSync.mockClear();
      fs.statSync.mockReturnValue({ mtimeMs: 1000 });
      fs.readFileSync.mockReturnValue(mockContent);
      smallCache.getFrontmatter('/test/file1.md');
      expect(fs.readFileSync).toHaveBeenCalledTimes(0); // кеш-хит

      // Добавляем файл3 - должен вытеснить file2 (наименее свежий)
      smallCache.getFrontmatter('/test/file3.md');

      // Проверяем что file2 вытеснен
      fs.readFileSync.mockClear();
      fs.statSync.mockReturnValue({ mtimeMs: 1000 });
      fs.readFileSync.mockReturnValue(mockContent);

      smallCache.getFrontmatter('/test/file2.md');
      expect(fs.readFileSync).toHaveBeenCalledTimes(1); // кеш-мисс
    });
  });
});
