// 自动清晰度：焦点 / 独听等主窗口优先最高档，其余窗口按显示尺寸取较低档；
// 播放吃力（近期丢帧、持续缓冲）时逐级降档，全局稳定一段时间后再逐级回升。
// AutoQualityPolicy 只做决策、不碰 DOM；createAutoQualityController 负责采样窗口并切流。
//
// 录制中的窗口与用户手动锁定清晰度的窗口不会被自动切换（held）。它们仍参与压力判断：
// 例如录制中的焦点窗口丢帧时，会改为降低其他非主窗口。

export const AUTO_QUALITY = {
  tickMs: 3_000,
  // 压力窗口：近 20 秒内丢帧比例或累计缓冲时长
  windowMs: 20_000,
  dropRatio: 0.1,
  minFrames: 60,
  stallMs: 4_000,
  // 新连接（切档、重连）起步缓冲属正常现象，不计入
  warmupMs: 12_000,
  // 两次因吃力降档之间至少间隔一个压力窗口，先观察上一次降档的效果
  downCooldownMs: 20_000,
  // 单个窗口两次切换的最小间隔
  minSwitchMs: 10_000,
  // 角色或尺寸变化后，目标档位要保持这么久才切：升档快（用户刚设了焦点），降档慢（防止来回切焦点时反复重连）
  roleUpDelayMs: 1_500,
  roleDownDelayMs: 10_000,
  // 全局无压力这么久才尝试回升一档；两次回升至少间隔 upgradeGapMs，每次只升一个窗口
  stableMs: 120_000,
  upgradeGapMs: 30_000,
  // 回升后这么短时间内又吃力，视为回升失败：撤回该次回升，并把稳定期翻倍（最多 maxBackoff 倍）
  probeMs: 60_000,
  maxBackoff: 8,
  backoffResetMs: 600_000,
  // 非主窗口的物理像素高度阈值：≥720 比最高档低 1 档，≥400 低 2 档，更小低 3 档
  sizeTiers: [720, 400],
};

const CAUSE_LABELS = { drop: '丢帧', stall: '持续缓冲', load: '整体负载' };

// 斗鱼档位号：0 是原画（最高），其余数字越大越清晰。
function rateOrder(rate) {
  const n = Number(rate.rate);
  return n === 0 ? Infinity : n;
}

// 从最清晰到最低排序。码率齐全且互不相同时按码率，否则按斗鱼档位号。
export function rankRates(rates) {
  const list = (rates || []).filter((rate) => rate && Number.isFinite(Number(rate.rate)));
  const bits = list.map((rate) => Number(rate.bit));
  const byBit = list.length > 1 && bits.every((bit) => Number.isFinite(bit) && bit > 0) && new Set(bits).size === bits.length;
  return [...list].sort((a, b) => (byBit ? Number(b.bit) - Number(a.bit) : rateOrder(b) - rateOrder(a)));
}

// 由窗口角色和尺寸决定的最高档位（0 = 最清晰）。
export function ceilingLevel({ priority, pixelHeight = 0 }, count, tiers = AUTO_QUALITY.sizeTiers) {
  if (count <= 1 || priority) return 0;
  let level = 1;
  for (const min of tiers) {
    if (pixelHeight >= min) break;
    level++;
  }
  return Math.min(level, count - 1);
}

export class AutoQualityPolicy {
  constructor(config = {}) {
    this.config = { ...AUTO_QUALITY, ...config };
    this.reset();
  }

  reset() {
    this.tiles = new Map();
    this.lastPressureAt = -Infinity;
    this.lastDowngradeAt = -Infinity;
    this.lastUpgradeAt = -Infinity;
    this.backoff = 1;
    this.probe = null;
    this.quietUntil = -Infinity;
  }

  // 页面切到后台等无法观察的阶段之后，旧样本不再可比；quietUntil 之前只取基线不记样本。
  resetSamples(quietUntil = -Infinity) {
    this.quietUntil = quietUntil;
    for (const st of this.tiles.values()) {
      st.samples = [];
      st.counters = null;
    }
  }

  stateFor(id) {
    let st = this.tiles.get(id);
    if (!st) {
      st = {
        penalty: 0, cause: '', samples: [], counters: null, lastSwitchAt: -Infinity,
        pending: null, urgent: false, wasPriority: false, info: null,
      };
      this.tiles.set(id, st);
    }
    return st;
  }

