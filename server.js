/* ============================================================
 * 北化大富翁 · 联机中继服务器（零依赖，Node 12+ 直接运行）
 * ------------------------------------------------------------
 * 用途：让不同网络（不同WiFi/不同城市）的玩家能一起联机。
 *       所有游戏消息经本服务器转发，无需 PeerJS 公网信令，
 *       也不用打通 NAT，只要双方能访问到本服务器即可。
 *
 * 启动：  node server.js
 * 端口：  默认 8899（可用环境变量 PORT 覆盖）
 *
 * 三种部署方式：
 *  ① 局域网：直接在本机启动，同学连 ws://<你的局域网IP>:8899
 *  ② 内网穿透：cpolar / ngrok / frp 把 8899 映射到公网，
 *     同学连 ws://<公网域名>:<端口>（跨城市可用）
 *  ③ 云服务器：把本文件放上去 node server.js，连公网IP:8899
 *
 * 同时内置静态文件服务：浏览器访问 http://<IP>:8899/ 会列出目录，
 * 打开 北化大富翁-联机版.html 即可游玩。
 * ============================================================ */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8899;
const rooms = new Map();            // roomCode -> { players:[wsClient] }
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/* ---------- 极简 WebSocket（RFC6455，文本帧 + ping/pong） ---------- */
function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
}
function wsFrame(msg) {
  const p = Buffer.from(String(msg));
  const len = p.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, p]);
}

/* ---------- 房间逻辑 ---------- */
function sendTo(c, msg) { try { c.socket.write(wsFrame(typeof msg === "string" ? msg : JSON.stringify(msg))); } catch (e) {} }
function broadcast(roomCode, except, msg) {
  const room = rooms.get(roomCode);
  if (!room) return;
  room.players.forEach(p => { if (p !== except) sendTo(p, msg); });
}
function onMsg(c, m) {
  if (!m || typeof m !== "object") return;
  if (m.t === "join") {
    const code = String(m.room || "").toUpperCase().slice(0, 6);
    if (!/^[A-Z0-9]{6}$/.test(code)) { sendTo(c, { t: "err", msg: "房间码应为 6 位字母数字" }); return; }
    let room = rooms.get(code);
    if (!room) {
      if (m.role !== "host") { sendTo(c, { t: "err", msg: "房间不存在，请核对房间码" }); return; }
      room = { players: [] };
      rooms.set(code, room);
    }
    if (room.players.length >= 4) { sendTo(c, { t: "err", msg: "房间已满（最多 4 人）" }); return; }
    const name = String(m.name || "").slice(0, 6) || ("玩家" + (room.players.length + 1));
    c.room = code; c.idx = room.players.length; c.name = name; c.isHost = m.role === "host";
    room.players.push(c);
    sendTo(c, { t: "welcome", idx: c.idx, roomCode: code, players: room.players.map(p => ({ name: p.name })), isHost: c.isHost });
    broadcast(code, c, { t: "join", idx: c.idx, player: { name: name } });
    console.log(`[join] 房间 ${code} +${name}（${room.players.length}/4）`);
  } else if (m.t === "data") {
    if (!c.room) return;
    broadcast(c.room, c, { t: "data", from: c.idx, data: m.data });
  } else if (m.t === "ping") {
    sendTo(c, { t: "pong" });
  }
}
function leave(c) {
  if (!c.room) return;
  const code = c.room;
  const room = rooms.get(code);
  if (room) {
    room.players = room.players.filter(p => p !== c);
    broadcast(code, c, { t: "left", idx: c.idx, name: c.name });
    console.log(`[left] 房间 ${code} -${c.name}（${room.players.length}/4）`);
    if (room.players.length === 0) rooms.delete(code);
  }
  c.room = null;
}

