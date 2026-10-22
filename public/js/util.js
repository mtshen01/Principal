/** 共享 DOM/文本工具：$ 选择器、escapeHtml、debounce。 */
export const $ = (s) => document.querySelector(s);

      // ---- 工具函数 ----
      export function escapeHtml(text) {
        if (!text) return '';
        const map = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#039;'
        };
        return String(text).replace(/[&<>"']/g, (m) => map[m]);
      }

      /** 通用防抖：返回防抖包装后的函数 */
      export function debounce(fn, ms) {
        let t = null;
        const wrapped = (...args) => {
          clearTimeout(t);
          t = setTimeout(() => { t = null; fn(...args); }, ms);
        };
        wrapped.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
        return wrapped;
      }

/** 目录路径 → 末段目录名（req-view / req-chat 的工程芯片共用） */
      export function dirTail(p) {
        if (!p) return '';
        const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
        return parts[parts.length - 1] || p;
      }

/**
 * 是否为 Markdown 文件路径 —— 即「点了能进 Markdown 查看器」的判据，
 * 与 /api/fs/read 的扩展名白名单一一对应，两边必须同进同退。
 *
 * 放在 util 而不是 chat.js：聊天气泡的路径 chip 与需求右栏的 API 文档都要判，
 * 各写一份正则迟早会漂移。
 */
      export function isMarkdownPath(p) {
        return /\.(md|markdown)$/i.test(p);
      }

/**
 * 构造附件下载 URL（保持**相对路径**）。
 *
 * 相对路径是刻意的：桌面版（Tauri release）webview 的源是 `tauri.localhost`，页面里的
 * `/api/**` 指的是**内置资源**而不是后端；把这个改写成本机端口的活由 `bootstrap.js` 的
 * 全局 fetch 包装统一负责。这里再拼一次绝对基址，迟早会和那处改写漂移。
 */
export function fsDownloadUrl(filePath, name = '') {
  return '/api/fs/download?path=' + encodeURIComponent(filePath) + (name ? '&name=' + encodeURIComponent(name) : '');
}

/**
 * 从 Content-Disposition 解析服务端定的文件名。
 *
 * 优先 RFC 5987 的 `filename*`：中文名只有它能保住（`filename=` 那份把非 ASCII 换了占位，
 * 见 routes-files.js#buildContentDisposition）。解析失败（缺头 / 畸形百分号编码）一律回落，
 * 绝不抛 —— 文件名解析不该让一次下载失败。
 */
export function filenameFromDisposition(header, fallback = '') {
  const raw = String(header || '');
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(raw);
  if (star) {
    try {
      const decoded = decodeURIComponent(star[1].trim());
      if (decoded) return decoded;
    } catch {
      /* 畸形编码：走下面的回落 */
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/.exec(raw) || /filename\s*=\s*([^;]+)/.exec(raw);
  return quoted?.[1]?.trim() || fallback;
}

/**
 * 触发附件下载（同事消息附件、需求右栏 API 文档、需求正文附件共用）。
 *
 * 2026-10-15 改为「fetch 取字节 → Blob → 临时 <a download>」，不再直接 `<a href="/api/fs/download?…">` 点一下。
 * 两件事都是那次改动要修的：
 *
 * 1. **桌面版下到的是应用自己的 HTML**。`<a>` 的点击是**导航**，不经过 `bootstrap.js` 的 fetch 包装，
 *    于是打到 `tauri.localhost` 的内置资源上；`/api/fs/download` 末段没有扩展名，正好命中资源协议的
 *    「找不到就回落 index.html」——用户拿到的 `02_meal_reminder_…_api.md` 里其实是整个应用页面。
 *    改走 fetch 后，相对路径由包装改写到本机端口，端点才真的被调到。
 * 2. **点完没有任何完成信号**。导航式下载给不了回调，用户不知道下没下到；fetch 拿到字节就能提示，
 *    失败（404 / 400 / 掉线）也有明确文案。
 *
 * 文件名仍以服务端 Content-Disposition 为准（`name` 只是兜底：盘上是带随机前缀的副本名，
 * 用户要的是登记名）；跨源读该头需要服务端 `Access-Control-Expose-Headers`（server.js 已加）。
 *
 * 放在 util 而不是各自的模块：三处都要下载，各写一份 URL 拼装迟早在转义上漂移（同 isMarkdownPath 的理由）。
 *
 * @param {string} filePath 服务器可识别的绝对路径（`.uploads/` 树内）
 * @param {string} [name] 登记名（用户看到的文件名），缺省则用服务端定的名字
 */
export async function downloadFile(filePath, name = '') {
  let resp;
  try {
    resp = await fetch(fsDownloadUrl(filePath, name));
  } catch (e) {
    // 网络层失败的分类与掉线罩由 bootstrap.js 的 fetch 包装负责，这里只补一句就地说明
    window.toast?.error('下载失败：' + (e?.message || e));
    return;
  }
  if (!resp.ok) {
    // 端点失败时回的是 JSON 错误（缺参 400 / 文件不存在 404 …），拿不到就退回状态码
    const data = await resp.json?.().catch(() => null);
    window.toast?.error(data?.error || `下载失败（HTTP ${resp.status}）`);
    return;
  }
  const blob = await resp.blob();
  const fallback = name || String(filePath).split(/[\\/]/).pop() || 'download';
  const filename = filenameFromDisposition(resp.headers?.get?.('content-disposition'), fallback);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分 webview 把这次下载当成被取消，留一拍再回收
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
  window.toast?.success(`已下载：${filename}`);
}

/** 时间戳 → 本地中文时间串（logs / tasks 共用） */
      export function fmtTime(iso) {
        try {
          return new Date(iso).toLocaleString('zh-CN', { hour12: false });
        } catch {
          return iso;
        }
      }

/** markdown 渲染（window.marked 可用则富文本，否则纯文本兜底；chat 气泡与任务卡共用） */
      export function renderMarkdown(el, text) {
        const s = text == null ? '' : String(text);
        // 消毒是**强制**的，不是可选增强：喂进来的全是不可信输入（模型输出、模型读到的
        // 文件/网页内容、飞书用户消息、AI 分析结论），且会话存 localStorage 刷新即重放。
        // marked 自 v5 起已移除 sanitize 选项，原始 HTML 默认透传。
        // 在 Tauri 下这条会升级成本机 RCE（webview 可达 shell:allow-execute），
        // 因此 DOMPurify 缺失时宁可退化成纯文本，也绝不把未消毒的 HTML 写进 DOM。
        if (window.marked && typeof marked.parse === 'function'
            && window.DOMPurify && typeof DOMPurify.sanitize === 'function') {
          try {
            el.innerHTML = DOMPurify.sanitize(marked.parse(s));
            el.classList.add('md');
            return;
          } catch {}
        }
        el.textContent = s;
      }

/**
 * 安全写 localStorage —— 绝不让存储异常打断调用方的主流程。
 *
 * 背景：全前端 30 处裸 localStorage.setItem，其中 send() 的第一行就是一处。
 * 一旦触发 QuotaExceededError（claude_convs 保存每个会话的每条消息全文且无任何裁剪/过期策略，
 * 长期使用后必然突破 ~5MB）或 Safari 无痕模式的写入限制，
 * 抛出的异常会让**按 Enter 完全没反应，连自己刚输入的消息都不上屏**。
 * 写失败是可以接受的降级（下次刷新丢一点 UI 偏好），把交互打断则不可接受。
 *
 * @returns {boolean} 是否写入成功，调用方需要时可据此提示
 */
export function lsSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('[localStorage] 写入失败（配额满或隐私模式）:', key, e?.name || e);
    return false;
  }
}

/** 安全读 localStorage：隐私模式下 getItem 也可能抛异常 */
export function lsGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
