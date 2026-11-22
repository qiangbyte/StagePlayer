// 入口：先恢复 store（各模块 import 时会读 localStorage），再加载主程序。
// 给恢复加超时：卡 IO / 大文件时不再把顶栏「开始/导入」拖成假死。
import { hydrateFromFile } from './store-sync.js';

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    }),
  ]);
}

try {
  // 转写正文可能较大，给足落盘恢复时间，避免超时后模块读到空记录
  window.__spStoreAction = await withTimeout(hydrateFromFile(), 12000, '数据恢复');
} catch (err) {
  console.warn('[boot] 数据恢复跳过，使用本地缓存', err);
  window.__spStoreAction = 'skip';
  // 超时/失败时仍挂上落盘钩子，避免之后改动只留在 WebView 缓存
  try {
    const { setLsWriteHook } = await import('./util.js');
    const { flushStore } = await import('./store-sync.js');
    setLsWriteHook(() => { flushStore(); });
  } catch { /* ignore */ }
}

await import('./main.js');
