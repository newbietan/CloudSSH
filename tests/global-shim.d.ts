/**
 * 仅为 DOM 配置的测试类型检查提供最小 shape：src/types.ts 的 Env 接口
 * 引用 Workers 全局类 DurableObjectNamespace。该全局类型来自
 * @cloudflare/workers-types，但它声明的基础 DOM 接口（如 Element.append）
 * 与 DOM lib 合并冲突，不能在 DOM 配置中同时加载，故以最小声明替代。
 * Env 在测试中仅作类型引用、从不实例化，不影响检查真实性。
 */
declare class DurableObjectNamespace<T = unknown> {}
