/**
 * 统一的 `js-yaml` 解析器入口。
 *
 * ## 为什么需要这一层
 *
 * 以前的写法是把一个**绝对路径**写死在 import 里：
 *
 *     import yaml from '/home/guava5tar_/dsh/node_modules/js-yaml/dist/js-yaml.mjs';
 *
 * 这在本人机器上能跑，但它是整套规则书里最容易在别处炸的一行 ——
 * 换了用户名、把 pack 装到 `~/dsh-guava-pack`、或者从 systemd/cron 里跑
 * （家目录解析不同）都会直接 `ERR_MODULE_NOT_FOUND`，连"降级"都没有。
 * 定时任务里这种崩溃最难发现：它只在无人值守时发生。
 *
 * ## 解析顺序
 *
 *   1. 裸解析 `js-yaml` —— pack 只要位于 DSH_HOME 之下（`<home>/dsh/...`），
 *      Node 会沿祖先目录找到 `<home>/dsh/node_modules/js-yaml`，这条最稳。
 *   2. `<DSH_HOME>/node_modules/js-yaml`（DSH 自带依赖的显式位置）。
 *   3. `<HOME>/dsh/node_modules/js-yaml`（DSH_HOME 未设时的默认家）。
 *   4. 从 `<DSH_HOME>/package.json` 用 `createRequire` 解析（兼容 exports 映射）。
 *
 * 四步全失败才抛错，并把试过的路径都打出来 —— 便于一眼定位"这台机器缺依赖"。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const dshHomes = () => {
  const homes = [];
  if (process.env.DSH_HOME) homes.push(process.env.DSH_HOME);
  if (process.env.HOME) homes.push(join(process.env.HOME, 'dsh'));
  return [...new Set(homes)];
};

async function importFile(path) {
  const mod = await import(pathToFileURL(path).href);
  return mod.default ?? mod;
}

/**
 * 载入 js-yaml 的默认导出（`load` / `dump` 都在上面）。
 * @returns {Promise<{load:(s:string)=>any, dump:(v:unknown,o?:object)=>string}>}
 */
export async function loadYaml() {
  const tried = [];

  // 1) 裸解析：pack 位于 DSH_HOME 之下时最稳
  try {
    const mod = await import('js-yaml');
    const yaml = mod.default ?? mod;
    if (yaml?.load) return yaml;
  } catch (err) {
    tried.push(`import("js-yaml") → ${err.code || err.message}`);
  }

  // 2/3) 直接找 DSH 自带的那份
  for (const home of dshHomes()) {
    const file = join(home, 'node_modules', 'js-yaml', 'dist', 'js-yaml.mjs');
    tried.push(file);
    if (!existsSync(file)) continue;
    const yaml = await importFile(file);
    if (yaml?.load) return yaml;
  }

  // 4) createRequire 按 Node 解析规则再试一次（兼容 exports 映射布局）
  for (const home of dshHomes()) {
    const anchor = join(home, 'package.json');
    if (!existsSync(anchor)) continue;
    try {
      const req = createRequire(pathToFileURL(anchor).href);
      const yaml = await importFile(req.resolve('js-yaml'));
      if (yaml?.load) return yaml;
    } catch (err) {
      tried.push(`createRequire(${home}) → ${err.code || err.message}`);
    }
  }

  throw new Error(
    '找不到 js-yaml。它来自 DSH 自身的依赖，请确认 DSH_HOME 正确且已安装依赖。\n  已尝试：\n' +
    tried.map((t) => `    - ${t}`).join('\n'),
  );
}
