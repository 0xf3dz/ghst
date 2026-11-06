import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const SAFE_TOOLS = ["read", "write", "edit", "grep", "glob", "ask", "todo", "web_search"];
export const TOOL_BOUNDARY = {
  mode: "isolated",
  enforcement: "trusted-extension",
  enabledTools: SAFE_TOOLS,
  disabledTools: ["bash", "eval", "task", "browser", "debug", "lsp", "github", "mcp"],
  reason: "Execution, browser, delegation and external tools are disabled because they cannot be confined to this session workspace. Runtime authentication is not available to model tools.",
};
const inside = (root, target) => target === root || target.startsWith(root + sep);

export async function assertWorkspaceTree(root) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, item.name);
    if (item.isSymbolicLink()) throw new Error("Symbolic links are not permitted in the agent workspace.");
    if (item.isDirectory()) await assertWorkspaceTree(path);
    else if (!item.isFile()) throw new Error("Special files are not permitted in the agent workspace.");
    else if ((await lstat(path)).nlink > 1) throw new Error("Hard-linked files are not permitted in the agent workspace.");
  }
}

export async function assertWorkspacePath(root, value, { write = false, pattern = false } = {}) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\\;?]/.test(value) || value.includes("://") || value.startsWith("~"))
    throw new Error("Only ordinary paths in this session workspace are supported.");
  root = await realpath(root);
  let path = value;
  if (!write) path = path.replace(/:(?:raw:)?[0-9,+-]+(?::raw)?$/, "");
  if (path.includes(":")) throw new Error("Internal URIs, archives and database selectors are not permitted.");
  if (path.split("/").some(part => part === "..")) throw new Error("Parent traversal is not permitted.");
  if (pattern) path = path.split(/[\*\[\{]/, 1)[0] || ".";
  else if (/[\*\[\{]/.test(path)) throw new Error("This operation requires a literal file path.");
  const target = resolve(root, path);
  if (write && !inside(resolve(root, "files"), target)) throw new Error("Write and edit only files/; references and runtime policy are host-owned.");
  let current = target;
  while (true) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) throw new Error("Links and special files are not permitted.");
      if (!inside(root, await realpath(current))) throw new Error("The canonical path escapes this session workspace.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (current === root) throw error;
      current = dirname(current);
    }
  }
  const parts = relative(root, target).split(sep);
  if (parts.some(part => part.startsWith("."))) throw new Error("Hidden configuration and credential paths are not permitted.");
  return target;
}

export async function guardTool(root, event) {
  try {
    const { toolName, input = {} } = event;
    if (!SAFE_TOOLS.includes(toolName)) throw new Error(TOOL_BOUNDARY.reason);
    if (["ask", "todo", "web_search"].includes(toolName)) return;
    await assertWorkspaceTree(root);
    if (toolName === "edit") {
      if (typeof input.path === "string") {
        await assertWorkspacePath(root, input.path, { write: true });
        for (const edit of input.edits || []) if (edit.rename) await assertWorkspacePath(root, edit.rename, { write: true });
      } else {
        if (typeof input.input !== "string") throw new Error("Unrecognized edit format.");
        let files = 0;
        for (const line of input.input.split("\n")) {
          if (!line || line.startsWith("+") || line === "*** Begin Patch" || line === "*** End Patch") continue;
          const header = line.match(/^\[([^#\r\n]+)#[0-9A-Fa-f]{4}\]$/);
          const move = line.match(/^MV (.+)$/);
          if (header || move) {
            const path = (header || move)[1];
            await assertWorkspacePath(root, path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path, { write: true });
            if (header) files++;
          } else if (!/^(?:PUT|CUT) (?:[<>]?\d+(?:\*|\.=\d+)?|>\$)(?::| @[A-Za-z0-9_-]+)?$/.test(line) && line !== "REM") {
            throw new Error("Unrecognized hashline operation; refusing an unchecked edit.");
          }
        }
        if (!files) throw new Error("The edit contains no checked file targets.");
      }
      return;
    }
    const pattern = ["grep", "glob"].includes(toolName);
    await assertWorkspacePath(root, input.path ?? (pattern ? "." : ""), { write: toolName === "write", pattern });
  } catch (error) {
    return { block: true, reason: error.message };
  }
}

export const SAFE_SLASH = new Set(["compact", "snapcompact", "help", "status", "stats", "model", "thinking", "clear"]);
export function assertSafePrompt(text) {
  text = text.trimStart();
  if (/^!/.test(text)) throw new Error("Shell execution is unavailable in an isolated session.");
  if (text.startsWith("/") && !SAFE_SLASH.has(text.slice(1).split(/\s/, 1)[0]))
    throw new Error("This native command is unavailable inside the isolated session boundary.");
}
