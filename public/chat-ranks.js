// 聊天窗顶部：今日统计 + 在线榜 / 活跃榜 / 贵宾 / 钻粉
import { fetchRoomStats, STATS_SOURCE } from './room-stats.js';
import { isAbortError } from './net.js';

const STATS_REFRESH_MS = 150_000;
const STATS_CACHE_MS = 60_000;
export const RANK_TABS = ['online', 'active', 'vip', 'diamond'];
const EMPTY_TEXT = {
  online: '在线榜加载中…',
  active: '活跃榜加载中…（今日暂无贡献时为空）',
  vip: '贵宾列表加载中…',
  diamond: '钻粉榜加载中…（没有钻粉时为空）',
};

export function formatCount(value) {
  if (value == null || value === '') return '—';
  const number = Number(value);
  // 斗鱼部分人数已是「3.9万」这样的文本
  if (!Number.isFinite(number)) return String(value);
  return number >= 1e4 ? `${(number / 1e4).toFixed(1).replace(/\.0$/, '')}万` : number.toLocaleString('zh-CN');
}

export function formatMoney(value) {
  if (value == null) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number >= 1e4 ? `¥${(number / 1e4).toFixed(2)}万` : `¥${number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

// 活跃榜贡献值 1000 = 1 元
export const goldToYuan = (gold) => (gold == null ? null : gold / 1000);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export class ChatRanks {
  constructor(root) {
    this.root = root;
    this.statsEl = root.querySelector('[data-chat-stats]');
    this.list = root.querySelector('[data-rank-list]');
    this.tabs = [...root.querySelectorAll('[data-rank-tab]')];
    this.tab = 'online';
    this.rid = '';
    this.ranks = {};
    this.visible = false;
    this.statsCache = new Map();
    this.statsTimer = 0;
    this.statsController = null;
    this.tabs.forEach((button) => button.addEventListener('click', () => this.selectTab(button.dataset.rankTab)));
    // 头像加载失败时只隐藏图片，保留占位
    this.list.addEventListener('error', (event) => {
      if (event.target.tagName === 'IMG') event.target.style.visibility = 'hidden';
    }, true);
    this.renderStats();
    this.renderRanks();
  }

  setRoom(rid) {
    const value = String(rid || '');
    if (value === this.rid) return;
    this.rid = value;
    this.ranks = {};
    this.list.scrollTop = 0;
    this.renderRanks();
    this.renderStats();
    if (this.visible) this.loadStats();
  }

  // ranks: tile.ranks，{ online|active|vip|diamond: { count, list, updatedAt } }
  setRanks(ranks = {}) {
    this.ranks = ranks;
    this.renderRanks();
  }

  setVisible(visible) {
    this.visible = !!visible;
    clearInterval(this.statsTimer);
    this.statsTimer = 0;
    if (!this.visible) {
      this.statsController?.abort();
      return;
    }
    this.loadStats();
    this.statsTimer = setInterval(() => this.loadStats({ force: true }), STATS_REFRESH_MS);
  }

  selectTab(tab) {
    if (!RANK_TABS.includes(tab) || tab === this.tab) return;
    this.tab = tab;
    this.list.scrollTop = 0;
    this.renderRanks();
  }

  async loadStats({ force = false } = {}) {
    const rid = this.rid;
    if (!rid) return;
    const cached = this.statsCache.get(rid);
    if (!force && cached && Date.now() - cached.at < STATS_CACHE_MS) return this.renderStats();
    this.statsController?.abort();
    const controller = new AbortController();
    this.statsController = controller;
    try {
      const stats = await fetchRoomStats(rid, { signal: controller.signal });
      this.statsCache.set(rid, { at: Date.now(), stats, error: '' });
    } catch (error) {
      if (isAbortError(error)) return;
      // 刷新失败时保留上次成功的数据
      this.statsCache.set(rid, { at: Date.now(), stats: cached?.stats, error: error?.message || '请求失败' });
    } finally {
      if (this.statsController === controller) this.statsController = null;
    }
    if (rid === this.rid) this.renderStats();
  }

  renderStats() {
    const entry = this.statsCache.get(this.rid);
    const stats = entry?.stats;
    this.statsEl.replaceChildren();
    this.statsEl.removeAttribute('title');
    if (!this.rid) return;
    if (!entry) {
      this.statsEl.append(el('p', 'chat-stats-note', '今日统计加载中…'));
      return;
    }
    if (!stats) {
      const text = entry.error ? `今日统计加载失败：${entry.error}` : `${STATS_SOURCE} 未收录本直播间，暂无今日统计`;
      this.statsEl.append(el('p', 'chat-stats-note', text));
      return;
    }
    const items = [
      ['今日流水', formatMoney(stats.income)],
      ['付费人数', formatCount(stats.paid)],
      ['贵宾峰值', formatCount(stats.vipPeak)],
      ['弹幕人数', formatCount(stats.danmakuUsers)],
    ];
    for (const [label, value] of items) {
      const cell = el('div', 'chat-stat');
      cell.append(el('span', '', label), el('b', '', value));
      this.statsEl.append(cell);
    }
    const hours = stats.liveMins == null ? '—' : `${Math.floor(stats.liveMins / 60)} 小时 ${stats.liveMins % 60} 分`;
    this.statsEl.title = [
      `统计日期 ${stats.date}（北京时间）`,
      `送礼人数 ${formatCount(stats.givers)} · 礼物总数 ${formatCount(stats.gifts)}`,
      `弹幕总数 ${formatCount(stats.danmaku)} · 开播时长 ${hours}`,
      `钻粉总数 ${formatCount(stats.diamond)}`,
      entry.error ? `最近一次刷新失败：${entry.error}` : '',
      `数据来自 ${STATS_SOURCE}，流水按礼物价值折算，不是主播实际收入，仅供参考`,
    ].filter(Boolean).join('\n');
  }

  tabCount(tab) {
    const rank = this.ranks[tab];
    if (tab === 'active') {
      if (!rank?.list?.length) return '—';
      const total = rank.list.reduce((sum, user) => sum + (user.gold || 0), 0);
      return formatMoney(goldToYuan(total));
    }
    return formatCount(rank?.count ?? null);
  }

  renderRanks() {
    for (const button of this.tabs) {
      const tab = button.dataset.rankTab;
      const active = tab === this.tab;
      button.classList.toggle('on', active);
      button.setAttribute('aria-selected', String(active));
      const count = button.querySelector('[data-rank-count]');
      const text = this.tabCount(tab);
      if (count.textContent !== text) count.textContent = text;
    }
    this.list.title = this.tab === 'active' ? '活跃榜只有日榜前 10 名；标签上的金额是前 10 名贡献值合计（1000 贡献值 = 1 元）' : '';
    const list = this.ranks[this.tab]?.list;
    if (!list?.length) {
      this.list.replaceChildren(el('p', 'chat-rank-empty', this.rid ? EMPTY_TEXT[this.tab] : '打开直播间后显示榜单'));
      return;
    }
    const fragment = document.createDocumentFragment();
    list.forEach((user, index) => fragment.appendChild(this.renderUser(user, index)));
    this.list.replaceChildren(fragment);
  }

  renderUser(user, index) {
    const row = el('div', 'chat-rank-item');
    row.append(el('span', `chat-rank-no${index < 3 ? ` top${index + 1}` : ''}`, String(index + 1)));
    const avatar = el('img', 'chat-rank-avatar');
    avatar.alt = '';
    avatar.loading = 'lazy';
    avatar.referrerPolicy = 'no-referrer';
    if (user.avatar) avatar.src = user.avatar;
    row.append(avatar, el('span', 'chat-rank-name', user.name));
    if (user.diamond) row.append(el('span', 'chat-rank-tag diamond', '钻'));
    if (user.level > 0) row.append(el('span', 'chat-rank-tag', `Lv${user.level}`));
    if (this.tab === 'active' && user.gold != null) {
      const value = el('span', 'chat-rank-value', formatMoney(goldToYuan(user.gold)));
      value.title = `贡献值 ${user.gold.toLocaleString('zh-CN')}`;
      row.append(value);
    } else if (this.tab === 'diamond' && user.badgeLevel > 0) {
      const value = el('span', 'chat-rank-value', `${user.badgeLevel}级`);
      value.title = `${user.badge || '粉丝牌'} ${user.badgeLevel} 级`;
      row.append(value);
    }
    row.title = user.badge && user.badgeLevel ? `${user.name} · ${user.badge} ${user.badgeLevel} 级` : user.name;
    return row;
  }
}
