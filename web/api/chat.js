// Serverless proxy for the EchoHealth AI assistant.
// The Gemini API key NEVER reaches the browser — it lives only in the
// GEMINI_API_KEY environment variable on the server (set it in Vercel).
//
// Request body (JSON):
//   { summary: string, question: string, history: [{role, text}], lang: "en"|"zh" }
// Response (JSON):
//   { reply: string }   or   { error: string }

const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const MAX_QUESTION = 1000;     // chars
const MAX_SUMMARY = 4000;      // chars
const MAX_HISTORY = 8;         // turns kept
const RATE_MAX = 20;           // requests per IP per window
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Best-effort in-memory rate limiter (per serverless instance).
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_MAX;
}

function sys(lang) {
  if (lang === "zh") {
    return "你是 EchoHealth 的健康数据助手。你只能看到用户 Apple 健康数据的汇总统计（不是原始记录）。" +
      "请根据这些统计，用简洁、友好、易懂的中文回答用户的问题，给出解读、趋势和可行的生活方式建议。" +
      "你不是医生，不能进行诊断；如涉及医疗问题，请提醒用户咨询专业医生。" +
      "如果某项数据不在汇总中，请如实说明你看不到该数据。回答尽量简短，使用要点。";
  }
  return "You are EchoHealth's health-data assistant. You can only see SUMMARY statistics of the user's " +
    "Apple Health data (not raw records). Using those statistics, answer the user's question in clear, " +
    "friendly, concise language: interpret the numbers, point out trends, and offer practical lifestyle " +
    "suggestions. You are NOT a doctor and must not diagnose; for medical concerns, advise consulting a " +
    "healthcare professional. If something isn't in the summary, say you can't see that data. Keep answers " +
    "short and use bullet points where helpful.";
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed." }));
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "Server is missing GEMINI_API_KEY." }));
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) {
    res.statusCode = 429;
    return res.end(JSON.stringify({ error: "Too many requests. Please try again later." }));
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const lang = body.lang === "zh" ? "zh" : "en";
  const question = String(body.question || "").slice(0, MAX_QUESTION).trim();
  const summary = String(body.summary || "").slice(0, MAX_SUMMARY);
  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];

  if (!question) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "Empty question." }));
  }

  // Build Gemini "contents". First user turn carries the data summary.
  const contents = [];
  contents.push({
    role: "user",
    parts: [{ text: "Here is the summary of my Apple Health data:\n\n" + summary }],
  });
  contents.push({
    role: "model",
    parts: [{ text: lang === "zh" ? "好的，我已了解你的健康数据汇总。请问有什么想了解的？" : "Got it — I've reviewed your health summary. What would you like to know?" }],
  });
  for (const m of history) {
    const role = m && m.role === "model" ? "model" : "user";
    const text = String((m && m.text) || "").slice(0, MAX_QUESTION);
    if (text) contents.push({ role, parts: [{ text }] });
  }
  contents.push({ role: "user", parts: [{ text: question }] });

  // Stream the reply token-by-token from Gemini and re-emit it to the browser
  // as Server-Sent Events: `data: {"delta": "..."}` frames, then a final
  // `data: {"done": true}`. On an upstream failure we fall back to a plain JSON
  // error body (the client detects the content-type and handles both).
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(MODEL) + ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(key);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys(lang) }] },
        contents,
        generationConfig: { temperature: 0.6, maxOutputTokens: 800 },
      }),
    });

    if (!r.ok || !r.body) {
      const detail = await r.text().catch(() => "");
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "Upstream error.", status: r.status, detail: detail.slice(0, 500) }));
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const reader = r.body.getReader();
    const dec = new TextDecoder("utf-8");
    let buf = "", sent = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line || line[0] === ":" || line.slice(0, 5) !== "data:") continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const parts = (((obj.candidates || [])[0] || {}).content || {}).parts || [];
          let text = "";
          for (const p of parts) text += p.text || "";
          if (text) { sent = true; res.write("data: " + JSON.stringify({ delta: text }) + "\n\n"); }
        } catch (e) { /* ignore partial/non-JSON keep-alive lines */ }
      }
    }
    if (!sent) res.write("data: " + JSON.stringify({ error: "No response generated." }) + "\n\n");
    res.write("data: " + JSON.stringify({ done: true }) + "\n\n");
    return res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write("data: " + JSON.stringify({ error: "Request failed." }) + "\n\n");
      return res.end();
    }
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "Request failed.", detail: String(err).slice(0, 300) }));
  }
};
