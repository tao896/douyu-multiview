// Node 服务端的斗鱼接口：实现在 public/douyu-client.js，这里只补上浏览器才会自动带的请求头。
import { createDouyuClient } from '../public/douyu-client.js';

export { DouyuError, normalizeAvatarUrl } from '../public/douyu-client.js';

const ORIGIN = 'https://www.douyu.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const { DID, getStream, getRoomInfo, resolveRid, resetDouyuCachesForTest } = createDouyuClient({
  headers: (rid) => ({ 'User-Agent': UA, Referer: rid ? `${ORIGIN}/${rid}` : ORIGIN }),
});
