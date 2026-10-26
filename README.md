# 北化大富翁 · 云端部署（Render / Zeabur / 任意 PaaS）

## 文件
- server.js              —— 中继 + 在线题库 + 静态页面（零依赖）
- quiz-data.json         —— 在线题库（28 库 541 题）
- 北化大富翁-联机版.html   —— 游戏网页（通过服务器访问 http://域名/北化大富翁-联机版.html）
- package.json           —— npm start = node server.js

## 端口
server.js 默认 8899，平台注入环境变量 PORT 时自动使用（Render/Zeabur 会自动设置 PORT）。

## 部署后
1. 网页地址：https://你的域名/北化大富翁-联机版.html
2. 中继地址：wss://你的域名
3. 在线题库：https://你的域名/api/quiz/stats
4. 把网页里的默认中继地址改成 wss://你的域名（搜 wss://poet-supplement-trans-bin.trycloudflare.com 替换）

## 注意
- 免费实例无流量会休眠（Render 15 分钟），游戏进行中有 WebSocket 消息不会休眠；
  休眠后下一个人访问约等 1 分钟唤醒。
- WebSocket 原生支持，无需额外配置。
