const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "0.0.0.0";
const DEEPSEEK_BASE = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const SELLERSPRITE_SECRET_KEY = process.env.SELLERSPRITE_SECRET_KEY || "";
const SELLERSPRITE_MCP_URL = "https://mcp.sellersprite.com/mcp";
const PUBLIC_DIR = path.join(__dirname, "public-sellersprite");

const sessions = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const USER_GUIDE_MESSAGE = [
  "### SellerSprite MCP 使用手册",
  "",
  "直接输入自然语言即可，我会通过 DeepSeek 调用 SellerSprite 官方 MCP 工具。",
  "",
  "- **ASIN 分析**：输入站点和 ASIN，查询详情、趋势、销量预测、BSR 等。",
  "- **关键词研究**：查询搜索量、趋势、相关词、流量词、选品机会。",
  "- **商品/品牌调研**：输入品牌、类目或商品线索，查询可用工具返回的数据。",
  "- **图片 OCR**：上传或粘贴图片时，可让模型选择 OCR 相关工具识别文字。",
  "- **账户能力**：可询问当前 MCP 工具列表和调用方式。",
  "",
  "示例：`查 US 站 ASIN B0CXYZ1234 的竞品数据`、`帮我看关键词 coffee maker 的搜索量`、`识别这张图里的文字`。",
].join("\n");

class RemoteMcpClient {
  constructor() {
    this.initialized = false;
    this.cachedTools = null;
  }

  async request(method, params = {}) {
    if (!SELLERSPRITE_SECRET_KEY) throw new Error("请先设置环境变量 SELLERSPRITE_SECRET_KEY。");
    const payload = { jsonrpc: "2.0", id: randomUUID(), method, params };
    const response = await fetch(SELLERSPRITE_MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "secret-key": SELLERSPRITE_SECRET_KEY,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const data = parseMcpResponse(text);
    if (!response.ok) throw new Error(data?.error?.message || data?.message || `SellerSprite MCP 请求失败：${response.status}`);
    if (data?.error) throw new Error(data.error.message || "SellerSprite MCP 请求失败。");
    return data?.result ?? data;
  }

  async initialize() {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sellersprite-deepseek-chat", version: "0.2.0" },
    });
    this.initialized = true;
  }

  async listTools() {
    if (this.cachedTools) return this.cachedTools;
    await this.initialize();
    const result = await this.request("tools/list", {});
    this.cachedTools = Array.isArray(result.tools) ? result.tools : [];
    return this.cachedTools;
  }

  async callTool(name, args) {
    await this.initialize();
    return this.request("tools/call", { name, arguments: args || {} });
  }
}

const mcpClient = new RemoteMcpClient();

function parseMcpResponse(text) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return safeJsonParse(trimmed, {});

  for (const block of trimmed.split(/\n\n+/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const parsed = safeJsonParse(dataLines.join("\n"), null);
    if (parsed) return parsed;
  }
  return { message: trimmed };
}

function getSessionIdFromUrl(url) {
  return normalizeSessionId(url.searchParams.get("session"));
}

function getSessionIdFromPayload(payload) {
  return normalizeSessionId(payload?.sessionId || payload?.session);
}

function normalizeSessionId(value) {
  const cleaned = String(value || "default").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return cleaned || "default";
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      sseClients: new Set(),
    });
  }
  return sessions.get(sessionId);
}

function findSession(sessionId) {
  return sessions.get(normalizeSessionId(sessionId));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function safeJsonParse(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function createMessage(role, content, extras = {}) {
  return {
    id: extras.id || randomUUID(),
    role,
    content,
    attachments: extras.attachments || [],
    request: extras.request || null,
    raw: extras.raw || null,
    status: extras.status || "done",
    createdAt: extras.createdAt || new Date().toISOString(),
  };
}

function broadcast(session, event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of session.sseClients) client.write(data);
}

function addMessage(session, message) {
  session.messages.push(message);
  session.updatedAt = new Date().toISOString();
  broadcast(session, "message", message);
  return message;
}

function updateMessage(session, id, patch) {
  const message = session.messages.find((item) => item.id === id);
  if (!message) return null;
  Object.assign(message, patch);
  session.updatedAt = new Date().toISOString();
  broadcast(session, "message", message);
  return message;
}

function listSessions() {
  return Array.from(sessions.values())
    .map((session) => {
      const lastMessage =
        [...session.messages].reverse().find((message) => message.role === "user") ||
        [...session.messages].reverse().find((message) => message.role === "assistant");
      return {
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        title: session.title || session.id,
        lastMessage: lastMessage ? String(lastMessage.content || "").slice(0, 80) : "",
      };
    })
    .filter((session) => session.messageCount > 0)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function summarizeSessionTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled";
  return clean.length > 24 ? `${clean.slice(0, 24)}...` : clean;
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 6)
    .filter((item) => item?.dataUrl?.startsWith("data:image/"))
    .map((item) => ({
      id: randomUUID(),
      name: String(item.name || "image").slice(0, 120),
      type: String(item.type || "image/png").slice(0, 80),
      size: Number(item.size || 0),
      dataUrl: item.dataUrl,
    }))
    .filter((item) => item.dataUrl.length <= 8_000_000);
}

function sanitizeDeepSeekPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeDeepSeekPayload);
  if (!value || typeof value !== "object") return value;

  const sanitized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "reasoning_content") continue;
    sanitized[key] = sanitizeDeepSeekPayload(child);
  }
  return sanitized;
}

function recentChatForModel(session) {
  return session.messages
    .filter((message) => message.status === "done" && ["user", "assistant"].includes(message.role))
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.attachments?.length
        ? `${message.content || ""}\n\n[用户上传了 ${message.attachments.length} 张图片。图片内容可交给 SellerSprite OCR 相关工具处理，或根据工具参数要求补充。]`
        : message.content,
    }));
}

function toDeepSeekTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || tool.name,
      parameters: tool.inputSchema || { type: "object", properties: {}, additionalProperties: true },
    },
  };
}

function parseSellerSpriteToolPayload(result) {
  const text = result?.content?.find((item) => item?.type === "text")?.text;
  if (!text) return null;
  const parsed = safeJsonParse(text, null);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function getSellerSpriteToolError(result) {
  if (result?.isError) return { code: "MCP_TOOL_ERROR", message: "SellerSprite MCP 工具返回错误。" };
  const payload = parseSellerSpriteToolPayload(result);
  if (!payload) return null;
  const code = String(payload.code || "");
  const message = String(payload.message || "");
  if (code.startsWith("ERROR") || code.includes("UNAUTHORIZED") || message.includes("未授权")) {
    return { code: code || "SELLERSPRITE_ERROR", message: message || "SellerSprite MCP 工具返回错误。", data: payload.data ?? null };
  }
  return null;
}

function formatToolError(toolName, error) {
  if (error?.code === "ERROR_UNAUTHORIZED" || error?.message?.includes("未授权")) {
    return [
      "### SellerSprite MCP 授权异常",
      "",
      `工具 \`${toolName}\` 返回：\`${error.code || "ERROR"}\`，${error.message || "未授权"}。`,
      "",
      "这不是前端显示问题，也不是 DeepSeek 初始回复问题；是 SellerSprite MCP 在实际工具调用阶段拒绝了请求。",
      "",
      "请检查：",
      "- 当前 `SELLERSPRITE_SECRET_KEY` 是否仍有效。",
      "- 该密钥对应账号是否有调用这个工具/API 的权限。",
      "- SellerSprite 后台是否需要重新生成或绑定 MCP secret。",
      "",
      "我不会基于未授权结果编造实时市场数据。授权恢复后再发送同样的问题即可继续查询。",
    ].join("\n");
  }

  return [
    "### SellerSprite MCP 工具调用失败",
    "",
    `工具 \`${toolName}\` 返回：\`${error?.code || "ERROR"}\`，${error?.message || "未知错误"}。`,
    "",
    "请调整参数或稍后重试。",
  ].join("\n");
}

function shouldRequireSellerSpriteTool(text) {
  return /Amazon|亚马逊|ASIN|asin|关键词|产品|商品|类目|市场|选品|销量|销售额|BSR|竞品|品牌|评论|流量|趋势|抓取|查询|分析|US|UK|DE|JP|智能|家居/i.test(
    String(text || "")
  );
}

async function callDeepSeek(payload) {
  if (!DEEPSEEK_API_KEY) throw new Error("请先设置环境变量 DEEPSEEK_API_KEY。");

  const response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  const data = safeJsonParse(text, { error: { message: text } });
  if (!response.ok) throw new Error(data.error?.message || data.message || `DeepSeek 请求失败：${response.status}`);
  return data;
}

async function answerWithDeepSeek(session, userText) {
  const history = recentChatForModel(session);
  if (history.at(-1)?.role === "user" && history.at(-1)?.content === userText) history.pop();

  const tools = await mcpClient.listTools();
  const conversation = [
    {
      role: "system",
      content:
        "你是 SellerSprite Open API 的中文助手。用户询问 Amazon 选品、ASIN、关键词、品牌、类目、销量、BSR、流量、趋势、OCR 或账户工具能力时，必须优先调用 SellerSprite MCP 工具。不要编造工具返回中没有的数据；如果工具返回未授权、错误或空数据，必须明确说明真实错误，不要给出伪造的实时市场数据；如果你没有实际调用工具，不得声称 API 未授权、次数用尽、已查询到数据或工具异常，只能说明需要调用工具查询。缺少必填参数时先问用户补充。回复可以使用 Markdown。",
    },
    ...history,
    { role: "user", content: userText },
  ];
  const deepseekResponses = [];
  const toolResults = [];
  let firstRequest = null;
  const requireToolFirst = shouldRequireSellerSpriteTool(userText);

  for (let step = 0; step < 6; step += 1) {
    const response = await callDeepSeek({
      model: DEEPSEEK_MODEL,
      messages: conversation,
      tools: tools.map(toDeepSeekTool),
      tool_choice: "auto",
    });
    deepseekResponses.push(sanitizeDeepSeekPayload(response));

    const assistant = response.choices?.[0]?.message || {};
    conversation.push(assistant);
    const toolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (!toolCalls.length) {
      if (requireToolFirst && step === 0) {
        return {
          content: [
            "### 需要实际调用 SellerSprite MCP",
            "",
            "这个问题属于 Amazon/SellerSprite 数据查询，必须先调用 MCP 工具才能给出结果。",
            "",
            "本轮 DeepSeek 没有选择任何工具，因此我不会采纳它的直接回答，也不会编造授权、次数或市场数据。",
            "",
            "你可以补充更明确的查询条件后重试，例如：",
            "- 站点：US",
            "- ASIN、关键词或类目节点",
            "- 想查的维度：产品列表、类目结构、关键词、销量、竞品等",
          ].join("\n"),
          request: firstRequest,
          raw: { deepseek: deepseekResponses, toolResults },
        };
      }
      return { content: assistant.content || "我没有拿到有效回复。", request: firstRequest, raw: { deepseek: deepseekResponses, toolResults } };
    }

    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name;
      const args = safeJsonParse(toolCall.function?.arguments, {});
      const result = await mcpClient.callTool(name, args);
      const toolError = getSellerSpriteToolError(result);
      const wrapped = {
        ok: !toolError,
        status: toolError ? 400 : 200,
        request: { method: "MCP", apiPath: name },
        error: toolError,
        data: result,
      };
      if (!firstRequest) firstRequest = wrapped.request;
      toolResults.push({ toolCall, args, result: wrapped });
      if (toolError) {
        return { content: formatToolError(name, toolError), request: firstRequest, raw: { deepseek: deepseekResponses, toolResults } };
      }
      conversation.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(wrapped) });
    }
  }

  return { content: "工具连续调用次数过多，已停止。请缩小问题范围后再试。", request: firstRequest, raw: { deepseek: deepseekResponses, toolResults } };
}

