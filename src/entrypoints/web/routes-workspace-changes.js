/**
 * 未提交改动 HTTP 接口：一个 GET 端点，两种视图。
 *
 * - `GET /api/workspace-changes?cwd=`            → 完整改动（列表 + 内容地图树 + hunks）
 * - `GET /api/workspace-changes?cwd=&view=summary` → 只要计数，供顶栏徽标轮询
 *
 * 一个端点而不是两个：结果在 features 层按 cwd 短 TTL 缓存，
 * 两条路只是同一个结果的不同切片，拆成两个 handler 反而要各写一遍参数校验。
 */
import { sendJson } from './http-util.js';
import { str } from './input.js';
import { logger } from '../../shared/logger.js';
import { collectWorkspaceChanges } from '../../features/workspace-changes/collect.js';
import { summarizeResult } from '../../features/workspace-changes/changes.logic.js';

export async function handleWorkspaceChanges(url, res) {
  const cwd = str(url.searchParams.get('cwd'));
  if (!cwd) return sendJson(res, 400, { error: '缺少 cwd 参数' });

  try {
    const result = await collectWorkspaceChanges({ cwd });
    sendJson(res, 200, url.searchParams.get('view') === 'summary' ? summarizeResult(result) : result);
  } catch (e) {
    if (e?.badRequest) return sendJson(res, 400, { error: e.message });
    logger.warn('workspace-changes', '采集失败', { cwd, err: e?.message || String(e) });
    sendJson(res, 500, { error: e?.message || '采集失败' });
  }
}
