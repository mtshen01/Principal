/**
 * 左侧会话列表「按天分组」纯逻辑 —— 零 DOM，供 chat.js 调用、node --test 直测。
 *
 * 分组规则（按本地时区的自然日边界，而非「距今 24 小时」）：
 * - 今天：updatedAt ≥ 今天 00:00（含未来时间戳，容忍时钟偏差）
 * - 昨天：updatedAt ≥ 昨天 00:00 且 < 今天 00:00
 * - 更早：其余，含缺失/非法时间戳（显示不出时间的老会话不去猜日期）
 *
 * 边界用 new Date(y, m, d ± 1) 构造新日期对象计算，而不是减 24h 常数——
 * 后者在有夏令时的时区会在切换日错一天。
 */

export const DAY_GROUPS = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'earlier', label: '更早' },
];

/** 归属某条时间戳所在的分组 key（ts 毫秒；now 可注入便于测试） */
export function dayGroupOf(ts, now = new Date()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return 'earlier';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfToday) return 'today';
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  if (t >= startOfYesterday) return 'yesterday';
  return 'earlier';
}

/**
 * 把会话条目按天分组，保持传入顺序（上游已按 updatedAt 倒序）。
 * 只返回非空分组：某组没有会话就不渲染该组标题。
 * @param {Array<{updatedAt?:number}>} entries
 * @returns {Array<{key:string, label:string, items:Array}>}
 */
export function groupConvsByDay(entries, now = new Date()) {
  const list = Array.isArray(entries) ? entries : [];
  return DAY_GROUPS
    .map((g) => ({ ...g, items: list.filter((e) => dayGroupOf(e && e.updatedAt, now) === g.key) }))
    .filter((g) => g.items.length);
}