/* ---------- 在线题库库（quiz-data.json，可随时扩充） ---------- */
const QUIZ_FILE = path.join(__dirname, "quiz-data.json");
let QUIZ_DATA = { subjects: [], quiz: {} };
try { QUIZ_DATA = JSON.parse(fs.readFileSync(QUIZ_FILE, "utf-8")); } catch (e) {}
function pickRandom(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

/* ---------- HTTP：静态文件（方便直接打开网页玩） ---------- */
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const qs = new URLSearchParams((req.url || "/").split("?")[1] || "");
  // CORS：允许任何来源（file:// 本地页也能拉取在线题库）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  // 在线题库 API
  if (urlPath === "/api/quiz") {
    const subj = (qs.get("subj") || "all").trim().toUpperCase();
    let n = parseInt(qs.get("n") || "10", 10);
    if (isNaN(n) || n < 1) n = 10; if (n > 30) n = 30;
    let pool = [];
    if (subj === "ALL") {
      Object.values(QUIZ_DATA.quiz).forEach(arr => { pool = pool.concat(arr); });
    } else if (QUIZ_DATA.quiz[subj]) {
      pool = QUIZ_DATA.quiz[subj];
    } else if (QUIZ_DATA.quiz[subj + "_Q"]) {
      pool = QUIZ_DATA.quiz[subj + "_Q"];
    }
    if (pool.length === 0) { res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "未找到题库 " + subj })); return; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ subj: subj, total: pool.length, n: n, quiz: pickRandom(pool, n) }));
    return;
  }
  if (urlPath === "/api/quiz/stats") {
    const total = Object.values(QUIZ_DATA.quiz).reduce((a, b) => a + b.length, 0);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ subjects: Object.keys(QUIZ_DATA.quiz), count: total }));
    return;
  }
  // 自动发现中继地址：从 cloudflared 隧道日志解析最新公网 URL（网页据此自动填地址）
  if (urlPath === "/api/relay/url") {
    let pubUrl = "";
    try {
      const logPath = path.join(__dirname, "cloudflare-tunnel", "tunnel.log");
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "";
      const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) pubUrl = m[0].replace(/^https:/, "wss:");
    } catch (e) {}
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ url: pubUrl || "" }));
    return;
  }
  let p = urlPath;
  if (p === "/") {
    const total = Object.values(QUIZ_DATA.quiz).reduce((a, b) => a + b.length, 0);
    const html = '<meta charset="utf-8"><title>北化大富翁 · 联机服务器</title><body style="font-family:sans-serif;background:#F6EFE0;padding:24px">'
      + "<h2>🎓 北化大富翁 · 联机中继服务器运行中</h2>"
      + "<p>在线题库：<b>" + Object.keys(QUIZ_DATA.quiz).length + " 个学科库，共 " + total + " 题</b>（把题目追加到 quiz-data.json 即可扩充）</p>"
      + "<p>网页文件列表：</p><ul>"
      + fs.readdirSync(__dirname).filter(f => /\.(html|js)$/.test(f)).map(f => `<li><a href="/${encodeURIComponent(f)}">${f}</a></li>`).join("")
      + "</ul><p>中继地址（填到游戏「中继联机」里）：<b>ws://" + (req.socket.localAddress === "::" ? "你的IP" : req.socket.localAddress) + ":" + PORT + "</b></p></body>";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  const fp = path.normalize(path.join(__dirname, p));
  if (!fp.startsWith(__dirname)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(fp).toLowerCase();
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

/* ---------- WebSocket 握手与帧解析 ---------- */
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n"
  );
  const client = { socket, room: null, idx: -1, name: "", isHost: false };
  let buf = Buffer.alloc(0);
  socket.on("data", chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) break;
      const b0 = buf[0], b1 = buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) break;
      if (len > 0) {
        const mask = buf.slice(off, off + 4);
        const payload = Buffer.from(buf.slice(off + 4, off + 4 + len));
        for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
        buf = buf.slice(off + 4 + len);
        if (opcode === 8) { try { socket.end(); } catch (e) {} break; }          // close
        if (opcode === 9) { try { socket.write(wsFrame("")); } catch (e) {} continue; } // ping -> pong
        if (opcode !== 1) continue;                                              // 仅文本帧
        try { onMsg(client, JSON.parse(payload.toString())); } catch (e) {}
      } else {
        buf = buf.slice(off);
        if (opcode === 8) { try { socket.end(); } catch (e) {} break; }
      }
    }
  });
  socket.on("close", () => leave(client));
  socket.on("error", () => {});
});

server.listen(PORT, () => {
  console.log("==============================================");
  console.log("北化大富翁 · 联机中继服务器已启动");
  console.log("  静态网页:  http://127.0.0.1:" + PORT);
  console.log("  中继地址:  ws://127.0.0.1:" + PORT + "（局域网请把 127.0.0.1 换成你的电脑 IP）");
  console.log("  跨网络:    配合内网穿透或云服务器，把 ws://公网地址:" + PORT + " 填进游戏「中继联机」");
  console.log("==============================================");
});