async function handleAsk(req, res) {
  let session;
  let assistantMessage;
  try {
    const raw = await readBody(req);
    const payload = raw ? JSON.parse(raw) : {};
    const sessionId = getSessionIdFromPayload(payload);
    session = getSession(sessionId);
    const text = String(payload.message || "").trim();
    const attachments = normalizeAttachments(payload.attachments);
    if (!text && !attachments.length) {
      sendJson(res, 400, { ok: false, data: { code: "EMPTY_MESSAGE", message: "请输入消息。" } });
      return;
    }

    const userMessage = addMessage(session, createMessage("user", text, { attachments }));
    if (!session.title) session.title = summarizeSessionTitle(userMessage.content || userMessage.attachments?.[0]?.name || "Image");
    assistantMessage = addMessage(session, createMessage("assistant", "正在通过 DeepSeek 和 SellerSprite MCP 处理...", { status: "pending" }));
    sendJson(res, 202, { ok: true, message: assistantMessage });

    try {
      const modelText = attachments.length
        ? `${text || "用户发送了图片。"}\n\n用户上传了图片。如需识别图片文字，请优先考虑调用 SellerSprite OCR 相关工具。`
        : text;
      const answer = await answerWithDeepSeek(session, modelText);
      updateMessage(session, assistantMessage.id, { content: answer.content, request: answer.request, raw: answer.raw, status: "done" });
    } catch (error) {
      updateMessage(session, assistantMessage.id, { content: error.message || "请求失败。", raw: { error: error.stack || String(error) }, status: "error" });
    }
  } catch (error) {
    if (session && assistantMessage) {
      updateMessage(session, assistantMessage.id, { content: error.message || "请求解析失败。", raw: { error: error.stack || String(error) }, status: "error" });
      return;
    }
    sendJson(res, 400, { ok: false, data: { code: "BAD_REQUEST", message: error.message || "请求解析失败。" } });
  }
}

