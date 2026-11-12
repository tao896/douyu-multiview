// 扩展后台的斗鱼接口：实现在 public/douyu-client.js（构建时与本文件放在同一目录）。
// 跨域访问由 manifest 的 host_permissions 授权；浏览器自带 User-Agent，Referer 无法设置，不传额外请求头。
import { createDouyuClient } from './douyu-client.js';

export { DouyuError, normalizeAvatarUrl } from './douyu-client.js';

export const { DID, getStream, getRoomInfo, resolveRid, resetDouyuCachesForTest } = createDouyuClient();
