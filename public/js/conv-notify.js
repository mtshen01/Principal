/**
 * 会话级飞书通知开关（输入框底栏的 🔔 按钮）+ 补充内容收件箱轮询。
 *
 * 链路全貌：run 终结 → 服务端推飞书卡片 → 用户点[补充内容]回一句 → 飞书进程 HTTP 打
 * /api/conv-notify/inject → 服务端起 run（或插话）并把这条消息写进该会话的收件箱 →
 * **本模块轮询**把它取回来上屏、接管该 run 的流，最后 /claim 认领（认领后服务端不再下发）。
 *
 * 状态归属：开关是会话级偏好，真值存在 conv.meta.notifyFeishu（localStorage），
 * 服务端登记表只是它的镜像；两边不一致时以 /inbox 的 active 为准往本地对齐（见 pollInbox）。
 *
 * 新会话（还没有 conv 记录）也能点开关：先记为「待生效」（pendingNewConv，只亮按钮、
 * 不调服务端——快照缺 cwd/session，登记了也白登记）。首条消息落库后 chat.js 调
 * onConvCreated() 补写 meta 并调 /on；配置缺失/网络失败在那时才报错并灭灯——与在已建会话里
 * 点的失败语义完全一致。
 *
 * 关键约束：模块内**不缓存 convId**，一律经 deps.getCurrentConvId() 实时取，
 * 避免切会话时缓存值滞后 —— 轮询会继续盯着上一个会话，把补充内容画进错误的会话里。
 */
import { toast } from './ui.js';
import { loadConvs, convSetMeta } from './conv-store.js';

const POLL_MS = 5000;

/**
 * @param {{ applyInjected: (convId:string, items:any[]) => Promise<string[]>,
 *           getCurrentConvId: () => (string|null) }} deps
 */