function handleClearMessages(res, session) {
  if (!session) {
    sendJson(res, 200, { ok: true });
    return;
  }
  session.messages.splice(0);
  session.updatedAt = new Date().toISOString();
  broadcast(session, "clear", { ok: true });
  sendJson(res, 200, { ok: true });
}

function handleDeleteSession(res, sessionId) {
  const session = findSession(sessionId);
  if (session) {
    broadcast(session, "deleted", { ok: true, sessionId });
    for (const client of session.sseClients) client.end();
    sessions.delete(normalizeSessionId(sessionId));
  }
  sendJson(res, 200, { ok: true });
}

async function handleMcp(req, res) {
  const raw = await readBody(req);
  const payload = raw ? JSON.parse(raw) : {};
  if (payload.method === "initialize") {
    await mcpClient.initialize();
    sendJson(res, 200, { jsonrpc: "2.0", id: payload.id ?? null, result: { serverInfo: { name: "sellersprite-mcp-bridge", version: "0.2.0" }, capabilities: { tools: {} } } });
    return;
  }
  if (payload.method === "tools/list") {
    sendJson(res, 200, { jsonrpc: "2.0", id: payload.id ?? null, result: { tools: await mcpClient.listTools() } });
    return;
  }
  if (payload.method === "tools/call") {
    const result = await mcpClient.callTool(payload.params?.name, payload.params?.arguments || {});
    sendJson(res, 200, { jsonrpc: "2.0", id: payload.id ?? null, result });
    return;
  }
  sendJson(res, 200, { jsonrpc: "2.0", id: payload.id ?? null, error: { code: -32601, message: `Method not found: ${payload.method}` } });
}

function handleEvents(req, res, session) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  if (!session) return;
  session.sseClients.add(res);
  req.on("close", () => session.sseClients.delete(res));
}

async function handleStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    const headers = { "content-type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream" };
    if (path.extname(filePath) === ".html") headers["cache-control"] = "no-store";
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function lanUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${PORT}`);
    }
  }
  return urls;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/api/ask") return handleAsk(req, res);
  if (req.method === "GET" && url.pathname === "/api/sessions") return sendJson(res, 200, { ok: true, sessions: listSessions() });
  const sessionId = getSessionIdFromUrl(url);
  const existingSession = findSession(sessionId);
  if (req.method === "GET" && url.pathname === "/api/messages") return sendJson(res, 200, { ok: true, messages: existingSession?.messages || [] });
  if (req.method === "GET" && url.pathname === "/api/guide") {
    return sendJson(res, 200, { ok: true, guide: createMessage("assistant", USER_GUIDE_MESSAGE, { id: "guide", status: "done" }) });
  }
  if (req.method === "GET" && url.pathname === "/api/events") return handleEvents(req, res, existingSession);
  if (req.method === "POST" && url.pathname === "/api/messages/clear") return handleClearMessages(res, existingSession);
  if (req.method === "DELETE" && url.pathname === "/api/session") return handleDeleteSession(res, sessionId);
  if (req.method === "POST" && url.pathname === "/mcp") {
    return handleMcp(req, res).catch((error) => sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message || "MCP server error" } }));
  }
  if (req.method === "GET") return handleStatic(req, res);
  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`SellerSprite MCP + DeepSeek chat running at http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`LAN: ${url}`);
});
