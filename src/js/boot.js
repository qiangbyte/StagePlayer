// 入口：先从 store.json 恢复数据，再加载主程序（各模块在导入时就会读 localStorage）
import { hydrateFromFile } from './store-sync.js';

try {
  window.__spStoreAction = await hydrateFromFile();
} catch (err) {
  console.warn('[boot] 数据恢复失败，使用本地缓存', err);
}
await import('./main.js');
