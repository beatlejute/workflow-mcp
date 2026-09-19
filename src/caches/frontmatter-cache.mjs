import fs from 'fs';
import path from 'path';
import { parseFrontmatter } from 'workflow-ai/lib/utils.mjs';

/**
 * LRU-кеш для frontmatter тикетов.
 * Инвалидируется по mtime, имеет максимум 1000 записей.
 */
class FrontmatterCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map(); // filePath → { frontmatter, mtime_cached }
    this.accessOrder = []; // отслеживание порядка доступа для LRU
  }

  /**
   * Получить frontmatter файла, используя кеш если возможно.
   * @param {string} filePath - Абсолютный путь к файлу
   * @returns {{ frontmatter: object, mtime_cached: number }} Frontmatter и время кеширования
   */
  getFrontmatter(filePath) {
    try {
      // Получить текущий mtime файла
      const stats = fs.statSync(filePath);
      const currentMtime = stats.mtimeMs;

      // Проверить кеш
      if (this.cache.has(filePath)) {
        const cached = this.cache.get(filePath);
        // Кеш-хит: файл не был изменён
        if (cached.mtime_cached >= currentMtime) {
          this._updateAccessOrder(filePath);
          return {
            frontmatter: cached.frontmatter,
            mtime_cached: cached.mtime_cached
          };
        }
      }

      // Кеш-мисс: прочитать файл и обновить кеш
      const content = fs.readFileSync(filePath, 'utf8');
      const { frontmatter } = parseFrontmatter(content);

      const cacheEntry = {
        frontmatter,
        mtime_cached: currentMtime
      };

      this.cache.set(filePath, cacheEntry);
      this._updateAccessOrder(filePath);

      // Проверить LRU eviction
      this._evictIfNeeded();

      return {
        frontmatter,
        mtime_cached: currentMtime
      };
    } catch (error) {
      throw new Error(`Failed to get frontmatter for ${filePath}: ${error.message}`);
    }
  }

  /**
   * Явная инвалидация записи в кеше.
   * @param {string} filePath - Абсолютный путь к файлу
   */
  invalidate(filePath) {
    this.cache.delete(filePath);
    this.accessOrder = this.accessOrder.filter(p => p !== filePath);
  }

  /**
   * Обновить порядок доступа (переместить в конец как самый свежий).
   * @private
   */
  _updateAccessOrder(filePath) {
    // Удалить из массива если есть
    const index = this.accessOrder.indexOf(filePath);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
    // Добавить в конец (самый свежий)
    this.accessOrder.push(filePath);
  }

  /**
   * Проверить и выселить наиболее давно неиспользованные записи.
   * @private
   */
  _evictIfNeeded() {
    while (this.cache.size > this.maxSize) {
      // Первый элемент accessOrder — самый старый (наименее недавно использованный)
      const lru = this.accessOrder.shift();
      if (lru) {
        this.cache.delete(lru);
      }
    }
  }

  /**
   * Получить статистику кеша (для отладки).
   * @returns {{ size: number, maxSize: number }}
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }

  /**
   * Очистить весь кеш.
   */
  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }
}

// Экспортировать класс для тестирования
export { FrontmatterCache };

// Создать глобальный singleton экземпляр
export const frontmatterCache = new FrontmatterCache(1000);

/**
 * Получить frontmatter тикета с кешированием.
 * @param {string} filePath - Абсолютный путь к файлу тикета
 * @returns {{ frontmatter: object, mtime_cached: number }}
 */
export function getFrontmatter(filePath) {
  return frontmatterCache.getFrontmatter(filePath);
}

/**
 * Инвалидировать запись кеша.
 * @param {string} filePath - Абсолютный путь к файлу
 */
export function invalidate(filePath) {
  frontmatterCache.invalidate(filePath);
}

export default frontmatterCache;
