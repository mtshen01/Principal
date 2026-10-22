/** 设置页面板：Claude 账号池 / 自定义模型凭证 / MCP 服务器 / 基础偏好 / 配置导入导出。
 *  机器人（凭证/角色/文案/动作）在 bots-panel.js。
 *  入口 loadSettings + bindConfigTransfer 由 showView('settings') 调用；设置按钮绑定留在 app.js。 */
import { $ } from './util.js';
import { toast, confirmDialog, promptDialog } from './ui.js';
// 厂商预设抽成独立模块：新用户引导也要用，留在本文件里第二个使用方只能复制一份
import { VENDOR_PRESETS, BASEURL_TO_VENDOR } from './vendor-presets.js';
// 导入流程同样抽出：新用户引导也要一键导入，只是不需要那句覆盖确认
import { importConfigFile } from './config-import.js';
import { iconHtml, DELETE_ICON_SVG, EDIT_ICON_SVG, REFRESH_ICON_SVG } from './icons.js';

// 订阅类型配置：扩展时同步更新 index.html #tokenSubscription 的 options
const SUBSCRIPTION_TYPES = [
  { value: 'claude', label: 'Claude' },
];

// ---- 功能模型（设置 → 模型 → 功能模型）----
// 任务清单由后端下发（GET /api/settings.modelTasks），这里只放「Claude 可选模型」清单：
// 与聊天 pills / 基础默认模型保持一致，避免两处各写一份漂移。
const CLAUDE_TASK_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-5', label: 'Haiku 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];
let _modelTaskView = null; // GET /api/settings 下发的任务视图（含当前值与默认值）
let _credentialsCache = []; // 自定义模型凭证（下拉里的 optgroup 数据源）

      // ==== 设置页（飞书凭证 + 备用 token） ====

      function fmtReset(sec) {
        if (!sec) return '';
        return '重置 ' + new Date(sec * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
      }

      export async function loadSettings() {
        let d;
        try {
          d = await (await fetch('/api/settings')).json();
        } catch {
          toast('读取设置失败');
          return;
        }
        const st = $('#feishuState');
        const map = { connected: ['🟢 连接正常', 'ok'], reconnecting: ['🔴 重连中', 'bad'], connecting: ['🟡 连接中', 'warn'], failed: ['⚠️ 未连接', 'warn'], idle: ['— 未启动', 'warn'] };
        const [txt, cls] = map[d.feishu?.state] || map.idle;
        st.textContent = txt;
        st.className = 'feishu-state ' + cls;
        st.title = d.feishu?.error || '';
        $('#activeToken').textContent = d.active ? '当前：' + d.active.label : '当前：默认登录';
        renderTokenList(d.tokens || []);
        _modelTaskView = d.modelTasks || null; // 功能模型视图（先渲染；凭证到位后会再渲染一次补全自定义模型项）
        renderModelTasks();
        loadCredentials(); // 自定义模型凭证走独立端点，随设置面板一起加载
        loadMcpServers(); // MCP 服务器同上
        loadBuiltins(); // 内置 MCP / Skills 开关同上
        loadPlugins(); // 插件启停同上
        setupVendorListener(); // 仅绑定表单事件，不依赖异步数据，可同步调用
        // 填充基础 tab
        const prefs = d.uiPrefs || {};
        const basicDefaultModel = document.getElementById('basicDefaultModel');
        if (basicDefaultModel) basicDefaultModel.value = prefs.defaultModel || '';
        const basicDefaultEffort = document.getElementById('basicDefaultEffort');
        if (basicDefaultEffort) basicDefaultEffort.value = prefs.defaultEffort || '';
        const basicDefaultMode = document.getElementById('basicDefaultMode');
        if (basicDefaultMode) basicDefaultMode.value = prefs.defaultMode || '';
        const basicOpenaiMaxSteps = document.getElementById('basicOpenaiMaxSteps');
        if (basicOpenaiMaxSteps) basicOpenaiMaxSteps.value = prefs.openaiMaxSteps ? String(prefs.openaiMaxSteps) : '';
        // 联网搜索（自定义模型 WebSearch）：{ provider, apiKey }
        const basicSearchProvider = document.getElementById('basicSearchProvider');
        if (basicSearchProvider) basicSearchProvider.value = d.search?.provider || '';
        const basicSearchKey = document.getElementById('basicSearchKey');
        if (basicSearchKey) basicSearchKey.value = d.search?.apiKey || '';
        const basicMyFeishuOpenId = document.getElementById('basicMyFeishuOpenId');
        if (basicMyFeishuOpenId) basicMyFeishuOpenId.value = d.myFeishuOpenId || '';
        const repoMapToggle = document.getElementById('repoMapToggleInput');
        if (repoMapToggle) repoMapToggle.checked = d.repoMap?.enabled !== false;
        // Bash 执行后端（自定义模型；T6）：{ backend, image, network }
        const basicExecBackend = document.getElementById('basicExecBackend');
        if (basicExecBackend) basicExecBackend.value = d.exec?.backend === 'container' ? 'container' : 'local';
        const basicExecImage = document.getElementById('basicExecImage');
        if (basicExecImage) basicExecImage.value = d.exec?.image || '';
        const basicExecNetwork = document.getElementById('basicExecNetwork');
        if (basicExecNetwork) basicExecNetwork.checked = !!d.exec?.network;
        syncExecBackendFields(); // 本机后端时容器两项灰置
      }

      // 导入 / 导出配置：导出走 Blob 下载；导入选文件→前端校验→确认→POST→reload
      export function bindConfigTransfer() {
        const exportBtn = document.getElementById('cfgExportBtn');
        const importBtn = document.getElementById('cfgImportBtn');
        const fileInput = document.getElementById('cfgImportFile');
        if (!exportBtn || !importBtn || !fileInput) return;
        if (exportBtn._bound) return; // 防重复绑定
        exportBtn._bound = true;

        exportBtn.addEventListener('click', async () => {
          try {
            const r = await fetch('/api/settings/export');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const date = new Date().toISOString().slice(0, 10);
            a.href = url;
            a.download = 'claude-agent-config-' + date + '.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            toast('配置已导出');
          } catch (e) {
            toast('导出失败：' + (e && e.message || e));
          }
        });

        importBtn.addEventListener('click', () => fileInput.click());

        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          fileInput.value = ''; // 允许再次选同一文件
          if (!file) return;
          const r = await importConfigFile(file, {
            confirm: () =>
              confirmDialog({
                title: '导入配置',
                message: '导入将覆盖当前全部配置（机器人 / 账号池 / 托管配置 / 偏好），确认继续？覆盖后不可恢复。',
                confirmText: '确认导入',
                danger: true,
              }),
          });
          if (r.cancelled) return;
          if (!r.ok) {
            toast('导入失败：' + r.error);
            return;
          }
          // 旧版包不含托管配置，得明说；否则用户以为配齐了，回头发现动作全没了
          toast(
            r.actionConfigsImported
              ? '导入成功（含托管配置），正在重新加载…'
              : '导入成功。该文件为旧版，不含托管配置，需到设置页重新配置动作',
          );
          setTimeout(() => location.reload(), r.actionConfigsImported ? 800 : 2400);
        });
      }

      function renderTokenList(tokens) {
        const box = $('#tokenList');
        box.innerHTML = '';
        tokens.forEach((t, i) => {
          const row = document.createElement('div');
          row.className = 'token-row';
          row.draggable = true;
          row.dataset.id = t.id;
          const badgeText = { healthy: '✓健康', warning: '⚠即将耗尽', exhausted: '⛔耗尽' }[t.status] || t.status;
          const util = typeof t.utilization === 'number' ? ' ' + Math.round(t.utilization * 100) + '%' : '';
          row.innerHTML =
            '<span class="drag" title="拖拽调整优先级">⠿</span>' +
            '<span class="t-badge ' + t.status + '">' + badgeText + util + '</span>' +
            '<span class="t-label"></span>' +
            '<span class="t-mask"></span>' +
            '<span class="t-reset">' + (t.status !== 'healthy' ? fmtReset(t.resetsAt) : '') + '</span>' +
            '<span class="spacer"></span>' +
            (i === 0
              ? '<span class="t-primary" title="列表首位 = 偏好最高">★ 首选</span>'
              : '<button class="t-act make-primary" title="置顶为首选账号">设为当前</button>') +
            '<button class="t-act rename" title="改名">' + iconHtml(EDIT_ICON_SVG) + '</button>' +
            '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
          row.querySelector('.t-label').textContent = t.label;
          row.querySelector('.t-mask').textContent = t.masked;
          row.querySelector('.rename').onclick = () => renameToken(t.id, t.label);
          row.querySelector('.del').onclick = () => deleteToken(t.id, t.label);
          const mk = row.querySelector('.make-primary');
          if (mk) mk.onclick = () => makePrimary(t);
          bindDrag(row, box);
          box.appendChild(row);
        });
      }

      function bindDrag(row, box) {
        row.addEventListener('dragstart', () => row.classList.add('dragging'));
        row.addEventListener('dragend', async () => {
          row.classList.remove('dragging');
          const ids = [...box.querySelectorAll('.token-row')].map((r) => r.dataset.id);
          await postSettings({ section: 'tokens', action: 'reorder', ids });
          await loadSettings();
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          const dragging = box.querySelector('.dragging');
          if (!dragging || dragging === row) return;
          const rect = row.getBoundingClientRect();
          const after = e.clientY > rect.top + rect.height / 2;
          box.insertBefore(dragging, after ? row.nextSibling : row);
        });
      }

      async function postSettings(payload) {
        try {
          const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const d = await r.json();
          if (!r.ok || d.error) {
            toast(d.error || '保存失败');
            return false;
          }
          return d; // 返回响应体（对象恒为真值，调用方 `if (await ...)` 语义不变）
        } catch {
          toast('网络错误');
          return false;
        }
      }

      /** Bash 执行后端（T6）：本机后端时「容器镜像 / 容器内允许网络」灰置（值保留，切回容器即恢复） */
      function syncExecBackendFields() {
        const isContainer = document.getElementById('basicExecBackend')?.value === 'container';
        const image = document.getElementById('basicExecImage');
        if (image) image.disabled = !isContainer;
        const network = document.getElementById('basicExecNetwork');
        if (network) network.disabled = !isContainer;
      }

      async function addTokenUI() {
        const label = $('#tokenLabel').value.trim();
        const subscription = $('#tokenSubscription')?.value.trim() ?? '';
        const token = $('#tokenValue').value.trim();

        if (!subscription) return toast('请选择订阅类型');
        if (!token) return toast('请填 token');

        if (await postSettings({ section: 'tokens', action: 'add', label, subscription, token })) {
          $('#tokenLabel').value = '';
          if ($('#tokenSubscription')) $('#tokenSubscription').value = 'claude';
          $('#tokenValue').value = '';
          await loadSettings();
        }
      }

      /** 复制取 key 的命令。
       *  命令文本从 DOM 读而不是在 JS 里写死第二份：写死就成了两处真相，
       *  改命令必漏一处，而漏的那一处恰恰是用户真正复制走的那一处。 */
      async function copySetupTokenCmd() {
        const cmd = $('#setupTokenCmd')?.textContent?.trim();
        if (!cmd) return;
        try {
          await navigator.clipboard.writeText(cmd);
          toast('已复制：' + cmd);
        } catch {
          // 剪贴板不可用（无安全上下文 / 用户拒权）。命令块挂了 user-select:all，
          // 点一下就能整条选中，所以这里指路手选而不是干巴巴报「复制失败」
          toast('复制失败，请点击命令后手动复制');
        }
      }

      async function renameToken(id, cur) {
        const label = await promptDialog({
          title: '重命名账号',
          message: '为该账号设置一个便于识别的名称。',
          value: cur,
          placeholder: '例如：主力号 / 备用号',
          confirmText: '保存',
        });
        if (label == null) return;
        if (await postSettings({ section: 'tokens', action: 'update', id, label: label.trim() })) await loadSettings();
      }

      async function deleteToken(id, label) {
        if (!(await confirmDialog({ title: '删除账号', message: `确认删除「${label}」？`, danger: true }))) return;
        if (await postSettings({ section: 'tokens', action: 'remove', id })) await loadSettings();
      }

      // 置顶 = 设为首选：复用 reorder，pickActive 顺序优先 → 可用则立即成为 active
      async function makePrimary(t) {
        const ids = [...$('#tokenList').querySelectorAll('.token-row')].map((r) => r.dataset.id);
        const next = [t.id, ...ids.filter((id) => id !== t.id)];
        if (await postSettings({ section: 'tokens', action: 'reorder', ids: next })) {
          if (t.status === 'exhausted') toast('该账号额度已耗尽，已设为首选，恢复后自动启用');
          await loadSettings();
        }
      }

      // ---- 厂商选择联动 ----
      function setupVendorListener() {
        const vendorSelect = $('#credVendor');
        const baseURLInput = $('#credBaseURL');

        if (!vendorSelect) return; // DOM 未挂载时忽略

        // 防止重复绑定
        if (vendorSelect._vendorBound) return;
        vendorSelect._vendorBound = true;

        // OpenCode 式：添加表单不再选模型——切厂商只联动 baseURL，模型列表由添加后自动发现
        vendorSelect.addEventListener('change', (e) => {
          const vendor = e.target.value;
          const preset = VENDOR_PRESETS[vendor];

          if (!vendor) {
            baseURLInput.disabled = false;
            baseURLInput.value = '';
            return;
          }
          if (!preset) return; // 未知 vendor 值，跳过，不崩溃

          if (vendor === 'custom') {
            // 其他（自定义）：无预设可依，baseURL 由用户填
            baseURLInput.disabled = false;
            baseURLInput.placeholder = 'https://api.xxx.com/v1';
            baseURLInput.value = '';
          } else {
            // 预设厂商：baseURL 锁定
            baseURLInput.disabled = true;
            baseURLInput.value = preset.baseURL;
          }
        });
      }

      // —— 自定义模型（openai-compat）凭证 CRUD：走专用 /api/credentials（片B），不经 settings 池 ——
      async function loadCredentials() {
        try {
          const r = await fetch('/api/credentials');
          const d = await r.json();
          _credentialsCache = d.credentials || [];
          renderCredList(_credentialsCache);
          renderModelTasks(); // 凭证变化会增减「功能模型」下拉里的自定义模型选项
        } catch {
          /* 设置未打开 / 网络问题：忽略 */
        }
      }

      /** 调刷新端点（设置页/弹层共用语义）：归一 {ok, models} / {ok:false, error} */
      async function postRefreshCredModels(id) {
        try {
          const r = await fetch('/api/credentials/' + encodeURIComponent(id) + '/refresh-models', { method: 'POST' });
          const d = await r.json();
          if (!r.ok || d.error) return { ok: false, error: d.error || 'HTTP ' + r.status };
          return { ok: true, models: d.models || [] };
        } catch {
          return { ok: false, error: '网络错误' };
        }
      }

      async function refreshCredentialModels(id) {
        const m = await postRefreshCredModels(id);
        if (m.ok) toast(`已获取 ${m.models.length} 个模型`);
        else toast('获取失败：' + m.error);
        await loadCredentials();
      }

      function renderCredList(creds) {
        const box = $('#credList');
        if (!box) return;
        box.innerHTML = '';
        if (!creds.length) {
          box.innerHTML = '<div class="cred-empty">暂无自定义模型，填下方表单添加</div>';
          return;
        }
        creds.forEach((c) => {
          const row = document.createElement('div');
          row.className = 'token-row';
          row.dataset.id = c.id;
          // 存量凭证无 vendor → 按 baseURL 反查；未知厂商 key 原样显示（不吞信息）
          const vendorKey = c.vendor || BASEURL_TO_VENDOR[c.baseURL] || '';
          const vendorLabel = vendorKey ? (VENDOR_PRESETS[vendorKey]?.label || vendorKey) : '—';
          const displayName = c.label || ('(未命名) - ' + vendorLabel);
          row.innerHTML =
            '<span class="t-label"></span>' +
            '<span class="t-vendor"></span>' +
            '<span class="t-model"></span>' +
            '<span class="t-base"></span>' +
            '<span class="t-mask"></span>' +
            '<span class="spacer"></span>' +
            '<button class="t-act edit" title="修改凭证（名称 / Key / baseURL / 厂商）">' + iconHtml(EDIT_ICON_SVG) + '</button>' +
            '<button class="t-act refresh" title="从服务商重新拉取模型列表">' + iconHtml(REFRESH_ICON_SVG) + '</button>' +
            '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
          row.querySelector('.t-label').textContent = displayName;
          row.querySelector('.t-vendor').textContent = vendorLabel;
          // 模型列表（OpenCode 式）：显示数量，完整列表进 title；未获取给可操作提示
          const models = Array.isArray(c.models) ? c.models : [];
          const modelCell = row.querySelector('.t-model');
          modelCell.textContent = models.length ? `${models.length} 个模型` : '未获取模型';
          modelCell.title = models.length ? models.map((m) => m.name || m.id).join('\n') : '添加后自动获取；也可点右侧刷新按钮重试';
          row.querySelector('.t-base').textContent = c.baseURL || '';
          row.querySelector('.t-mask').textContent = c.masked || '';
          row.querySelector('.edit').onclick = () => editCredential(c);
          row.querySelector('.refresh').onclick = () => refreshCredentialModels(c.id);
          row.querySelector('.del').onclick = () => deleteCredential(c.id, displayName);
          box.appendChild(row);
        });
      }

      async function addCredentialUI() {
        const label = $('#credLabel').value.trim();
        const vendor = $('#credVendor').value.trim();
        const baseURL = $('#credBaseURL').value.trim();
        const apiKey = $('#credApiKey').value.trim();

        if (!vendor) return toast('请选择厂商');
        if (!baseURL) return toast('请填写或确认 baseURL');
        if (!apiKey) return toast('请填写 apiKey');

        try {
          const r = await fetch('/api/credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ label, vendor, baseURL, apiKey }),
          });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '添加失败');

          // 重置表单
          $('#credLabel').value = '';
          const vs = $('#credVendor');
          vs.value = '';
          vs.dispatchEvent(new Event('change'));
          $('#credBaseURL').value = '';
          $('#credBaseURL').disabled = false;
          $('#credApiKey').value = '';

          // 添加即自动发现模型（OpenCode 式）；失败不阻塞——凭证已存，可稍后点「刷新模型」
          const id = d.credential?.id;
          if (!id) {
            toast('自定义模型凭证已添加');
          } else {
            toast('已添加，正在获取模型列表…');
            const m = await postRefreshCredModels(id);
            toast(m.ok ? `已添加，发现 ${m.models.length} 个模型` : `已添加（模型列表获取失败：${m.error}，可在列表中刷新）`);
          }
          await loadCredentials();
        } catch {
          toast('网络错误');
        }
      }

      async function deleteCredential(id, label) {
        if (!(await confirmDialog({ title: '删除自定义模型', message: `确认删除「${label}」？`, danger: true }))) return;
        try {
          const r = await fetch('/api/credentials/' + encodeURIComponent(id), { method: 'DELETE' });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '删除失败');
          await loadCredentials();
        } catch {
          toast('网络错误');
        }
      }

      /** 修改凭证弹窗：apiKey 留空 = 不修改；厂商 / baseURL 变更会清空已发现模型（后端行为），保存后提示刷新 */
      function credEditDialog(c) {
        return new Promise((resolve) => {
          const vendorKey = c.vendor || BASEURL_TO_VENDOR[c.baseURL] || '';
          const mask = document.createElement('div');
          mask.className = 'mask';
          mask.innerHTML =
            '<div class="modal confirm-modal cred-edit-modal">' +
            '<div class="head"><h3>修改自定义模型凭证</h3></div>' +
            '<div class="body">' +
            '<label class="set-field">名称<input class="f-label" type="text" autocomplete="off" /></label>' +
            '<label class="set-field">厂商<select class="f-vendor set-select">' +
            '<option value="">-- 选择厂商 --</option>' +
            '<option value="openai">OpenAI</option>' +
            '<option value="deepseek">DeepSeek</option>' +
            '<option value="aliyun">阿里云百炼</option>' +
            '<option value="moonshot">月之暗面</option>' +
            '<option value="zhipu">智谱</option>' +
            '<option value="custom">其他（自定义）</option>' +
            '</select></label>' +
            '<label class="set-field">baseURL<input class="f-base" type="text" autocomplete="off" /></label>' +
            '<label class="set-field">API Key<input class="f-key" type="password" placeholder="留空 = 不修改" autocomplete="new-password" /></label>' +
            '<div class="cred-edit-note">修改厂商 / baseURL 会清空已获取的模型列表，保存后请点凭证行上的「刷新模型」重新获取。</div>' +
            '</div>' +
            '<div class="confirm-foot"><button class="btn cancel">取消</button><button class="btn ok primary">保存</button></div>' +
            '</div>';
          const sel = mask.querySelector('.f-vendor');
          // 存量凭证的未知 vendor（原样显示，不吞信息）
          if (vendorKey && ![...sel.options].some((o) => o.value === vendorKey)) {
            const o = document.createElement('option');
            o.value = vendorKey;
            o.textContent = VENDOR_PRESETS[vendorKey]?.label || vendorKey;
            sel.appendChild(o);
          }
          sel.value = vendorKey;
          mask.querySelector('.f-label').value = c.label || '';
          mask.querySelector('.f-base').value = c.baseURL || '';
          const close = (val) => {
            mask.remove();
            document.removeEventListener('keydown', onKey);
            resolve(val);
          };
          const onKey = (e) => {
            if (e.key === 'Escape') close(null);
            else if (e.key === 'Enter') close(collect());
          };
          const collect = () => {
            const out = {
              label: mask.querySelector('.f-label').value.trim(),
              vendor: mask.querySelector('.f-vendor').value.trim(),
              baseURL: mask.querySelector('.f-base').value.trim(),
            };
            const key = mask.querySelector('.f-key').value.trim();
            if (key) out.apiKey = key;
            return out;
          };
          mask.querySelector('.cancel').onclick = () => close(null);
          mask.querySelector('.ok').onclick = () => close(collect());
          mask.addEventListener('click', (e) => {
            if (e.target === mask) close(null);
          });
          document.addEventListener('keydown', onKey);
          document.body.appendChild(mask);
          mask.querySelector('.f-label').focus();
        });
      }

      async function editCredential(c) {
        const patch = await credEditDialog(c);
        if (!patch) return;
        if (!patch.baseURL) return toast('baseURL 不能为空');
        try {
          const r = await fetch('/api/credentials/' + encodeURIComponent(c.id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '保存失败');
          toast('已保存');
          // 换了厂商 / baseURL → 模型列表被后端清空；顺手自动重新发现（失败不阻塞）
          const changedEndpoint =
            (patch.baseURL && patch.baseURL !== (c.baseURL || '')) ||
            (patch.vendor && patch.vendor !== (c.vendor || ''));
          if (changedEndpoint) {
            const m = await postRefreshCredModels(c.id);
            toast(m.ok ? `已保存，发现 ${m.models.length} 个模型` : `已保存（模型列表获取失败：${m.error}，可稍后点刷新）`);
          }
          await loadCredentials();
        } catch {
          toast('网络错误');
        }
      }

      // —— 功能模型：任务 → 模型 下拉（数据由后端下发，见 GET /api/settings.modelTasks） ——

      function claudeModelLabel(id) {
        return CLAUDE_TASK_MODELS.find((m) => m.id === id)?.label || id || '';
      }

      function taskFallbackLabel(fb) {
        if (fb && fb.provider === 'claude-agent') {
          return fb.model ? claudeModelLabel(fb.model) : '跟随 Claude Code 当前模型';
        }
        return '默认';
      }

      function targetToValue(t) {
        return t ? JSON.stringify(t) : '';
      }

      function valueToTarget(v) {
        if (!v) return null;
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      }

      function renderModelTasks() {
        const box = $('#modelTaskGroups');
        if (!box || !Array.isArray(_modelTaskView)) return;
        box.innerHTML = '';
        const groups = new Map(); // 分组保持后端下发顺序
        for (const t of _modelTaskView) {
          if (!groups.has(t.group)) groups.set(t.group, []);
          groups.get(t.group).push(t);
        }
        for (const [group, items] of groups) {
          const sec = document.createElement('div');
          sec.className = 'model-task-group';
          const head = document.createElement('div');
          head.className = 'model-task-group-head';
          head.textContent = group;
          sec.appendChild(head);
          for (const t of items) {
            const row = document.createElement('div');
            row.className = 'model-task-row';
            const label = document.createElement('span');
            label.className = 'model-task-label';
            label.textContent = t.label;
            label.title = t.hint || '';
            const sel = document.createElement('select');
            sel.className = 'set-select model-task-select';
            sel.title = t.hint || '';

            const def = document.createElement('option');
            def.value = '';
            def.textContent = '默认（' + taskFallbackLabel(t.fallback) + '）';
            sel.appendChild(def);

            const cg = document.createElement('optgroup');
            cg.label = 'Claude 订阅';
            for (const m of CLAUDE_TASK_MODELS) {
              const o = document.createElement('option');
              o.value = targetToValue({ provider: 'claude-agent', model: m.id });
              o.textContent = m.label;
              cg.appendChild(o);
            }
            sel.appendChild(cg);

            for (const c of _credentialsCache) {
              const models = Array.isArray(c.models) ? c.models : [];
              if (!models.length) continue;
              const og = document.createElement('optgroup');
              og.label = c.label || c.baseURL || '自定义模型';
              for (const m of models) {
                const o = document.createElement('option');
                o.value = targetToValue({ provider: 'openai-compat', credId: c.id, model: m.id });
                o.textContent = m.name || m.id;
                og.appendChild(o);
              }
              sel.appendChild(og);
            }

            const cur = t.value;
            if (cur) {
              const want = targetToValue(cur);
              if ([...sel.options].some((o) => o.value === want)) {
                sel.value = want;
              } else {
                // 凭证被删除 / 模型列表变化 → 保留一个可读的失效项，避免静默改成别的模型
                const o = document.createElement('option');
                o.value = want;
                o.textContent =
                  cur.provider === 'openai-compat'
                    ? '已失效：' + cur.model + '（凭证已删除或模型已下架）'
                    : '已失效：' + claudeModelLabel(cur.model);
                sel.appendChild(o);
                sel.value = want;
              }
            }

            sel.onchange = async () => {
              const d = await postSettings({ section: 'model-tasks', id: t.id, value: valueToTarget(sel.value) });
              if (d && d.modelTasks) {
                _modelTaskView = d.modelTasks;
                renderModelTasks();
              } else {
                sel.value = targetToValue(t.value); // 保存失败 → 回滚显示
              }
            };

            row.appendChild(label);
            row.appendChild(sel);
            sec.appendChild(row);
          }
          box.appendChild(sec);
        }
      }

      // —— 插件启停（基础 tab）：/api/plugins，重启进程后生效 ——
      async function loadPlugins() {
        try {
          const r = await fetch('/api/plugins');
          const d = await r.json();
          renderPluginList(d.plugins || []);
        } catch {
          /* 设置未打开 / 网络问题：忽略 */
        }
      }

      function renderPluginList(plugins) {
        const box = $('#pluginList');
        if (!box) return;
        box.innerHTML = '';
        plugins.forEach((p) => {
          const row = document.createElement('div');
          row.className = 'token-row';
          row.innerHTML =
            '<input type="checkbox" class="pretty-check" title="启用 / 停用（重启生效）" />' +
            '<span class="t-label"></span>' +
            '<span class="t-base plugin-desc"></span>';
          row.querySelector('.t-label').textContent = p.id;
          row.querySelector('.plugin-desc').textContent = p.description || '';
          const chk = row.querySelector('.pretty-check');
          chk.checked = p.enabled;
          chk.onchange = async () => {
            try {
              const r = await fetch('/api/plugins/' + encodeURIComponent(p.id), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: chk.checked }),
              });
              const d = await r.json();
              if (!r.ok || d.error) return toast(d.error || '保存失败');
              toast('已保存，重启进程后生效');
            } catch {
              toast('网络错误');
            }
            await loadPlugins();
          };
          box.appendChild(row);
        });
      }

      // —— MCP 服务器（stdio）CRUD：走专用 /api/mcp-servers，供自定义模型的 agentic 工具 ——
      let mcpEditingId = null; // 非空 = 表单处于「编辑」模式（复用添加表单）

      async function loadMcpServers() {
        try {
          const r = await fetch('/api/mcp-servers');
          const d = await r.json();
          renderMcpList(d.servers || []);
        } catch {
          /* 设置未打开 / 网络问题：忽略 */
        }
      }

      function renderMcpList(servers) {
        const box = $('#mcpList');
        if (!box) return;
        box.innerHTML = '';
        if (!servers.length) {
          box.innerHTML = '<div class="cred-empty">暂无 MCP 服务器，填下方表单添加</div>';
          return;
        }
        servers.forEach((m) => {
          const row = document.createElement('div');
          row.className = 'token-row' + (m.enabled ? '' : ' mcp-off');
          row.dataset.id = m.id;
          row.innerHTML =
            '<input type="checkbox" class="pretty-check" title="启用 / 停用" />' +
            '<span class="t-label"></span>' +
            '<span class="t-base mcp-cmd"></span>' +
            (m.autoAllow && m.autoAllow.length
              ? '<span class="t-base" title="自动放行：' + m.autoAllow.join(', ').replace(/"/g, '&quot;') + '">放行' + m.autoAllow.length + '</span>'
              : '') +
            (m.hasEnv ? '<span class="t-base" title="含 env 配置（仅可手改 settings.json）">env</span>' : '') +
            '<span class="spacer"></span>' +
            '<button class="t-act edit" title="编辑">' + iconHtml(EDIT_ICON_SVG) + '</button>' +
            '<button class="t-act del" title="删除">' + iconHtml(DELETE_ICON_SVG) + '</button>';
          row.querySelector('.t-label').textContent = m.label || '(未命名)';
          row.querySelector('.mcp-cmd').textContent = [m.command, ...(m.args || [])].join(' ');
          const chk = row.querySelector('.pretty-check');
          chk.checked = m.enabled;
          chk.onchange = () => toggleMcpServer(m.id, chk.checked);
          row.querySelector('.edit').onclick = () => editMcpServer(m);
          row.querySelector('.del').onclick = () => deleteMcpServer(m.id, m.label || m.command);
          box.appendChild(row);
        });
      }

      function editMcpServer(m) {
        mcpEditingId = m.id;
        $('#mcpLabel').value = m.label || '';
        $('#mcpCommand').value = m.command || '';
        $('#mcpArgs').value = (m.args || []).join('\n');
        $('#mcpCwd').value = m.cwd || '';
        $('#mcpAutoAllow').value = (m.autoAllow || []).join('\n');
        $('#mcpFormTitle').textContent = '编辑「' + (m.label || m.command) + '」';
        $('#mcpAddBtn').textContent = '保存修改';
        $('#mcpCancelBtn').hidden = false;
      }

      function resetMcpForm() {
        mcpEditingId = null;
        ['mcpLabel', 'mcpCommand', 'mcpArgs', 'mcpCwd', 'mcpAutoAllow'].forEach((id) => ($('#' + id).value = ''));
        $('#mcpFormTitle').textContent = '添加服务器';
        $('#mcpAddBtn').textContent = '＋ 添加';
        $('#mcpCancelBtn').hidden = true;
      }

      async function submitMcpForm() {
        const command = $('#mcpCommand').value.trim();
        if (!command) return toast('命令必填');
        const payload = {
          label: $('#mcpLabel').value.trim(),
          command,
          args: $('#mcpArgs').value.split('\n').map((s) => s.trim()).filter(Boolean), // 每行一个参数：路径含空格不需要引号
          cwd: $('#mcpCwd').value.trim(),
          autoAllow: $('#mcpAutoAllow').value.split('\n').map((s) => s.trim()).filter(Boolean),
        };
        try {
          const url = mcpEditingId ? '/api/mcp-servers/' + encodeURIComponent(mcpEditingId) : '/api/mcp-servers';
          const r = await fetch(url, {
            method: mcpEditingId ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '保存失败');
          toast(mcpEditingId ? 'MCP 服务器已更新' : 'MCP 服务器已添加');
          resetMcpForm();
          await loadMcpServers();
        } catch {
          toast('网络错误');
        }
      }

      async function toggleMcpServer(id, enabled) {
        try {
          const r = await fetch('/api/mcp-servers/' + encodeURIComponent(id), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
          });
          const d = await r.json();
          if (!r.ok || d.error) toast(d.error || '切换失败');
        } catch {
          toast('网络错误');
        }
        await loadMcpServers();
      }

      async function deleteMcpServer(id, label) {
        if (!(await confirmDialog({ title: '删除 MCP 服务器', message: `确认删除「${label}」？`, danger: true }))) return;
        try {
          const r = await fetch('/api/mcp-servers/' + encodeURIComponent(id), { method: 'DELETE' });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '删除失败');
          if (mcpEditingId === id) resetMcpForm(); // 正在编辑被删条目 → 复位表单
          await loadMcpServers();
        } catch {
          toast('网络错误');
        }
      }

      // —— 内置能力（内置 MCP / Skills）：清单与默认值来自后端注册表，前端只渲染与切开关 ——
      const P_PATH = { claude: 'Claude', openai: '自定义模型' };

      async function loadBuiltins() {
        try {
          const r = await fetch('/api/builtins');
          const d = await r.json();
          renderBuiltinList(d.mcp || [], d.skills || []);
        } catch {
          /* 设置未打开 / 网络问题：忽略 */
        }
      }

      async function putBuiltin(payload, failMsg) {
        try {
          const r = await fetch('/api/builtins', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const d = await r.json();
          if (!r.ok || d.error) {
            toast(d.error || failMsg);
            return false;
          }
          return true;
        } catch {
          toast('网络错误');
          return false;
        }
      }

      /** 开关组件：复用模型弹层的 .tool-toggle 视觉语言（两处同一套滑块，不另起炉灶） */
      function makeSwitch(checked, onChange, { disabled = false, title = '启用 / 停用' } = {}) {
        const lbl = document.createElement('label');
        lbl.className = 'tool-toggle' + (disabled ? ' disabled' : '');
        lbl.title = title;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!checked;
        input.disabled = disabled;
        input.onchange = () => onChange(input);
        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        lbl.appendChild(input);
        lbl.appendChild(slider);
        return lbl;
      }

      function renderBuiltinList(mcp, skills) {
        const box = $('#builtinList');
        if (!box) return;
        box.innerHTML = '';
        if (!mcp.length && !skills.length) {
          box.innerHTML = '<div class="cred-empty">暂无内置能力</div>';
          return;
        }

        /**
         * 通用卡片：信息区（名称 + 徽标 + 描述）/ 右侧开关 / 可选底部扩展行（密钥）。
         * 两列 grid + 描述单行省略，保证长文案不撑行拖乱开关对位。
         */
        function makeRow({ name, desc, badges = [], enabled, disabled = false, installHint, onToggle, extra = null, sub = false }) {
          const row = document.createElement('div');
          row.className = 'builtin-row' + (enabled ? '' : ' off') + (sub ? ' sub' : '');

          const main = document.createElement('div');
          main.className = 'b-main';
          const title = document.createElement('div');
          title.className = 'b-title';
          const nameEl = document.createElement('span');
          nameEl.className = 'b-name';
          nameEl.textContent = name;
          title.appendChild(nameEl);
          for (const b of badges) {
            const badge = document.createElement('span');
            badge.className = 'b-badge' + (b.warn ? ' warn' : '');
            badge.textContent = b.text;
            if (b.title) badge.title = b.title;
            title.appendChild(badge);
          }
          const descEl = document.createElement('div');
          descEl.className = 'b-desc';
          descEl.textContent = desc || '';
          if (desc) descEl.title = desc; // 单行省略后，悬停可看全文
          main.appendChild(title);
          main.appendChild(descEl);
          row.appendChild(main);

          row.appendChild(
            makeSwitch(enabled, async (input) => {
              if (!(await onToggle(input.checked))) input.checked = !input.checked; // 失败回滚 UI
            }, {
              disabled,
              title: disabled
                ? `未安装（${installHint || 'npm run setup:superpowers'}）`
                : enabled
                  ? '点击停用'
                  : '点击启用',
            }),
          );

          if (extra) {
            const wrap = document.createElement('div');
            wrap.className = 'b-extra';
            wrap.appendChild(extra);
            row.appendChild(wrap);
          }
          return row;
        }

        mcp.forEach((m) => {
          const badges = [{ text: (m.paths || []).map((p) => P_PATH[p] || p).join(' / '), title: '可用路径' }];
          if (m.available === false) {
            badges.push({ text: '未连接', warn: true, title: '未检测到本地服务（如 Figma 桌面端未运行）' });
          }
          if (m.needsKey && m.needsKey.required && !m.hasKey) {
            badges.push({ text: '缺密钥', warn: true, title: `需要配置 ${m.needsKey.env}` });
          }

          let extra = null;
          if (m.needsKey) {
            const frag = document.createDocumentFragment();
            const input = document.createElement('input');
            input.type = 'password';
            input.className = 'b-key-input';
            input.placeholder = m.hasKey ? '已配置，输入新值可覆盖' : `粘贴 ${m.needsKey.env}`;
            input.title = '密钥只存本机 settings.json，读取接口不回显';
            const save = document.createElement('button');
            save.className = 'b-key-save';
            save.textContent = m.hasKey ? '更新' : '保存';
            save.onclick = async () => {
              if (!input.value.trim()) return toast('请输入密钥');
              if (await putBuiltin({ kind: 'mcp', id: m.id, apiKey: input.value }, '保存失败')) toast('密钥已保存');
              await loadBuiltins();
            };
            frag.appendChild(input);
            frag.appendChild(save);
            extra = frag;
          }

          box.appendChild(
            makeRow({
              name: m.label || m.id,
              desc: m.desc,
              badges,
              enabled: !!m.enabled,
              onToggle: (checked) => putBuiltin({ kind: 'mcp', id: m.id, enabled: checked }, '切换失败'),
              extra,
            }),
          );
        });

        skills.forEach((s) => {
          const items = Array.isArray(s.skills) ? s.skills : [];
          const offCount = items.filter((i) => !i.enabled).length;
          const badges = [];
          if (s.installed === false) {
            badges.push({ text: '未安装', warn: true, title: `运行 ${s.installHint || 'npm run setup:superpowers'} 后可用` });
          } else if (offCount) {
            badges.push({ text: `已停用 ${offCount} 项`, title: '展开技能明细可逐项恢复' });
          }
          box.appendChild(
            makeRow({
              name: s.label || s.id,
              desc: s.desc,
              badges,
              enabled: !!s.enabled,
              disabled: s.installed === false, // 未安装 → 开关禁用（fail-open 状态的 UI 表达）
              installHint: s.installHint,
              onToggle: (checked) => putBuiltin({ kind: 'skill', id: s.id, enabled: checked }, '切换失败'),
            }),
          );
          // per-skill 明细：默认折叠（12 行全展开会淹没其他内置项），包级开关开启时才值得逐个调
          if (s.installed && items.length) {
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'builtin-subtoggle';
            toggleBtn.textContent = `技能明细（${items.length} 项）`;
            const details = document.createElement('div');
            details.className = 'builtin-sublist';
            details.hidden = true;
            toggleBtn.onclick = () => {
              details.hidden = !details.hidden;
              toggleBtn.classList.toggle('open', !details.hidden);
            };
            for (const it of items) {
              details.appendChild(
                makeRow({
                  name: it.label || it.id,
                  desc: it.desc,
                  enabled: !!it.enabled,
                  sub: true,
                  onToggle: (checked) => putBuiltin({ kind: 'skill', id: s.id, skillId: it.id, enabled: checked }, '切换失败'),
                }),
              );
            }
            box.appendChild(toggleBtn);
            box.appendChild(details);
          }
        });
      }

      // ==== 会话清理 tab ====
      // 当前工作目录：与 chat.js 一致，优先 window.__PROJECT_CWD__（打包版），否则读 localStorage。
      function cleanupCwd() {
        const w = window.__PROJECT_CWD__;
        return typeof w === 'string' ? w : (localStorage.getItem('claude_cwd') || '');
      }

      // 读当前选中的时间窗：range 优先，其次自定义日期。无有效选择返回 null。
      function cleanupWindow() {
        const checked = document.querySelector('input[name="cleanupRange"]:checked');
        if (checked) return { range: checked.value };
        const from = $('#cleanupFrom')?.value || '';
        const to = $('#cleanupTo')?.value || '';
        if (from || to) return { fromDate: from, toDate: to };
        return null;
      }

      // 拉当前目录统计并刷新面板；重置选择与按钮态
      async function loadCleanupStats() {
        const cwd = cleanupCwd();
        $('#cleanupCwd').textContent = cwd || '（服务目录）';
        try {
          const r = await fetch('/api/cleanup/stats?cwd=' + encodeURIComponent(cwd));
          const d = await r.json();
          $('#cleanupTotal').textContent = d.error ? '不可用' : d.totalCount;
        } catch {
          $('#cleanupTotal').textContent = '读取失败';
        }
        // 复位选择：换目录后沿用上个目录的时间窗，算出的「将删除 N 个」是对不上的
        // （注释原本就写着「重置选择」，但只重置了按钮态——这里补齐）
        const checked = document.querySelector('input[name="cleanupRange"]:checked');
        if (checked) checked.checked = false;
        setCleanupCustom(false);
        $('#cleanupWillDelete').textContent = '0';
        $('#cleanupExecBtn').disabled = true;
      }

      // 预计算待删数（选择变化时触发），并据此启用/禁用清理按钮
      async function previewCleanup() {
        const win = cleanupWindow();
        const willDelete = $('#cleanupWillDelete');
        const btn = $('#cleanupExecBtn');
        if (!win) { willDelete.textContent = '0'; btn.disabled = true; return; }
        const params = new URLSearchParams({ cwd: cleanupCwd() });
        if (win.range) params.set('range', win.range);
        if (win.fromDate) params.set('fromDate', win.fromDate);
        if (win.toDate) params.set('toDate', win.toDate);
        try {
          const r = await fetch('/api/cleanup/preview?' + params.toString());
          const d = await r.json();
          const n = d.willDeleteCount || 0;
          willDelete.textContent = n;
          btn.disabled = n === 0; // 无命中不允许执行
        } catch {
          willDelete.textContent = '?';
          btn.disabled = true;
        }
      }

      // 执行清理：危险操作，先确认再 POST
      async function executeCleanup() {
        const win = cleanupWindow();
        if (!win) return;
        const count = $('#cleanupWillDelete').textContent;
        const ok = await confirmDialog({
          title: '⚠️ 危险操作',
          message: `确定删除 ${count} 个会话？此操作不可恢复。`,
          danger: true,
          confirmText: '确认删除',
        });
        if (!ok) return;
        try {
          const r = await fetch('/api/cleanup/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cwd: cleanupCwd(), ...win, confirmed: true }),
          });
          const d = await r.json();
          if (!r.ok || d.error) return toast(d.error || '清理失败');
          const skipped = d.skippedCount ? `，跳过 ${d.skippedCount} 个占用文件` : '';
          toast(`✓ 已删除 ${d.deletedCount} 个会话${skipped}`);
          await loadCleanupStats(); // 刷新总数并复位选择
        } catch {
          toast('网络错误，请重试');
        }
      }

      /**
       * 快捷档与自定义日期二选一，切换时**清掉另一侧的值**。
       *
       * 不是洁癖：cleanupWindow() 是快捷档优先（`if (checked) return {range}`），而 radio
       * 点过就无法取消。原先用户先点「一周前」再填自定义日期，日期会被静默忽略——预览数和
       * 真正删除的都按 range 走，界面上没有任何提示。删除不可恢复，这种静默走错分支代价太大。
       * 自定义面板能正常收起之后，残留值还会被藏起来，比一直展开时更隐蔽，所以必须成对修。
       */
      function setCleanupCustom(open) {
        const box = $('#cleanupCustom');
        const toggle = $('#cleanupCustomToggle');
        if (!box) return;
        box.hidden = !open;
        if (toggle) toggle.textContent = (open ? '⌃' : '⌄') + ' 自定义日期范围';
        if (open) {
          const checked = document.querySelector('input[name="cleanupRange"]:checked');
          if (checked) checked.checked = false;
        } else {
          $('#cleanupFrom').value = '';
          $('#cleanupTo').value = '';
        }
        previewCleanup();
      }

      // 绑定清理页交互（只绑一次，随 bindConfigTransfer 初始化）
      function bindCleanup() {
        $('#cleanupRanges')?.addEventListener('change', () => {
          setCleanupCustom(false); // 选了快捷档 → 收起并清空自定义，避免两套输入并存
        });
        $('#cleanupFrom')?.addEventListener('change', previewCleanup);
        $('#cleanupTo')?.addEventListener('change', previewCleanup);
        $('#cleanupCustomToggle')?.addEventListener('click', () => {
          setCleanupCustom($('#cleanupCustom')?.hidden);
        });
        $('#cleanupExecBtn')?.addEventListener('click', executeCleanup);
      }

      // 设置页内部 tab（纯显隐，不重复拉数据）
      const settingsTabs = $('#settingsTabs');
      [...settingsTabs.querySelectorAll('button')].forEach((b) => {
        b.addEventListener('click', () => {
          [...settingsTabs.querySelectorAll('button')].forEach((x) =>
            x.classList.toggle('active', x === b),
          );
          // 显式取元素：panelView 常量在 app.js，勿依赖浏览器 id 隐式全局
          $('#panelView')
            .querySelectorAll('.set-tab')
            .forEach((p) => (p.hidden = p.dataset.tab !== b.dataset.tab));
          // 清理页首次/每次打开时拉当前目录统计（数据依赖工作目录，不能只在 loadSettings 拉一次）
          if (b.dataset.tab === 'cleanup') loadCleanupStats();
        });
      });
      bindCleanup();
      $('#tokenAddBtn').addEventListener('click', addTokenUI);
      $('#setupTokenCopyBtn')?.addEventListener('click', copySetupTokenCmd);
      $('#credAddBtn')?.addEventListener('click', addCredentialUI);
      $('#mcpAddBtn')?.addEventListener('click', submitMcpForm);
      $('#mcpCancelBtn')?.addEventListener('click', resetMcpForm);
      // 基础 tab - 新会话默认值
      document.getElementById('basicDefaultsSaveBtn')?.addEventListener('click', async () => {
        const model = document.getElementById('basicDefaultModel').value;
        const effort = document.getElementById('basicDefaultEffort').value;
        const mode = document.getElementById('basicDefaultMode').value;
        const maxStepsRaw = document.getElementById('basicOpenaiMaxSteps')?.value ?? '';
        const maxSteps = Math.max(0, Math.floor(Number(maxStepsRaw) || 0)); // 空/非法/负数一律归 0=无上限
        if (await postSettings({ section: 'ui-prefs', defaultModel: model, defaultEffort: effort, defaultMode: mode, openaiMaxSteps: maxSteps })) {
          toast('新会话默认值已保存');
        }
      });
      document.getElementById('basicSearchSaveBtn')?.addEventListener('click', async () => {
        const provider = document.getElementById('basicSearchProvider').value;
        const apiKey = document.getElementById('basicSearchKey').value.trim();
        if (await postSettings({ section: 'search', provider, apiKey })) toast('搜索配置已保存');
      });
      document.getElementById('basicMyFeishuOpenIdSaveBtn')?.addEventListener('click', async () => {
        const myFeishuOpenId = document.getElementById('basicMyFeishuOpenId').value;
        if (await postSettings({ section: 'profile', myFeishuOpenId })) {
          toast('我的飞书 open_id 已保存');
        }
      });
      // 仓库地图开关：即时保存（与面板其它 switch 同交互），失败回滚
      document.getElementById('repoMapToggleInput')?.addEventListener('change', async (e) => {
        const input = e.target;
        if (await postSettings({ section: 'repo-map', enabled: input.checked })) {
          toast(input.checked ? '仓库地图已开启' : '仓库地图已关闭');
        } else {
          input.checked = !input.checked;
        }
      });
      // Bash 执行后端（T6）：下拉联动灰置；保存后对新起的运行生效
      document.getElementById('basicExecBackend')?.addEventListener('change', syncExecBackendFields);
      document.getElementById('basicExecSaveBtn')?.addEventListener('click', async () => {
        const backend = document.getElementById('basicExecBackend').value;
        const image = document.getElementById('basicExecImage').value.trim();
        const network = document.getElementById('basicExecNetwork').checked;
        // 镜像留空 = 不发该字段（服务端保留原值；从未配置时用默认 node:22-bookworm）
        const payload = { section: 'exec', backend, network, ...(image ? { image } : {}) };
        if (await postSettings(payload)) toast('执行后端已保存');
      });
