const BASE = "http://127.0.0.1:8317/v1";
const MODEL = "reflection/beam:free";

async function call(body) {
  const r = await fetch(BASE + "/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (body.stream === false) return { status: r.status, json: await r.json() };
  if (!r.ok) return { status: r.status, text: (await r.text()).slice(0, 200) };
  let content = "", reasoning = "", finish = null, usage = null;
  const calls = new Map();
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (d === "[DONE]") continue;
        const ev = JSON.parse(d);
        if (ev.usage) usage = ev.usage;
        for (const c of ev.choices || []) {
          const dl = c.delta || {};
          if (dl.content) content += dl.content;
          if (dl.reasoning_content) reasoning += dl.reasoning_content;
          for (const tc of dl.tool_calls || []) {
            const k = tc.index ?? 0;
            if (!calls.has(k)) calls.set(k, { id: "", name: "", args: "" });
            const cur = calls.get(k);
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
          }
          if (c.finish_reason) finish = c.finish_reason;
        }
      }
    }
  }
  return { status: r.status, content, reasoning, finish, usage, calls: [...calls.values()] };
}

const ok = (b) => (b ? "✅" : "❌");

console.log("── 1) 流式文本 ──");
let r = await call({ model: MODEL, stream: true, messages: [{ role: "user", content: "只回复两个字：你好" }] });
console.log(`   ${ok(r.status===200 && r.content)} HTTP ${r.status} 正文=${JSON.stringify(r.content)} 思考=${r.reasoning.length}字 finish=${r.finish} usage=${JSON.stringify(r.usage)}`);

console.log("\n── 2) 非流式 ──");
r = await call({ model: MODEL, stream: false, messages: [{ role: "user", content: "只回复两个字：你好" }] });
console.log(`   ${ok(r.json?.choices?.[0]?.message?.content)} HTTP ${r.status} message=${JSON.stringify(r.json?.choices?.[0]?.message?.content)}`);

console.log("\n── 3) 流式工具调用 ──");
const tools = [{ type:"function", function:{ name:"get_weather", description:"查天气",
  parameters:{ type:"object", properties:{ city:{type:"string"} }, required:["city"] } } }];
r = await call({ model: MODEL, stream: true, tools,
  messages: [{ role:"user", content:"用工具查一下北京天气" }] });
const tc = r.calls[0];
console.log(`   ${ok(tc)} finish=${r.finish} 工具数=${r.calls.length} name=${tc?.name} args=${tc?.args} id=${tc?.id ? "有" : "无"}`);

console.log("\n── 4) 多轮往返（把工具结果喂回去）──");
let args = {}; try { args = JSON.parse(tc?.args || "{}"); } catch {}
r = await call({ model: MODEL, stream: true, tools, messages: [
  { role:"user", content:"用工具查一下北京天气" },
  { role:"assistant", content:null, tool_calls:[{ id: tc.id, type:"function",
      function:{ name: tc.name, arguments: tc.args } }] },
  { role:"tool", tool_call_id: tc.id, name: tc.name, content:"晴，25°C" },
]});
console.log(`   ${ok(r.status===200 && r.content)} 最终回答=${JSON.stringify(r.content.slice(0,80))} finish=${r.finish}`);

console.log("\n── 5) 错误处理（不存在的模型）──");
r = await call({ model: "no/such-model", stream: true, messages: [{ role:"user", content:"hi" }] });
console.log(`   ${ok(r.status!==200)} HTTP ${r.status} ${JSON.stringify(r.text||r.content).slice(0,120)}`);