export function bindConvNotify(deps) {
  const btn = document.getElementById('notifyBtn');
  const applyInjected = deps?.applyInjected;
  const getConvId = deps?.getCurrentConvId || (() => null);
  let timer = null; // 单一轮询定时器：全局只应存在一个，切会话时换目标而不是叠加
  // 新会话（尚无 conv 记录）里点亮的「待生效」开关：首条消息落库后由 onConvCreated 补登记。
  // 不落 localStorage 是有意的（同 ultracode/figmaRestore）：新会话开场即开、刷新即灭。
  let pendingNewConv = false;

  const findConv = (convId) => (convId ? loadConvs().find((c) => c.id === convId) || null : null);

  /** 所有 fetch 的统一兜底：网络抖动/非 JSON 响应都收敛成 null，
   *  调用方据此跳过本轮即可 —— 绝不能让一次失败把轮询链打断或抛红。 */
  function postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .catch(() => null);
  }

  /**
   * 按会话偏好刷新开关按钮外观（亮/灭 + aria-pressed，键盘与读屏可感知）。
   * 形参未必是 conv：无记录的会话传（或传不到）时，可选链天然落到「未激活」，正合语义。
   *
   * 待生效态（pendingNewConv）只在「当前会话没有记录」时点亮：用 findConv(getConvId())
   * 而非 !getConvId() 判断，可同时兜住 currentConvId 指向已删记录的老会话。
   */
  function refreshBtn(conv) {
    if (!btn) return;
    const on = !!conv?.meta?.notifyFeishu || (pendingNewConv && !findConv(getConvId()));
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  /** 服务端登记表存的是会话快照（飞书侧靠它 resume 回原会话），缺字段一律给可用默认值。 */
  function snapshot(convId) {
    const c = findConv(convId);
    return {
      convId,
      title: c?.title || '',
      session: c?.session || '',
      cwd: c?.cwd || '',
      model: c?.model || 'auto',
      effort: c?.effort || 'medium',
      mode: c?.mode || 'default',
    };
  }

  /**
   * 快照心跳：session id 要到首个 SSE 事件才拿得到，chat.js 在那一刻回调本函数补齐。
   * 参数是**该 run 的 convId**（可能是后台会话），故不能改用 getCurrentConvId。
   * 没开通知的会话直接返回，省掉一次注定 no-op 的往返。
   */
  function sync(convId) {
    if (!findConv(convId)?.meta?.notifyFeishu) return;
    postJson('/api/conv-notify/sync', snapshot(convId));
  }

  async function toggle() {
    const convId = getConvId();
    const conv = findConv(convId);
    // 新开的会话要等第一条消息落库才有 conv 记录（快照取不到 cwd/session，登记了也白登记）。
    // 不能就此拒绝：先记「待生效」只亮按钮，chat.js 在首条消息落库后调 onConvCreated 补登记。
    if (!convId || !conv) {
      pendingNewConv = !pendingNewConv;
      toast(
        pendingNewConv
          ? '已开启：发送首条消息后，任务结束/失败会发飞书通知'
          : '已取消新会话的飞书通知',
      );
      return;
    }

    // 已建会话里再点：待生效态已无意义（用户明确选择了这个会话的当前值），清掉防串味
    pendingNewConv = false;

    if (conv.meta?.notifyFeishu) {
      // 关闭是用户的明确意图，先本地灭灯再打服务端：不让网络往返把按钮卡在「已开」的假象上。
      // 万一 /off 丢包，服务端留一条孤儿登记也不会让按钮误亮 —— pollInbox 只在本地 meta 为真时才跑。
      convSetMeta(convId, { notifyFeishu: false });
      refreshBtn(findConv(convId));
      stopPolling();
      await postJson('/api/conv-notify/off', { convId });
      toast('已关闭该会话的飞书通知');
      return;
    }

    const d = await postJson('/api/conv-notify/on', snapshot(convId));
    if (!d) {
      toast('开启失败：网络异常，请稍后重试');
      return;
    }
    // 服务端在「缺 myFeishuOpenId」「没有启用中的机器人」时回 200 + {ok:false, error}：
    // 这是配置缺失而非请求失败，必须只弹提示指路、**不写 meta 也不点亮按钮** ——
    // 亮了会让用户以为通知已生效，实际一条也发不出去，任务跑完只剩沉默。
    if (!d.ok) {
      toast(d.error || '开启失败');
      return;
    }
    convSetMeta(convId, { notifyFeishu: true });
    toast('已开启：任务结束/失败会发飞书通知');
    // 等待往返期间用户可能已切走：按钮与轮询都只服务「当前会话」，切走了就交给 onConvOpened
    // （refreshBtn 不必在此重复调用：change 监听的 finally 收尾已按 conv.meta 真值回写过一次）
    if (getConvId() === convId) {
      startPolling();
    }
  }

  /**
   * 首条消息落库后补登记（chat.js 的 sendInner 在 recordMessage 之后调用；无待生效态时 no-op）。
   *
   * 与在已建会话里点开关的路径刻意保持同一套失败语义：/on 网络失败或服务端回 ok:false
   * （缺 open_id / 无启用机器人）都只弹提示并保持灭灯，**绝不写 meta.notifyFeishu** ——
   * 写错了会让用户以为通知已生效，实际一条也发不出去。
   */
  async function onConvCreated(convId) {
    if (!pendingNewConv) return;
    pendingNewConv = false;
    try {
      const d = await postJson('/api/conv-notify/on', snapshot(convId));
      if (!d) {
        toast('开启失败：网络异常，请稍后重试');
        return;
      }
      if (!d.ok) {
        toast(d.error || '开启失败');
        return;
      }
      convSetMeta(convId, { notifyFeishu: true });
      toast('已开启：任务结束/失败会发飞书通知');
      if (getConvId() === convId) startPolling();
    } finally {
      // 无论成败都按**当前**会话的记录回写一次按钮：成功时点亮本会话；失败时把待生效的亮灯
      // 收干净（避免「亮着但没登记」）；往返期间切走了则刷新的自然是新会话的真实值。
      refreshBtn(findConv(getConvId()));
    }
  }

  async function pollInbox() {
    const convId = getConvId();
    if (!convId) return;
    const d = await fetch('/api/conv-notify/inbox?convId=' + encodeURIComponent(convId))
      .then((r) => r.json())
      .catch(() => null);
    if (!d) return; // 抖一下而已，定时器还在，下轮再试
    if (getConvId() !== convId) return; // 往返期间已切会话：这批 items 不属于当前视图

    if (!d.active) {
      // 服务端已无登记（在别处取消了 / 数据被清）→ 本地对齐，别让按钮亮着空转
      if (findConv(convId)?.meta?.notifyFeishu) {
        convSetMeta(convId, { notifyFeishu: false });
        refreshBtn(findConv(convId));
      }
      stopPolling();
      return;
    }

    const items = Array.isArray(d.items) ? d.items : [];
    if (!items.length) return;
    // applyInjected 自带「非当前会话不上屏」守卫，只返回真正上了屏的 id。
    // 必须 await：真身（chat.js 的 applyInjectedItems）是 async，漏掉 await 拿到的是 Promise，
    // 它没有 .length → 下面的空判永远成立 → /claim 一次都不发 → 条目烂在服务端收件箱里，
    // 5s 一轮的轮询把同一条补充内容反复上屏（表现为「最后那句话被无限自动重发」）。
    const applied = (await applyInjected?.(convId, items)) || [];
    // 空数组绝不能调 /claim：认领即从服务端收件箱删除，没上屏就认领 = 这条补充内容永久蒸发
    if (!applied.length) return;
    postJson('/api/conv-notify/claim', { convId, ids: applied });
  }

  function startPolling() {
    stopPolling(); // 先停再起：切会话时换的是轮询目标，不是再加一个定时器
    timer = setInterval(pollInbox, POLL_MS);
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** 切会话钩子（chat.js 的 openConv 末尾调用）：换按钮态 + 换轮询目标。 */
  function onConvOpened(convId) {
    // 进新对话（newConversation 传 null）：待生效态复位 —— 与 ultracode/figmaRestore 的
    // 「新会话从关开始」同款取舍，否则「上次点过」会静默漂到下一次新会话上
    if (!convId) pendingNewConv = false;
    const c = findConv(convId);
    refreshBtn(c);
    if (c?.meta?.notifyFeishu) {
      pollInbox(); // 后台期间攒下的补充内容立刻补拉一次，不干等首个 5s 周期
      startPolling();
    } else {
      stopPolling();
    }
  }

  // 点击而非 change：本轮实现是按钮，toggle() 有多条拒绝路径
  //（无会话 / 网络失败 / 服务端配置缺失），所以无论成败收尾都按 conv.meta 真值回写一次，
  // 否则拒绝路径会留下「亮着但没登记」的假象。
  // busy：/on 往返期间再点一次会让第二个 toggle() 读到未写入的 meta、重复登记，且在途窗口里视觉是「已开」而服务端未登记；
  // 在途期间禁用按钮、点击直接忽略。
  let busy = false;
  btn?.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    toggle().finally(() => {
      busy = false;
      btn.disabled = false;
      refreshBtn(findConv(getConvId()));
    });
  });

  // 全局桥：chat.js 里四处调用点（openConv / newConversation / SSE 拿到 session /
  // applySessionPrefs）都以 `if (window.__convNotify)` 守卫，本模块未加载时静默跳过，故不需要反向依赖。
  window.__convNotify = { refreshBtn, sync, onConvOpened, onConvCreated };
}
