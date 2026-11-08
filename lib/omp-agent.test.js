import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PersistentOmp, RpcProcess, interactionResponse } from "./omp-agent.js";
import { SAFE_TOOLS, guardTool, assertSafePrompt } from "./omp-policy.js";
import extension from "./omp-extension.js";
import { Store } from "./store.js";

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "ghst-agent-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "workspace");
  await mkdir(join(root, "files"), { recursive: true });
  await mkdir(join(root, "references"));
  await writeFile(join(root, "references", "paper.txt"), "Page 1\nEvidence");
  return { directory, root };
}

test("isolated tools enforce actual file ownership, internal URI and execution denial", async t => {
  const { root, directory } = await workspace(t);
  assert.equal(await guardTool(root, { toolName: "read", input: { path: "references/paper.txt:1-2" } }), undefined);
  assert.equal(await guardTool(root, { toolName: "grep", input: { path: "references/*.txt", pattern: "Evidence" } }), undefined);
  assert.equal(await guardTool(root, { toolName: "glob", input: { path: "references/*.txt" } }), undefined);
  assert.equal(await guardTool(root, { toolName: "write", input: { path: "files/answer.txt", content: "answer" } }), undefined);
  for (const path of ["../state.json", join(directory, "credentials.json"), "history://other", "artifact://other", "file:///etc/passwd", "references/paper.txt;../../secret", "~/.omp/auth.json", "references/paper.txt?q=load_extension", "files/.omp/config.yml"]) {
    assert.equal((await guardTool(root, { toolName: "read", input: { path } })).block, true, path);
  }
  for (const toolName of ["bash", "eval", "task", "browser", "mcp__ambient", "debug", "github"]) assert.equal((await guardTool(root, { toolName, input: { command: "cat ~/.omp/auth.json" } })).block, true);
  assert.equal((await guardTool(root, { toolName: "write", input: { path: "references/paper.txt", content: "tampered" } })).block, true);
  assert.equal((await guardTool(root, { toolName: "glob", input: { path: "../../*" } })).block, true);
});

test("links cannot smuggle sibling session files into read, grep or glob", async t => {
  const { root, directory } = await workspace(t);
  const secret = join(directory, "secret.txt");
  await writeFile(secret, "credential");
  await symlink(secret, join(root, "files", "alias.txt"));
  for (const toolName of ["read", "grep", "glob"]) assert.equal((await guardTool(root, { toolName, input: { path: "files/alias.txt" } })).block, true);
  await rm(join(root, "files", "alias.txt"));
  await link(secret, join(root, "files", "alias.txt"));
  assert.equal((await guardTool(root, { toolName: "read", input: { path: "files/alias.txt" } })).block, true);
});

test("a redirected session workspace cannot adopt or delete another session", async t => {
  const { directory } = await workspace(t);
  const agents = join(directory, "agents");
  const thread = join(agents, "thread");
  const other = join(agents, "other", "workspace", "references");
  await mkdir(other, { recursive: true });
  await mkdir(join(thread, "workspace", "references"), { recursive: true });
  await writeFile(join(other, "keep.txt"), "other session evidence");
  await rm(join(thread, "workspace"), { recursive: true });
  await symlink(join(agents, "other", "workspace"), join(thread, "workspace"));
  const store = { directory, session(id) { assert.equal(id, "thread"); } };
  const documents = { forSession() { return new Map(); } };
  const manager = new PersistentOmp({ store, documents });
  t.after(() => manager.close());
  await assert.rejects(manager.synchronize("thread", {}), /redirected/);
  assert.equal(await readFile(join(other, "keep.txt"), "utf8"), "other session evidence");
});

test("a redirected session directory cannot synchronize another session's files", async t => {
  const { directory } = await workspace(t);
  const agents = join(directory, "agents");
  await mkdir(join(agents, "other", "workspace"), { recursive: true });
  await writeFile(join(agents, "other", "workspace", "keep.txt"), "other session evidence");
  await symlink(join(agents, "other"), join(agents, "thread"));
  const store = { directory, session(id) { assert.equal(id, "thread"); } };
  const manager = new PersistentOmp({ store, documents: { forSession() { return new Map(); } } });
  t.after(() => manager.close());
  await assert.rejects(manager.synchronize("thread", {}), /redirected/);
  assert.equal(await readFile(join(agents, "other", "workspace", "keep.txt"), "utf8"), "other session evidence");
});

