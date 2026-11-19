export function createAgentRunnerRouter(entries) {
  // Map 必须持有引用而不是克隆：refreshAgentRunners 在员工增删改时原地更新
  // agentRunners，克隆会让「新建员工立即派活」永远查不到执行器。
  const runners = entries instanceof Map ? entries : new Map(Object.entries(entries || {}));
  const route = async (task, context) => {
    const agent = task.agent || "codex";
    const runner = runners.get(agent);
    if (!runner) {
      const error = new Error(`AI 员工 ${agent} 未配置执行器`);
      error.code = "AGENT_NOT_CONFIGURED";
      throw error;
    }
    return runner(task, context);
  };
  route.has = (agent) => runners.has(agent);
  route.ids = () => [...runners.keys()];
  return route;
}
