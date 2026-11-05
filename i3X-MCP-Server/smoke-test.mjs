// Smoke test: chat-based connect flow (no env vars).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = spawn("node", ["dist/index.js"], {
  env: { ...process.env, I3X_BASE_URL: "" }, // explicitly unset
  stdio: ["pipe", "pipe", "pipe"],
});
const rl = createInterface({ input: server.stdout });
const responses = new Map();
rl.on("line", l => { try { const m = JSON.parse(l); if (m.id !== undefined) responses.get(m.id)?.(m); } catch {} });
server.stderr.on("data", d => process.stderr.write(`[server] ${d}`));

let nextId = 1;
const send = (method, params) => new Promise(res => { const id = nextId++; responses.set(id, res); server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
const notify = (method, params) => server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  return { txt: r.result?.content?.[0]?.text ?? "", error: r.result?.isError };
};

async function run() {
  await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  notify("notifications/initialized", {});

  console.log("\n== tools/list before connect ==");
  const list = await send("tools/list", {});
  console.log(`  ${list.result.tools.length} tools registered`);
  for (const t of list.result.tools) console.log(`   - ${t.name}`);

  console.log("\n== search_objects without connect (should refuse with friendly msg) ==");
  const s1 = await call("search_objects", { query: "x" });
  console.log(`  isError=${s1.error}`);
  console.log(`  ${s1.txt.slice(0, 200).replace(/\n/g, "\n  ")}`);

  console.log("\n== connect to demo ==");
  const c = await call("connect", { baseUrl: "https://api.i3x.dev/v1" });
  console.log(`  isError=${c.error}`);
  console.log(`  ${c.txt.slice(0, 250).replace(/\n/g, "\n  ")}`);

  console.log("\n== connection_status ==");
  const st = await call("connection_status", {});
  console.log(`  ${st.txt.slice(0, 250).replace(/\n/g, "\n  ")}`);

  console.log("\n== search_objects after connect ==");
  const s2 = await call("search_objects", { query: "pump" });
  console.log(`  isError=${s2.error}`);
  console.log(`  ${s2.txt.slice(0, 300).replace(/\n/g, "\n  ")}`);

  console.log("\n== connect with bad URL (should error cleanly) ==");
  const bad = await call("connect", { baseUrl: "https://no-such-host-xyz.example.com/v1" });
  console.log(`  isError=${bad.error}`);
  console.log(`  ${bad.txt.slice(0, 250).replace(/\n/g, "\n  ")}`);

  console.log("\n== old connection still works (connect on failure does NOT clobber state) ==");
  const s3 = await call("connection_status", {});
  console.log(`  ${s3.txt.slice(0, 200).replace(/\n/g, "\n  ")}`);

  server.kill();
  process.exit(0);
}
run().catch(e => { console.error("smoke failed:", e); server.kill(); process.exit(1); });
setTimeout(() => { console.error("timeout"); server.kill(); process.exit(1); }, 40_000);