test("synchronization exposes complete paginated references without embedding them in policy and removes stale files only", async t => {
  const { directory } = await workspace(t);
  const pages = [
    { page: 1, text: `${"Opening context ".repeat(200)}first-page ending` },
    { page: 2, text: "" },
    { page: 3, text: `${"Analysis detail ".repeat(200)}final-page evidence` },
  ];
  const references = new Map([
    ["thesis", { id: "thesis", sessionId: "thread", name: "Thesis.pdf", type: "pdf", pages }],
    ["guide", { id: "guide", sessionId: "thread", name: "Guide.md", type: "skill", text: "Explain uncertainty clearly." }],
  ]);
  const store = { directory, session(id) { assert.ok(["thread", "other"].includes(id)); } };
  const documents = { forSession(id) { store.session(id); return id === "thread" ? references : new Map(); } };
  const manager = new PersistentOmp({ store, documents });
  t.after(() => manager.close());
  const paths = await manager.synchronize("thread", {});
  const referencePath = join(paths.workspace, "references", "thesis.txt");
  const skillPath = join(paths.workspace, "skills", "guide.md");
  assert.equal(await readFile(referencePath, "utf8"), pages.map(page => `Page ${page.page}\n${page.text}`).join("\n\n"));
  assert.equal(await readFile(skillPath, "utf8"), "Explain uncertainty clearly.");
  for (const path of [referencePath, skillPath, join(paths.directory, "policy.json")])
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (const path of [paths.directory, paths.workspace, join(paths.directory, "history"), join(paths.workspace, "references"), join(paths.workspace, "skills")])
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const [toolName, input] of [
    ["read", { path: "references/thesis.txt:1-8" }],
    ["grep", { path: "references/*.txt", pattern: "final-page evidence" }],
    ["glob", { path: "references/*.txt" }],
    ["read", { path: "skills/guide.md" }],
  ]) assert.equal(await guardTool(paths.workspace, { toolName, input }), undefined);
  const policy = JSON.parse(await readFile(join(paths.directory, "policy.json"), "utf8"));
  assert.match(policy.systemPrompt, /Read the complete relevant pages, not isolated search snippets/);
  assert.match(policy.systemPrompt, /Do not substitute search snippets for full relevant pages/);
  assert.match(policy.systemPrompt, /Page N markers identify PDF page numbers, not text-file line numbers/);
  assert.match(policy.systemPrompt, /\(Thesis\.pdf, p\. 5\)/);
  assert.match(policy.systemPrompt, /Never invent citations/);
  assert.match(policy.systemPrompt, /"name":"Thesis.pdf","path":"references\/thesis.txt"/);
  assert.match(policy.systemPrompt, /Explain uncertainty clearly/);
  assert.doesNotMatch(policy.systemPrompt, /Opening context|first-page ending|Analysis detail|final-page evidence/);
  const historyPath = join(paths.directory, "history", "saved.jsonl");
  const workPath = join(paths.workspace, "files", "notes.txt");
  await writeFile(historyPath, "native persistent history", { mode: 0o600 });
  await writeFile(workPath, "working notes", { mode: 0o600 });
  const other = await manager.synchronize("other", {});
  await assert.rejects(readFile(join(other.workspace, "references", "thesis.txt")), { code: "ENOENT" });
  references.delete("thesis");
  references.delete("guide");
  await manager.synchronize("thread", {});
  await assert.rejects(readFile(referencePath), { code: "ENOENT" });
  await assert.rejects(readFile(skillPath), { code: "ENOENT" });
  assert.equal(await readFile(historyPath, "utf8"), "native persistent history");
  assert.equal(await readFile(workPath, "utf8"), "working notes");
  const emptyPolicy = JSON.parse(await readFile(join(paths.directory, "policy.json"), "utf8"));
  assert.doesNotMatch(emptyPolicy.systemPrompt, /references\/thesis.txt|Guide.md|Explain uncertainty clearly/);
  references.set("foreign", { id: "foreign", sessionId: "other", name: "Other.pdf", type: "pdf", pages });
  await assert.rejects(manager.synchronize("thread", {}), /ownership does not match/);
  await assert.rejects(readFile(join(paths.workspace, "references", "foreign.txt")), { code: "ENOENT" });
});

