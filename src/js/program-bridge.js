// 各模块 → 节目单 的轻量桥：不直接 import program.js，避免和 audio/video 循环依赖

import { toast } from './util.js';

/** 把本地文件加入当前节目单；type 可强制指定（如 'audio'），否则按扩展名判断 */
export async function requestAddToProgram(paths, type = null) {
  const list = [].concat(paths || []).filter(Boolean);
  if (!list.length) return 0;
  const detail = { paths: list, type };
  document.dispatchEvent(new CustomEvent('sp:add-to-program', { detail }));
  if (!detail.promise) {
    toast('节目单未就绪');
    return 0;
  }
  const n = await detail.promise;
  if (n > 0) toast(n === 1 ? '已加入节目单' : `已加入节目单 ${n} 条`);
  return n;
}
