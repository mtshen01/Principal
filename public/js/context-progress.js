// context-progress.js — topbar 额度状态组件。
//
// 两个数据源、一个位置：
//  1. **额度圆点**（Claude）：SSE `ratelimit` / 启动查询 → 圆点颜色 + hover 显示重置时间；
//  2. **上下文使用率**（自定义模型）：SSE `usage` → `上下文 27%` chip + hover 显示已用/窗口。
//     自定义模型没有额度事件，此前这块顶栏区域对他完全是空的；现在由上下文使用率接管。
// 两者互不依赖：谁有数据谁显示，都没有则整块隐藏（保持「不占位」的现状）。
import { contextUsageView } from './context-usage.logic.js';

export class ContextProgress {
  constructor(container) {
    this._container = container;
    this._ratelimitState = 'normal'; // 'normal' | 'warning' | 'danger'
    this._resetsAt = null; // unix timestamp (seconds) or null
    this._rate = false; // 是否拿到过额度数据（Claude 路径）
    this._ctx = null; // contextUsageView() 的结果（自定义模型路径）
    this._forcedHidden = false; // 显式 hide() 过的页面态
    this._render();
  }

  _render() {
    const c = this._container;

    this._dot = document.createElement('div');
    this._dot.className = 'cp-dot';

    this._ctxEl = document.createElement('span');
    this._ctxEl.className = 'cp-ctx';
    this._ctxEl.hidden = true;

    this._tooltip = document.createElement('div');
    this._tooltip.className = 'cp-tooltip';
    this._ttRate = document.createElement('div');
    this._ttRate.textContent = '额度正常';
    this._ttCtx = document.createElement('div');
    this._tooltip.appendChild(this._ttRate);
    this._tooltip.appendChild(this._ttCtx);

    c.appendChild(this._dot);
    c.appendChild(this._ctxEl);
    c.appendChild(this._tooltip);

    c.addEventListener('mouseenter', () => this._tooltip.classList.add('visible'));
    c.addEventListener('mouseleave', () => this._tooltip.classList.remove('visible'));
    this._refresh();
  }

  /** 统一重算：圆点/chip 的显隐、chip 文案与分档、tooltip 内容 */
  _refresh() {
    this._dot.hidden = !this._rate;
    this._dot.classList.remove('warning', 'danger');
    if (this._rate && this._ratelimitState !== 'normal') this._dot.classList.add(this._ratelimitState);

    const ctx = this._ctx && !this._ctx.hidden ? this._ctx : null;
    this._ctxEl.hidden = !ctx;
    if (ctx) {
      this._ctxEl.textContent = ctx.label;
      this._ctxEl.dataset.level = ctx.level; // normal | warning | danger（样式见 app.css .cp-ctx）
      this._ctxEl.title = ''; // 自绘 tooltip 已说明一切，别让原生气泡打架
    }
    this._refreshTooltip();
    // 两个数据源都没有 → 整块不显示（与改动前「没跑过就不占顶栏」一致）
    this._container.hidden = this._forcedHidden || (!this._rate && !ctx);
  }

  _refreshTooltip() {
    // 额度行：只有拿到过额度数据才显示（自定义模型下不该谎报「额度正常」）
    this._ttRate.hidden = !this._rate;
    if (this._rate) {
      if (this._resetsAt != null) {
        const diffSec = Math.max(0, this._resetsAt - Math.floor(Date.now() / 1000));
        const diffMin = Math.round(diffSec / 60);
        const stateLabel = this._ratelimitState === 'danger' ? '额度已用尽' : '额度接近上限';
        this._ttRate.textContent = `${stateLabel} · ${diffMin} 分钟后重置`;
      } else {
        const labels = { normal: '额度正常', warning: '额度接近上限', danger: '额度已用尽' };
        this._ttRate.textContent = labels[this._ratelimitState] || '额度正常';
      }
    }

    const ctx = this._ctx && !this._ctx.hidden ? this._ctx : null;
    this._ttCtx.hidden = !ctx;
    this._ttCtx.innerHTML = '';
    if (ctx) {
      for (const line of ctx.lines) {
        const el = document.createElement('div');
        el.textContent = line;
        this._ttCtx.appendChild(el);
      }
    }
  }

  updateRatelimitState(state, resetsAt) {
    this._ratelimitState = state || 'normal';
    this._resetsAt = resetsAt != null ? resetsAt : null;
    this._rate = true;
    this._refresh();
  }

  /** 上下文使用率（自定义模型）：传 contextUsageView() 的结果；无数据/不适用时传 clearContextUsage() */
  updateContextUsage(view) {
    this._ctx = contextUsageView(view || {});
    this._refresh();
  }

  clearContextUsage() {
    this._ctx = null;
    this._refresh();
  }

  show() {
    this._forcedHidden = false;
    this._refresh();
  }

  hide() {
    this._forcedHidden = true;
    this._refresh();
  }
}
