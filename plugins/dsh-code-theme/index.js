/**
 * dsh-code-theme — host 半边。
 *
 * 这个插件全部逻辑在浏览器侧（配色只发生在 CSS 变量层），host 侧无事可做，
 * 但仍然需要一个可挂载的模块，bundle patch 才能插进这一行。
 *
 * @module dsh-code-theme
 */

/** Cordis 插件名。 */
const name = 'code-theme';

/** 不依赖任何 host 服务。 */
const inject = [];

/** 空实现：客户端半边自己完成注册。 */
function apply() {}

export { apply, inject, name };