  // 新窗口首次起播时直接取目标档位，省掉一次「先播旧档、再切」的重连。
  initialRate(snapshot) {
    if (snapshot.held) return null;
    const ladder = rankRates(snapshot.rates);
    if (ladder.length < 2) return null;
    const st = this.tiles.get(snapshot.id);
    const ceiling = ceilingLevel(snapshot, ladder.length, this.config.sizeTiers);
    const penalty = snapshot.priority ? 0 : st?.penalty || 0;
    const level = Math.min(ceiling + penalty, ladder.length - 1);
    return Number(ladder[level].rate);
  }

  // snapshots: [{ id, rates, rate, priority, pixelHeight, area, held, active, switchable,
  //   counters: { connectedAt, totalFrames, droppedFrames, stallMs } }]
  // 返回需要切换的窗口：[{ id, rate, name, reason }]
  evaluate(snapshots, now = Date.now()) {
    const ids = new Set(snapshots.map((snap) => snap.id));
    for (const id of this.tiles.keys()) if (!ids.has(id)) this.tiles.delete(id);
    const views = snapshots.map((snap) => this.view(snap, now));
    const pressured = views.filter((view) => view.pressure);
    if (pressured.length) this.relieve(views, pressured, now);
    else this.recover(views, now);
    return views.flatMap((view) => this.decide(view, now));
  }

  describe(id) {
    return this.tiles.get(id)?.info || null;
  }

  view(snap, now) {
    const st = this.stateFor(snap.id);
    const ladder = rankRates(snap.rates);
    const floor = Math.max(0, ladder.length - 1);
    const ceiling = ceilingLevel(snap, ladder.length, this.config.sizeTiers);
    // 用户刚把它设为主窗口：先给最高档，吃力时再按正常流程降下来。
    if (snap.priority && !st.wasPriority) {
      st.penalty = 0;
      st.cause = '';
    }
    st.wasPriority = !!snap.priority;
    st.penalty = Math.max(0, Math.min(st.penalty, floor - ceiling));
    if (!st.penalty) st.cause = '';
    const current = ladder.findIndex((rate) => Number(rate.rate) === Number(snap.rate));
    const adjustable = !snap.held && ladder.length > 1;
    const pressure = this.sample(snap, st, now);
    return { snap, st, ladder, floor, ceiling, current, adjustable, pressure };
  }

  // 把累计计数换成本次增量，判断近一个窗口内是否吃力：'drop' | 'stall' | null。
  sample(snap, st, now) {
    const c = this.config;
    const counters = snap.counters;
    if (!snap.active || !counters) {
      st.samples = [];
      st.counters = null;
      return null;
    }
    const prev = st.counters;
    st.counters = counters;
    // 新连接会重置媒体元素的帧计数，重新取基线。
    const fresh = !prev || prev.connectedAt !== counters.connectedAt ||
      counters.totalFrames < prev.totalFrames || counters.droppedFrames < prev.droppedFrames || counters.stallMs < prev.stallMs;
    if (fresh) {
      st.samples = [];
      return null;
    }
    // 起步阶段（以及刚从后台回来）只推进基线，不记样本。
    if (now - counters.connectedAt < c.warmupMs || now < this.quietUntil) return null;
    st.samples.push({
      at: now,
      frames: counters.totalFrames - prev.totalFrames,
      dropped: counters.droppedFrames - prev.droppedFrames,
      stall: counters.stallMs - prev.stallMs,
    });
    st.samples = st.samples.filter((item) => now - item.at <= c.windowMs);
    let frames = 0;
    let dropped = 0;
    let stall = 0;
    for (const item of st.samples) {
      frames += item.frames;
      dropped += item.dropped;
      stall += item.stall;
    }
    if (stall >= c.stallMs) return 'stall';
    if (frames >= c.minFrames && dropped / frames >= c.dropRatio) return 'drop';
    return null;
  }

  level(view) {
    return Math.min(view.ceiling + view.st.penalty, view.floor);
  }

  canLower(view, now) {
    return view.adjustable && this.level(view) < view.floor && now - view.st.lastSwitchAt >= this.config.minSwitchMs;
  }

