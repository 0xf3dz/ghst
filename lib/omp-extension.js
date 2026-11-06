import { readFile, realpath } from "node:fs/promises";
import { guardTool, assertSafePrompt } from "./omp-policy.js";

export default function ghstExtension(pi) {
  const rootPromise = realpath(process.env.GHST_OMP_WORKSPACE);
  const policy = async () => JSON.parse(await readFile(process.env.GHST_OMP_POLICY, "utf8"));
  pi.on("tool_call", async event => {
    return guardTool(await rootPromise, event);
  });
  pi.on("input", async event => {
    assertSafePrompt(event.text);
  });
  pi.on("before_agent_start", async () => ({ systemPrompt: [(await policy()).systemPrompt] }));
  pi.registerCommand("ghst-boundary", {
    description: "Ghst host-managed session policy is installed",
    handler: async (_args, ctx) => ctx.ui.notify("Ghst session policy is active.", "info"),
  });
}
