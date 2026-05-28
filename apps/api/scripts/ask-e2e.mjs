// E2E for /search/ask (RAG, SSE). Sends a question, reads the event stream, and asserts we get
// token events that accumulate an answer, then a sources event (ContentSearchResult[]), then done.
// Run from server/ with the server booted on :4000 and ANTHROPIC_API_KEY + VOYAGE_API_KEY set.
const P = "11111111-1111-1111-1111-111111111111";
const url = `http://localhost:4000/v7/${P}/search/ask`;
const fail = (m) => { console.error("❌ FAIL:", m); process.exit(1); };

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "text/event-stream" },
  body: JSON.stringify({ query: "What ramen recipe is shared here, and what's in it?", limit: 5 }),
});
if (!res.ok) fail(`HTTP ${res.status}: ${await res.text()}`);
if (!res.body) fail("no response body");

// Minimal SSE parser: split on blank lines, read event:/data: pairs.
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
let answer = "";
let sources = null;
let done = false;
const events = [];

outer: while (true) {
  const { done: rdone, value } = await reader.read();
  if (rdone) break;
  buffer += decoder.decode(value, { stream: true });
  let sep;
  while ((sep = buffer.indexOf("\n\n")) !== -1) {
    const block = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    events.push(event);
    if (event === "token") answer += JSON.parse(data).content ?? "";
    else if (event === "sources") sources = JSON.parse(data);
    else if (event === "error") fail("stream error event: " + data);
    else if (event === "done") { done = true; break outer; }
  }
}

console.log("→ events seen:", [...new Set(events)].join(", "));
console.log("→ answer:", answer);
console.log("→ sources:", (sources ?? []).map((s) => `${s.sourceType}(${s.similarity?.toFixed?.(2)}): ${s.record?.title ?? s.record?.id}`).join(" | "));

if (!events.includes("token")) fail("no token events");
if (!answer.trim()) fail("empty answer");
if (!Array.isArray(sources)) fail("no sources event / not an array");
if (!sources.length) fail("sources array empty (retrieval found nothing)");
if (sources[0].sourceType !== "entity" || typeof sources[0].similarity !== "number" || !sources[0].record?.id) {
  fail("source not shaped as ContentSearchResult: " + JSON.stringify(sources[0]));
}
if (!done) fail("no done event");

console.log("\n🎉 /search/ask SSE E2E passed");
process.exit(0);