  // 有窗口吃力：每个冷却期最多降一档。
  relieve(views, pressured, now) {
    const c = this.config;
    let reverted = null;
    if (this.probe && now <= this.probe.until) {
      this.backoff = Math.min(this.backoff * 2, c.maxBackoff);
      reverted = this.probe.id;
    }
    this.probe = null;
    this.lastPressureAt = now;
    if (now - this.lastDowngradeAt < c.downCooldownMs) return;
    const stallCount = pressured.filter((view) => view.pressure === 'stall').length;
    for (const source of pressured) {
      const victim = this.pickVictim(views, source, stallCount, reverted, now);
      if (!victim) continue;
      victim.st.penalty++;
      victim.st.cause = victim === source ? source.pressure : 'load';
      victim.st.urgent = true;
      this.lastDowngradeAt = now;
      return;
    }
  }

  // 丢帧多为整机解码负载，可以靠降低其他窗口缓解；缓冲多是单路网络问题，
  // 只有多路同时缓冲（带宽不够）时才牵连其他窗口。主窗口尽量最后降。
  pickVictim(views, source, stallCount, revertedId, now) {
    const shared = source.pressure === 'drop' || stallCount >= 2;
    const reverted = revertedId && views.find((view) => view.snap.id === revertedId);
    if (reverted && this.canLower(reverted, now) && (shared || reverted === source)) return reverted;
    if (!source.snap.priority && this.canLower(source, now)) return source;
    if (shared) {
      const others = views
        .filter((view) => view !== source && !view.snap.priority && this.canLower(view, now))
        .sort((a, b) => this.level(a) - this.level(b) || (b.snap.area || 0) - (a.snap.area || 0));
      if (others.length) return others[0];
    }
    if (source.snap.priority && this.canLower(source, now)) return source;
    return null;
  }

  // 全局稳定足够久：回升一个窗口一档，主窗口和大窗口优先。
  recover(views, now) {
    const c = this.config;
    if (this.probe && now > this.probe.until) this.probe = null;
    if (now - this.lastPressureAt >= c.backoffResetMs) this.backoff = 1;
    if (now - this.lastPressureAt < c.stableMs * this.backoff) return;
    if (now - this.lastUpgradeAt < c.upgradeGapMs) return;
    const candidate = views
      .filter((view) => view.adjustable && view.st.penalty > 0 && now - view.st.lastSwitchAt >= c.minSwitchMs)
      .sort((a, b) => Number(!!b.snap.priority) - Number(!!a.snap.priority) || (b.snap.area || 0) - (a.snap.area || 0))[0];
    if (!candidate) return;
    candidate.st.penalty--;
    if (!candidate.st.penalty) candidate.st.cause = '';
    this.lastUpgradeAt = now;
    this.probe = { id: candidate.snap.id, until: now + c.probeMs };
  }

  decide(view, now) {
    const c = this.config;
    const { snap, st, ladder } = view;
    const level = this.level(view);
    st.info = ladder.length ? {
      rate: Number(ladder[level].rate),
      name: ladder[level].name,
      priority: !!snap.priority,
      held: snap.held || '',
      penalty: st.penalty,
      cause: st.penalty ? CAUSE_LABELS[st.cause] || '' : '',
    } : null;
    if (!view.adjustable || view.current === level) {
      st.pending = null;
      st.urgent = false;
      return [];
    }
    // 暂时不能切（加载中、重连中）时也记下目标从何时开始稳定，恢复后不必重新计时。
    if (!st.urgent && st.pending?.level !== level) st.pending = { level, since: now };
    // 用户刚把它设为主窗口：升档只等短暂确认，不受最小切换间隔限制。
    const roleUpgrade = snap.priority && view.current >= 0 && level < view.current;
    if (!snap.switchable || (!roleUpgrade && now - st.lastSwitchAt < c.minSwitchMs)) return [];
    if (!st.urgent) {
      const delay = view.current < 0 ? 0 : level < view.current ? c.roleUpDelayMs : c.roleDownDelayMs;
      if (now - st.pending.since < delay) return [];
    }
    st.pending = null;
    st.urgent = false;
    st.lastSwitchAt = now;
    const reason = st.info.cause ? `因${st.info.cause}降档` : snap.priority ? '主窗口' : '按窗口大小';
    return [{ id: snap.id, rate: Number(ladder[level].rate), name: ladder[level].name, reason }];
  }
}

