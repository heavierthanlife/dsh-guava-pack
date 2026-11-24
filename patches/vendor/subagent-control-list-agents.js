// 由 dsh-guava-pack 提供：@deepseek-ai/dsh-tool-subagent-control/lib/list-agents.js
// 上游 0.2.2-rc.5 的 package.json 声明了 src/list-agents.ts 与 lib/types/list-agents.d.ts，
// 但发布产物缺 lib/list-agents.js，也没在 exports 里暴露 ./list-agents ——
// 于是运行时按该子路径加载的 entry 永远 never started，导致所有会话 resume 失败。
// 本文件由 esbuild 从上游同一版本的 src/list-agents.ts 编译而来（MIT，来源同上游仓库）。
// 上游一旦自带该文件，apply-subagent-list-agents.sh 会自动跳过。
// src/list-agents.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ROOT_AGENT_NAME } from "@deepseek-ai/dsh-subagent";
function statusOf(agents, id) {
  return agents.get(id)?.status === "running" ? "running" : "inactive";
}
function project(agents, entry) {
  const name = entry.path ?? entry.id;
  if (entry.kind === "diagnostic") return { name, status: entry.reason };
  if (entry.mode !== "continuable") return void 0;
  return { name, status: statusOf(agents, entry.id), description: entry.label };
}
function registerListAgents(ctx) {
  const definition = defineTool({
    name: "list_agents",
    description: "List your entire subagent tree: the root agent and all reachable continuable descendants, including yourself. Rows carry names, descriptions, and status. A descendant's name is its path from the root, such as reviewer/checker. You can message any other agent in the subagent tree. running means it is working; inactive means no turn is executing; it does not indicate task completion, success, or failure. corrupt, unsupported, or unavailable means this row's own descendants could not be read; the row itself is still a member you can message. While you remain active, you will be notified when a direct child finishes; there is no need to keep checking its status. Use send_message to continue the conversation.",
    parameters: {},
    // Catalog observations are read-only and release their Session handles.
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", required: true },
            status: { type: "string", required: true, enum: ["running", "inactive", "corrupt", "unsupported", "unavailable"] },
            description: { type: "string" }
          }
        }
      },
      render: (_args, entries) => [{
        type: "text",
        text: entries.map(
          (entry) => `${entry.name} [${entry.status}]${entry.description === void 0 ? "" : ` \u2014 ${entry.description}`}`
        ).join("\n")
      }]
    },
    async execute(_args, exec) {
      const parent = exec.agent;
      if (!parent) {
        throw new Error("list_agents requires a calling agent (exec.agent was undefined)");
      }
      const root = ctx.subagents.rootOf(parent);
      const entries = await ctx.subagents.listDescendants(root.id, exec.signal);
      return [
        { name: ROOT_AGENT_NAME, status: statusOf(ctx.agents, root.id), description: "root agent" },
        ...entries.map((entry) => project(ctx.agents, entry)).filter((entry) => entry !== void 0)
      ];
    }
  });
  ctx.tools.register(definition);
  return definition;
}
export {
  registerListAgents
};