test("hashline checks all file headers and move destinations before executing", async t => {
  const { root } = await workspace(t);
  const allowed = "*** Begin Patch\n[files/answer.txt#ABCD]\nPUT <1:\n+answer\n*** End Patch\n";
  assert.equal(await guardTool(root, { toolName: "edit", input: { input: allowed } }), undefined);
  for (const input of [allowed.replace("files/answer.txt", "../secret"), allowed.replace("*** End Patch", "MV ../../secret\n*** End Patch"), allowed.replace("*** End Patch", "[../../secret#1234]\nREM\n*** End Patch"), "*** Begin Patch\n*** Delete File: /etc/passwd\n*** End Patch"]) assert.equal((await guardTool(root, { toolName: "edit", input: { input } })).block, true);
  assert.equal((await guardTool(root, { toolName: "edit", input: { path: "files/a", edits: [{ rename: "../secret" }] } })).block, true);
});

test("native slash dispatch cannot bypass the isolated tool boundary", () => {
  assert.doesNotThrow(() => assertSafePrompt("/compact snapcompact"));
  for (const text of ["!cat /etc/passwd", "  !cat secret", "/export /tmp/leak", "/mcp", "  /add-dir /", "/config", "/share", "/move /tmp"]) assert.throws(() => assertSafePrompt(text));
});

