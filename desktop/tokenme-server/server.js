"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const UPSTREAM = "https://api.tokenme.limited/api/v1/audio/speech";
const UPSTREAM_CHAT = "https://api.tokenme.limited/api/v1/chat/completions";

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function forwardToTokenMe(auth, payloadBuf, upstreamUrl, accept) {
  return new Promise((resolve, reject) => {
    const u = new URL(upstreamUrl || UPSTREAM);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/json",
          Accept: accept || "audio/mpeg, application/json, */*",
          "Content-Length": payloadBuf.length,
          "User-Agent": "TwitchChatTTS-Electron/1.0",
        },
        timeout: 60000,
      },
      (resp) => {
        const chunks = [];
        resp.on("data", (c) => chunks.push(c));
        resp.on("end", () => {
          resolve({
            status: resp.statusCode || 502,
            contentType: resp.headers["content-type"] || "application/octet-stream",
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("upstream timeout"));
    });
    req.write(payloadBuf);
    req.end();
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${HOST}`);
    const pathName = url.pathname.replace(/\/$/, "") || "/";

    try {
      if (req.method === "GET" && pathName === "/health") {
        sendJson(res, 200, { ok: true, version: "tokenme-electron/1.0", embedded: true, upstream: UPSTREAM });
        return;
      }

      if (req.method === "POST" && (pathName === "/tts" || pathName === "/v1/audio/speech")) {
        const auth = req.headers.authorization || "";
        if (!auth.toLowerCase().startsWith("bearer ")) {
          sendJson(res, 401, { error: "missing Authorization: Bearer <key>" });
          return;
        }
        const raw = await readBody(req);
        let data = {};
        try { data = JSON.parse(raw.toString("utf8") || "{}"); } catch (_) {}
        const payload = {
          model: data.model || "paxa/paxa-tts-flash-v2",
          input: String(data.input || data.text || "").slice(0, 800),
          voice: data.voice || "mocha",
          response_format: data.response_format || "mp3",
        };
        if (!payload.input) {
          sendJson(res, 400, { error: "missing input" });
          return;
        }
        const upstream = await forwardToTokenMe(auth, Buffer.from(JSON.stringify(payload), "utf8"));
        res.writeHead(upstream.status, {
          "Content-Type": upstream.contentType,
          "Content-Length": upstream.body.length,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(upstream.body);
        return;
      }

      if (req.method === "POST" && (pathName === "/chat" || pathName === "/v1/chat/completions")) {
        const auth = req.headers.authorization || "";
        if (!auth.toLowerCase().startsWith("bearer ")) {
          sendJson(res, 401, { error: "missing Authorization: Bearer <key>" });
          return;
        }
        const raw = await readBody(req);
        let data = null;
        try { data = JSON.parse(raw.toString("utf8") || "{}"); } catch (_) {}
        if (!data || !Array.isArray(data.messages) || !data.model) {
          sendJson(res, 400, { error: "missing model/messages" });
          return;
        }
        const upstream = await forwardToTokenMe(auth, Buffer.from(JSON.stringify(data), "utf8"), UPSTREAM_CHAT, "application/json");
        res.writeHead(upstream.status, {
          "Content-Type": upstream.contentType,
          "Content-Length": upstream.body.length,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(upstream.body);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[tokenme-proxy]", err && err.message);
      sendJson(res, 502, { error: (err && err.message) || String(err) });
    }
  });
}

function listen(preferredPort = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const tryPort = (port, left) => {
      const onError = (err) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && left > 0) tryPort(port + 1, left - 1);
        else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const addr = server.address();
        resolve({ server, port: addr.port, url: `http://${HOST}:${addr.port}` });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, HOST);
    };
    tryPort(preferredPort, 20);
  });
}

module.exports = { listen, DEFAULT_PORT, HOST };