// 给窗口看的一句话说明，用于清晰度下拉框提示和诊断面板。
export function describeAutoQuality(info) {
  if (!info) return '';
  if (info.held === 'locked') return '已锁定';
  if (info.held === 'recording') return '录制中保持当前清晰度';
  if (info.cause) return `因${info.cause}降 ${info.penalty} 档`;
  return info.priority ? '主窗口优先高清' : '按窗口大小';
}

// 接到页面上：getTiles() 返回当前窗口，isPriority(tile) 判断焦点 / 独听等主窗口。
export function createAutoQualityController({ getTiles, isPriority, config } = {}) {
  const policy = new AutoQualityPolicy(config);
  let enabled = false;
  let timer = 0;
  let refreshTimer = 0;
  let followUpTimer = 0;

  const tileId = (tile) => String(tile.s.rid);

  function snapshot(tile, visibleCount) {
    const shown = !tile.el.hidden;
    const onScreen = shown && tile.visible !== false;
    // 尺寸按窗口实际大小算，滚出视口不算变小，免得滚动页面时反复切档。
    const rect = shown ? tile.$.video.getBoundingClientRect() : null;
    const dpr = globalThis.devicePixelRatio || 1;
    const player = tile.player;
    const live = tile.live === true && !tile.ecoSuspended;
    return {
      id: tileId(tile),
      rates: tile.availableRates,
      rate: tile.s.rate,
      priority: shown && (isPriority(tile) || visibleCount === 1),
      pixelHeight: rect ? rect.height * dpr : 0,
      area: rect ? rect.width * rect.height : 0,
      held: tile.autoQualityHold(),
      switchable: live && (player.state === 'playing' || player.state === 'retrying'),
      active: onScreen && live && !document.hidden && player.state === 'playing' && !tile.$.video.paused,
      counters: player.playbackCounters(),
    };
  }

  function snapshots() {
    const tiles = getTiles();
    const visibleCount = tiles.filter((tile) => !tile.el.hidden).length;
    return { tiles, snaps: tiles.map((tile) => snapshot(tile, visibleCount)) };
  }

  function evaluate() {
    if (!enabled || document.hidden) return;
    const { tiles, snaps } = snapshots();
    const actions = policy.evaluate(snaps, Date.now());
    for (const action of actions) {
      tiles.find((tile) => tileId(tile) === action.id)?.applyAutoRate(action.rate, `${action.name}（${action.reason}）`);
    }
    for (const tile of tiles) tile.setAutoQualityInfo(policy.describe(tileId(tile)));
  }

  return {
    get enabled() { return enabled; },
    setEnabled(next) {
      next = !!next;
      if (next === enabled) return;
      enabled = next;
      clearInterval(timer);
      clearTimeout(refreshTimer);
      clearTimeout(followUpTimer);
      timer = refreshTimer = followUpTimer = 0;
      policy.reset();
      if (enabled) {
        timer = setInterval(evaluate, policy.config.tickMs);
        this.refresh();
      }
    },
    // 焦点、独听、尺寸、录制或锁定状态变化后尽快重新评估；升档需要短暂确认，稍后再看一次。
    refresh() {
      if (!enabled || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = 0;
        evaluate();
        clearTimeout(followUpTimer);
        followUpTimer = setTimeout(evaluate, policy.config.roleUpDelayMs + 100);
      }, 50);
    },
    // 页面在后台时浏览器会节流甚至暂停视频，回来后旧样本不可比，并观察一个起步期再判断。
    setPageVisible(visible) {
      policy.resetSamples(visible ? Date.now() + policy.config.warmupMs : Infinity);
      if (visible) this.refresh();
    },
    initialRate(tile) {
      if (!enabled) return null;
      const tiles = getTiles();
      const visibleCount = tiles.filter((item) => !item.el.hidden).length;
      const snap = snapshot(tile, visibleCount);
      // 还没排版出尺寸（例如窗口暂时隐藏）就先按原档位播，之后再按正常流程调整。
      if (!snap.priority && !snap.pixelHeight) return null;
      return policy.initialRate(snap);
    },
    describe(tile) {
      return policy.describe(tileId(tile));
    },
  };
}