test("dialogs use method-specific native responses, not invented approval commands", () => {
  assert.deepEqual(interactionResponse({ id: "c", method: "confirm" }, { value: false }), { type: "extension_ui_response", id: "c", confirmed: false });
  assert.deepEqual(interactionResponse({ id: "s", method: "select", options: ["Approve", "Deny"] }, { value: "Approve" }), { type: "extension_ui_response", id: "s", value: "Approve" });
  assert.deepEqual(interactionResponse({ id: "s", method: "select" }, { value: null }), { type: "extension_ui_response", id: "s", cancelled: true });
  const ask = { id: "a", method: "ask", questions: [{ id: "q", options: [{ label: "Yes" }] }] };
  const answers = [{ id: "q", selectedOptions: ["Yes"] }];
  assert.deepEqual(interactionResponse(ask, { value: { answers } }).answers, answers);
  assert.throws(() => interactionResponse(ask, { answers: [{ id: "q", selectedOptions: ["No"] }] }));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.kill = () => { child.signalCode = "SIGTERM"; };
  return child;
}

test("RPC correlates interleaved responses and rejects oversized or malformed frames", async () => {
  const child = fakeChild();
  const rpc = new RpcProcess(child);
  child.stdout.write('{"type":"rea'); child.stdout.write('dy","protocolVersion":1}\n');
  await rpc.ready;
  const first = rpc.request("get_state", {}, "one");
  const second = rpc.request("get_available_models", {}, "two");
  child.stdout.write('{"type":"response","id":"two","success":true,"data":{"models":[]}}\n');
  child.stdout.write('{"type":"response","id":"one","success":true,"data":{"isSettled":true}}\n');
  assert.deepEqual(await second, { models: [] });
  assert.deepEqual(await first, { isSettled: true });
  child.stdout.write(Buffer.alloc(1024 * 1024, 65));
  assert.match(rpc.failure.message, /frame limit/);
  assert.equal(child.signalCode, "SIGTERM");
});

test("trusted extension refreshes current instructions and blocks before tool execution", async t => {
  const { root, directory } = await workspace(t);
  const oldRoot = process.env.GHST_OMP_WORKSPACE, oldPolicy = process.env.GHST_OMP_POLICY;
  process.env.GHST_OMP_WORKSPACE = root; process.env.GHST_OMP_POLICY = join(directory, "policy.json");
  t.after(() => { if (oldRoot === undefined) delete process.env.GHST_OMP_WORKSPACE; else process.env.GHST_OMP_WORKSPACE = oldRoot; if (oldPolicy === undefined) delete process.env.GHST_OMP_POLICY; else process.env.GHST_OMP_POLICY = oldPolicy; });
  await writeFile(process.env.GHST_OMP_POLICY, JSON.stringify({ toolAccess: "isolated", systemPrompt: "first" }));
  const hooks = new Map(), commands = new Map();
  extension({ on: (name, fn) => hooks.set(name, fn), registerCommand: (name, value) => commands.set(name, value) });
  assert.deepEqual(await hooks.get("before_agent_start")(), { systemPrompt: ["first"] });
  assert.equal((await hooks.get("tool_call")({ toolName: "bash" })).block, true);
  await writeFile(process.env.GHST_OMP_POLICY, JSON.stringify({ toolAccess: "trusted", systemPrompt: "second" }));
  assert.deepEqual(await hooks.get("before_agent_start")(), { systemPrompt: ["second"] });
  assert.equal((await hooks.get("tool_call")({ toolName: "bash" })).block, true);
  assert.equal(await hooks.get("tool_call")({ toolName: "read", input: { path: "references/paper.txt" } }), undefined);
  await assert.rejects(hooks.get("input")({ text: "/export /tmp/leak" }), /unavailable/);
  assert.deepEqual([...commands.keys()], ["ghst-boundary"]);
});

const fakeRuntime = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const history = args[args.indexOf('--session-dir') + 1];
const file = path.join(history, 'fixture.json');
const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
let messages = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
fs.writeFileSync(path.join(history, 'argv.json'), JSON.stringify(args));
send({type:'ready',protocolVersion:1,supportedProtocolVersions:[1,2]});
const reply = (cmd,data) => send({type:'response',id:cmd.id,command:cmd.type,success:true,data});
readline.createInterface({input:process.stdin}).on('line', line => {
 const cmd = JSON.parse(line);
 fs.appendFileSync(path.join(history, 'commands.jsonl'), JSON.stringify(cmd) + '\\n');
 if(cmd.type === 'get_available_commands') return reply(cmd,{commands:[{name:'ghst-boundary'}]});
 if(cmd.type === 'get_state') return reply(cmd,{messageCount:messages.length,isSettled:true,autoCompactionEnabled:config.compaction.enabled});
 if(cmd.type === 'prompt') {
  messages.push(cmd.message); fs.writeFileSync(file,JSON.stringify(messages));
  reply(cmd,{agentInvoked:true});
  send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'answer'}});
  send({type:'extension_ui_request',id:'widget-1',method:'setWidget',widget:{type:'text',text:'progress'}});
  send({type:'tool_execution_start',toolCallId:'reference-read',toolName:'read',args:{path:'references/paper.txt'}});
  send({type:'tool_execution_end',toolCallId:'reference-read',toolName:'read',result:{content:[{type:'text',text:'Evidence'}]},isError:false});
  if(cmd.message.includes('working file')) send({type:'extension_ui_request',id:'dialog-1',method:'confirm',title:'Allow the write?',message:'Write files/note.md'});
  send({type:'agent_end',messages:[]});
  send({type:'prompt_result',id:cmd.id,status:'completed',sessionSettled:false});
  setTimeout(() => {
    if(cmd.message.includes('threshold')) {
      send({type:'auto_compaction_start',reason:'threshold'});
      send({type:'auto_compaction_end',result:{summary:'archived context'},aborted:false,willRetry:false});
    }
    send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:' follow-up'}});
    send({type:'session_settled'});
  },30);
  return;
 }
 reply(cmd,{});
});
`;

test("internal runtimes persist transcription turns, wait for native maintenance, resume and remain isolated", async t => {
  const { directory } = await workspace(t);
  const binary = join(directory, "fake-omp");
  await writeFile(binary, fakeRuntime, { mode: 0o700 });
  const previous = process.env.GHST_OMP_PATH;
  process.env.GHST_OMP_PATH = binary;
  t.after(() => { if (previous === undefined) delete process.env.GHST_OMP_PATH; else process.env.GHST_OMP_PATH = previous; });
  const references = new Map([["pdf-one", { id: "pdf-one", sessionId: "thread", name: "Paper", type: "pdf", pages: [{ page: 1, text: "owned evidence" }] }], ["skill-one", { id: "skill-one", sessionId: "thread", name: "Skill", type: "skill", text: "cite evidence" }]]);
  const otherReferences = new Map([["pdf-other", { id: "pdf-other", sessionId: "other", name: "Other paper", type: "pdf", pages: [{ page: 2, text: "other evidence" }] }]]);
  const store = { directory, session(id) { assert.ok(["thread", "other"].includes(id)); } };
  const documents = { forSession(id) { store.session(id); return id === "thread" ? references : otherReferences; } };
  let manager = new PersistentOmp({ store, documents });
  t.after(() => manager.close());
  const settings = { subscriptionModel: "openai-codex/fixture", instructions: "current only", agentToolAccess: "trusted" };
  const initialized = await manager.get("thread", settings);
  assert.equal(initialized.historySeeded, false);
  assert.equal(await manager.get("thread", settings), initialized);
  const initialCommands = (await readFile(join(directory, "agents", "thread", "history", "commands.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.ok(initialCommands.every(command => command.type !== "prompt" && command.type !== "compact"));
  await assert.rejects(readFile(join(directory, "agents", "thread", "history", "fixture.json")), { code: "ENOENT" });
  const collect = async (question, sessionId = "thread") => { const events = []; for await (const event of manager.answer({ sessionId, settings, question, messages: [{ role: "system", content: "ambient must not propagate" }, { role: "user", content: question }] })) events.push(event); return events; };
  const first = await collect("first question");
  assert.equal(manager.sessions.get("thread"), initialized);
  assert.equal(first.filter(event => event.type === "delta").map(event => event.text).join(""), "answer follow-up");
  assert.equal(first.at(-1).event.type, "session_settled");
  assert.deepEqual(first.filter(event => event.type === "interaction"), []);
  assert.ok(first.some(event => event.type === "agent" && event.event.type === "extension_ui_request" && event.event.id === "widget-1"));
  const history = join(directory, "agents", "thread", "history");
  const args = JSON.parse(await readFile(join(history, "argv.json"), "utf8"));
  assert.equal(args[args.indexOf("--mode") + 1], "rpc-ui");
  assert.ok(args.includes("--continue")); assert.ok(!args.includes("--no-session")); assert.ok(!args.includes("--no-tools"));
  assert.equal(args[args.indexOf("--tools") + 1], SAFE_TOOLS.join(","));
  assert.equal(args[args.indexOf("--approval-mode") + 1], "always-ask");
  const config = JSON.parse(await readFile(join(directory, "agents", "thread", "config.json"), "utf8"));
  assert.deepEqual(config.compaction, { enabled: true, midTurnEnabled: true, methodOrder: ["snapcompact", "remote", "handoff", "shake", "soft"] });
  for (const name of ["read", "grep", "glob", "web_search"]) assert.equal(config.tools.approval[name], "allow");
  for (const name of ["write", "edit"]) assert.equal(config.tools.approval[name], "prompt");
  const originalProcess = manager.sessions.get("thread").rpc;
  await collect("second question");
  assert.equal(manager.sessions.get("thread").rpc, originalProcess);
  assert.deepEqual(JSON.parse(await readFile(join(history, "fixture.json"), "utf8")), ["first question", "second question"]);
  const work = join(directory, "agents", "thread", "workspace");
  assert.match(await readFile(join(work, "references", "pdf-one.txt"), "utf8"), /Page 1\nowned evidence/);
  await collect("independent question", "other");
  assert.notEqual(manager.sessions.get("other").rpc, originalProcess);
  const otherDirectory = join(directory, "agents", "other");
  assert.deepEqual(JSON.parse(await readFile(join(otherDirectory, "history", "fixture.json"), "utf8")), ["independent question"]);
  assert.match(await readFile(join(otherDirectory, "workspace", "references", "pdf-other.txt"), "utf8"), /other evidence/);
  await assert.rejects(readFile(join(otherDirectory, "workspace", "references", "pdf-one.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(work, "references", "pdf-other.txt")), { code: "ENOENT" });
  assert.deepEqual(JSON.parse(await readFile(join(history, "fixture.json"), "utf8")), ["first question", "second question"]);
  references.delete("skill-one"); settings.instructions = "new instructions";
  const maintenance = await collect("third question crosses threshold");
  assert.ok(maintenance.some(event => event.event?.type === "auto_compaction_end"));
  assert.equal(maintenance.at(-1).event.type, "session_settled");
  await assert.rejects(readFile(join(work, "skills", "skill-one.md")), { code: "ENOENT" });
  const policy = JSON.parse(await readFile(join(directory, "agents", "thread", "policy.json"), "utf8"));
  assert.match(policy.systemPrompt, /new instructions/); assert.doesNotMatch(policy.systemPrompt, /cite evidence|ambient must not propagate/);
  assert.doesNotMatch(policy.systemPrompt, /Other paper|unrestricted/);
  await manager.close();
  manager = new PersistentOmp({ store, documents });
  await collect("resumed question");
  assert.equal(JSON.parse(await readFile(join(history, "fixture.json"), "utf8")).length, 4);
  const commands = (await readFile(join(history, "commands.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(commands.filter(command => command.type === "prompt").length, 4);
  assert.ok(commands.filter(command => command.type === "prompt").every(command => !command.message.startsWith("/")));
  assert.ok(commands.every(command => command.type !== "compact"));
  for (const command of ["state", "models", "commands", "compact", "snapcompact", "invented"]) {
    await assert.rejects(manager.command("thread", { command }), /Unsupported/);
  }
  const explicitWrite = await collect("Please create a working file");
  assert.deepEqual(explicitWrite.filter(event => event.type === "interaction").map(event => event.request.id), ["dialog-1"]);
  assert.equal((await manager.command("thread", { command: "respond", requestId: "dialog-1", confirmed: false })).responded, true);
  assert.equal(manager.sessions.get("thread").rpc.dialogs.size, 0);
  assert.equal((await manager.command("thread", { command: "cancel" })).cancelled, true);
  await manager.close();
  assert.deepEqual(JSON.parse(await readFile(join(history, "fixture.json"), "utf8")), ["first question", "second question", "third question crosses threshold", "resumed question", "Please create a working file"]);
  assert.deepEqual(JSON.parse(await readFile(join(otherDirectory, "history", "fixture.json"), "utf8")), ["independent question"]);
});

test("saved tool access is removed without changing conversations or reference ownership", async t => {
  const { directory } = await workspace(t);
  const store = await new Store(directory).init();
  await store.update(state => {
    state.settings.agentToolAccess = "trusted";
    state.sessions.push({ id: "thread", title: "Saved", createdAt: "2026-01-01", transcript: [], messages: [{ id: "question", role: "user", text: "Saved question" }] });
    state.documents.push({ id: "paper", sessionId: "thread", name: "Paper", type: "pdf" });
  });
  const restored = await new Store(directory).init();
  assert.equal(Object.hasOwn(restored.state.settings, "agentToolAccess"), false);
  assert.equal(Object.hasOwn(restored.publicState().settings, "agentToolAccess"), false);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(restored.path, "utf8")).settings, "agentToolAccess"), false);
  assert.deepEqual(restored.state.sessions, store.state.sessions);
  assert.deepEqual(restored.state.documents, store.state.documents);
});

test("interaction commands never start a runtime for an idle session", async t => {
  const { directory } = await workspace(t);
  const manager = new PersistentOmp({ store: { directory, session() {} }, documents: { forSession() { throw new Error("Must not synchronize"); } } });
  assert.deepEqual(await manager.command("thread", { command: "cancel" }), { cancelled: false });
  await assert.rejects(manager.command("thread", { command: "respond", requestId: "missing" }), /no longer pending/);
  assert.equal(manager.sessions.size, 0);
});
