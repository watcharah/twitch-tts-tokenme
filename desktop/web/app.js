/* Twitch Chat → TTS (TokenMe API + optional Web Speech fallback)
 * Anonymous IRC over wss://irc-ws.chat.twitch.tv:443
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    channel: $("channel"),
    btnConnect: $("btnConnect"),
    btnDisconnect: $("btnDisconnect"),
    status: $("status"),
    ttsProvider: $("ttsProvider"),
    tokenmeBox: $("tokenmeBox"),
    webspeechBox: $("webspeechBox"),
    apiKey: $("apiKey"),
    tmModel: $("tmModel"),
    tmVoice: $("tmVoice"),
    proxyUrl: $("proxyUrl"),
    btnTestProxy: $("btnTestProxy"),
    proxyStatus: $("proxyStatus"),
    voiceSelect: $("voiceSelect"),
    rate: $("rate"),
    pitch: $("pitch"),
    volume: $("volume"),
    rateVal: $("rateVal"),
    pitchVal: $("pitchVal"),
    volumeVal: $("volumeVal"),
    rateField: $("rateField"),
    pitchField: $("pitchField"),
    btnTestVoice: $("btnTestVoice"),
    btnRefreshVoices: $("btnRefreshVoices"),
    btnPause: $("btnPause"),
    btnResume: $("btnResume"),
    btnSkip: $("btnSkip"),
    btnClear: $("btnClear"),
    nowSpeaking: $("nowSpeaking"),
    queueCount: $("queueCount"),
    queueList: $("queueList"),
    optSayName: $("optSayName"),
    optSkipCommands: $("optSkipCommands"),
    optSkipBots: $("optSkipBots"),
    optSkipEmotes: $("optSkipEmotes"),
    optSkipRedeems: $("optSkipRedeems"),
    maxQueue: $("maxQueue"),
    ignoreList: $("ignoreList"),
    maxLen: $("maxLen"),
    chatLog: $("chatLog"),
  };

  const KNOWN_BOTS = new Set([
    "nightbot", "streamelements", "moobot", "fossabot", "streamelement",
    "wizebot", "streamlabs", "pretzellebot", "sery_bot", "soundalerts",
    "commanderroot", "amazefulbot", "kofistreambot",
  ]);

  const TOKENME_DIRECT = "https://api.tokenme.limited/api/v1/audio/speech";

  let ws = null;
  let connectedChannel = null;
  let intentionallyClosed = false;
  let reconnectTimer = null;

  const queue = [];
  let speaking = false;
  let paused = false;
  let currentUtterance = null;
  let currentAudio = null;
  let currentItem = null;
  let msgSeq = 0;
  let preferDirectTokenMe = false; // set true if CORS allows direct calls

  function setStatus(state, text) {
    el.status.dataset.state = state;
    el.status.className = "status " + state;
    el.status.textContent = text;
  }

  function hasThai(s) {
    return /[\u0E00-\u0E7F]/.test(s);
  }

  function detectLang(s) {
    return hasThai(s) ? "th" : "en";
  }

  function nowTime() {
    return new Date().toLocaleTimeString("th-TH", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  function parseIgnoreList() {
    return new Set(
      el.ignoreList.value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
  }

  function sanitizeChatText(text) {
    return text.replace(/[\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
  }

  function clampText(text) {
    const max = Math.max(20, Number(el.maxLen.value) || 200);
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function saveSettings() {
    const data = {
      channel: el.channel.value,
      provider: el.ttsProvider.value,
      apiKey: el.apiKey.value,
      tmModel: el.tmModel.value,
      tmVoice: el.tmVoice.value,
      proxyUrl: el.proxyUrl.value,
      voice: el.voiceSelect.value,
      rate: el.rate.value,
      pitch: el.pitch.value,
      volume: el.volume.value,
      sayName: el.optSayName.checked,
      skipCommands: el.optSkipCommands.checked,
      skipBots: el.optSkipBots.checked,
      skipEmotes: el.optSkipEmotes.checked,
      skipRedeems: el.optSkipRedeems.checked,
      maxQueue: el.maxQueue.value,
      ignoreList: el.ignoreList.value,
      maxLen: el.maxLen.value,
    };
    try { localStorage.setItem("twitch-tts-settings", JSON.stringify(data)); } catch (_) {}
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem("twitch-tts-settings");
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.channel) el.channel.value = d.channel;
      if (d.provider) el.ttsProvider.value = d.provider;
      if (typeof d.apiKey === "string") el.apiKey.value = d.apiKey;
      if (d.tmModel) el.tmModel.value = d.tmModel;
      if (d.tmVoice) {
        const v = String(d.tmVoice);
        el.tmVoice.value = v;
        if (el.tmVoice.value !== v) {
          const opt = document.createElement("option");
          opt.value = v; opt.textContent = v + " (กำหนดเอง)";
          el.tmVoice.appendChild(opt);
          el.tmVoice.value = v;
        }
      }
      if (d.proxyUrl) el.proxyUrl.value = d.proxyUrl;
      if (d.rate) el.rate.value = d.rate;
      if (d.pitch) el.pitch.value = d.pitch;
      if (d.volume) el.volume.value = d.volume;
      if (typeof d.sayName === "boolean") el.optSayName.checked = d.sayName;
      if (typeof d.skipCommands === "boolean") el.optSkipCommands.checked = d.skipCommands;
      if (typeof d.skipBots === "boolean") el.optSkipBots.checked = d.skipBots;
      if (typeof d.skipEmotes === "boolean") el.optSkipEmotes.checked = d.skipEmotes;
      if (typeof d.skipRedeems === "boolean") el.optSkipRedeems.checked = d.skipRedeems;
      if (d.maxQueue) el.maxQueue.value = d.maxQueue;
      if (d.ignoreList) el.ignoreList.value = d.ignoreList;
      if (d.maxLen) el.maxLen.value = d.maxLen;
      el.voiceSelect.dataset.pending = d.voice || "";
    } catch (_) {}
  }

  function updateSliderLabels() {
    el.rateVal.textContent = Number(el.rate.value).toFixed(2);
    el.pitchVal.textContent = Number(el.pitch.value).toFixed(2);
    el.volumeVal.textContent = Number(el.volume.value).toFixed(2);
  }

  function setNowSpeaking(user, text) {
    const root = el.nowSpeaking;
    if (!root) return;
    let userEl = root.querySelector(".now-user");
    let textEl = root.querySelector(".now-text");
    if (!userEl || !textEl) {
      root.innerHTML =
        '<span class="now-avatar" aria-hidden="true">🎙️</span>' +
        '<span class="now-meta"><strong class="now-user"></strong><span class="now-text"></span></span>';
      userEl = root.querySelector(".now-user");
      textEl = root.querySelector(".now-text");
    }
    const idle = !user && (!text || text === "—" || text === "พักอยู่");
    const paused = text === "พักอยู่";
    root.classList.toggle("idle", idle || paused);
    if (paused) {
      userEl.textContent = "";
      textEl.textContent = "พักอยู่";
      return;
    }
    if (idle) {
      userEl.textContent = "";
      textEl.textContent = "—";
      return;
    }
    userEl.textContent = user || "";
    textEl.textContent = text || "";
  }

  function addChatLine(user, text, flags) {
    flags = flags || {};
    const line = document.createElement("div");
    line.className = "chat-line" + (flags.skipped ? " skipped" : "") + (flags.queued ? " queued" : "");
    const canReplay = !!(flags.queued && flags.speakText);
    line.innerHTML =
      `<span class="t">${nowTime()}</span>` +
      `<span class="u" style="color:${flags.color || "var(--accent)"}">${escapeHtml(user)}</span>` +
      `<span class="m">${escapeHtml(text)}</span>` +
      (canReplay
        ? `<button type="button" class="chat-rerun" title="อ่านเสียง" aria-label="อ่านเสียง">🔊</button>`
        : "");
    if (canReplay) {
      line.dataset.speakText = flags.speakText;
      line.dataset.user = user;
      line.dataset.displayText = text;
    }
    el.chatLog.appendChild(line);
    while (el.chatLog.children.length > 200) el.chatLog.removeChild(el.chatLog.firstChild);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  /** Insert a past chat line as the first queue item and speak ASAP. */
  function rerunChatLine(user, displayText, speakBase) {
    const base = String(speakBase || "").trim();
    if (!base) return;
    const lang = detectLang(base);
    let speakText = clampText(base);
    if (el.optSayName.checked) {
      speakText = lang === "th" ? `${user} บอกว่า ${speakText}` : `${user} says ${speakText}`;
    }
    const item = {
      id: ++msgSeq,
      user,
      text: displayText || base,
      speakText,
      lang,
      time: nowTime(),
    };
    const maxQ = Math.max(1, Number(el.maxQueue.value) || 20);
    if (queue.length >= maxQ) queue.pop();
    // Interrupt current utterance so this becomes the next (first) thing spoken.
    if (speaking) {
      stopCurrentSpeech();
      speaking = false;
      currentItem = null;
    }
    queue.unshift(item);
    renderQueue();
    if (!paused) processQueue();
  }

  function renderQueue() {
    el.queueCount.textContent = String(queue.length);
    el.queueList.innerHTML = "";
    if (!queue.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "คิวว่าง";
      el.queueList.appendChild(li);
      return;
    }
    for (const item of queue.slice(0, 30)) {
      const li = document.createElement("li");
      const time = item.time || "";
      li.innerHTML =
        `<span class="q-avatar" aria-hidden="true">👤</span>` +
        `<span class="q-main">` +
          `<span class="q-user">${escapeHtml(item.user)}</span>` +
          `<span class="q-msg">${escapeHtml(item.text)}</span>` +
        `</span>` +
        `<span class="q-time">${escapeHtml(time)}</span>`;
      el.queueList.appendChild(li);
    }
  }

  function scoreVoice(v) {
    const name = (v.name || "").toLowerCase();
    const lang = (v.lang || "").toLowerCase();
    let score = 0;
    if (lang.startsWith("th")) score += 100;
    if (name.includes("thai") || name.includes("premwadee")) score += 40;
    if (name.includes("google")) score += 20;
    if (lang.startsWith("en")) score += 5;
    return score;
  }

  function populateWebSpeechVoices() {
    const voices = speechSynthesis.getVoices() || [];
    const sorted = voices.slice().sort((a, b) => scoreVoice(b) - scoreVoice(a));
    const prev = el.voiceSelect.dataset.pending || el.voiceSelect.value;
    el.voiceSelect.innerHTML = "";
    if (!sorted.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "(ยังไม่พบเสียง — ลองรีเฟรช หรือใช้ Chrome)";
      el.voiceSelect.appendChild(opt);
      return;
    }
    for (const v of sorted) {
      const opt = document.createElement("option");
      opt.value = v.name;
      const tag = (v.lang || "").startsWith("th") ? "🇹🇭 " : (v.lang || "").startsWith("en") ? "🇬🇧 " : "";
      opt.textContent = `${tag}${v.name} (${v.lang})`;
      el.voiceSelect.appendChild(opt);
    }
    if (prev && [...el.voiceSelect.options].some((o) => o.value === prev)) {
      el.voiceSelect.value = prev;
    } else {
      const th = sorted.find((v) => (v.lang || "").toLowerCase().startsWith("th"));
      if (th) el.voiceSelect.value = th.name;
    }
    el.voiceSelect.dataset.pending = "";
  }

  function onProviderChange() {
    const isTm = el.ttsProvider.value === "tokenme";
    el.tokenmeBox.classList.toggle("hidden", !isTm);
    el.webspeechBox.classList.toggle("hidden", isTm);
    el.rate.disabled = isTm;
    el.pitch.disabled = isTm;
    if (el.rateField) el.rateField.style.opacity = isTm ? "0.4" : "1";
    if (el.pitchField) el.pitchField.style.opacity = isTm ? "0.4" : "1";
    if (!isTm) populateWebSpeechVoices();
    saveSettings();
  }

  function getApiKey() {
    return (el.apiKey.value || "").trim();
  }

  function buildSpeechBody(text) {
    return {
      model: (el.tmModel.value || "paxa/paxa-tts-flash-v2").trim(),
      input: text,
      voice: (el.tmVoice.value || "mocha").trim(),
      response_format: "mp3",
    };
  }

  async function fetchTokenMeMp3(text) {
    const key = getApiKey();
    if (!key) throw new Error("ยังไม่ได้ใส่ TokenMe API Key");

    const body = JSON.stringify(buildSpeechBody(text));
    const headers = {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Accept: "audio/mpeg, application/json, */*",
    };

    async function post(url) {
      const res = await fetch(url, { method: "POST", headers, body });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error("HTTP " + res.status + " " + errText.slice(0, 160));
      }
      return await res.blob();
    }

    // Prefer local proxy (CORS-safe). Fall back to direct if proxy down and CORS allows.
    const proxyBase = (el.proxyUrl.value || "").replace(/\/$/, "");
    if (proxyBase) {
      try {
        return await post(proxyBase + "/tts");
      } catch (proxyErr) {
        if (!preferDirectTokenMe) {
          // try direct once
          try {
            const blob = await post(TOKENME_DIRECT);
            preferDirectTokenMe = true;
            return blob;
          } catch (directErr) {
            throw new Error(
              "proxy: " + (proxyErr && proxyErr.message) +
              " | direct: " + (directErr && directErr.message) +
              " — รัน python3 proxy/tokenme_proxy.py หรือตรวจ API key"
            );
          }
        }
        throw proxyErr;
      }
    }
    return await post(TOKENME_DIRECT);
  }

  function playBlob(blob) {
    const volume = Number(el.volume.value) || 1;
    const objectUrl = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const audio = new Audio(objectUrl);
      audio.volume = Math.min(1, Math.max(0, volume));
      currentAudio = audio;
      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        currentAudio = null;
      };
      audio.onended = () => { cleanup(); resolve(); };
      audio.onerror = () => { cleanup(); reject(new Error("เล่นเสียงไม่สำเร็จ")); };
      audio.play().catch((e) => { cleanup(); reject(e); });
    });
  }

  async function speakTokenMe(text) {
    const blob = await fetchTokenMeMp3(text);
    await playBlob(blob);
  }

  function pickWebSpeechVoice(preferredName, lang) {
    const voices = speechSynthesis.getVoices() || [];
    if (preferredName) {
      const exact = voices.find((v) => v.name === preferredName);
      if (exact) return exact;
    }
    if (lang === "th") {
      const th = voices.find((v) => (v.lang || "").toLowerCase().startsWith("th"));
      if (th) return th;
    }
    return voices.find((v) => (v.lang || "").toLowerCase().startsWith("en")) || voices[0] || null;
  }

  function speakWebSpeech(text, lang) {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        reject(new Error("เบราว์เซอร์ไม่รองรับ speechSynthesis"));
        return;
      }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = Number(el.rate.value) || 1;
      u.pitch = Number(el.pitch.value) || 1;
      u.volume = Number(el.volume.value) || 1;
      const voice = pickWebSpeechVoice(el.voiceSelect.value, lang);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang || (lang === "th" ? "th-TH" : "en-US");
      } else {
        u.lang = lang === "th" ? "th-TH" : "en-US";
      }
      currentUtterance = u;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        currentUtterance = null;
        if (err) reject(err);
        else resolve();
      };
      u.onend = () => done(null);
      u.onerror = (e) => {
        const t = e && e.error;
        if (t === "interrupted" || t === "canceled") done(null);
        else done(new Error(t || "speech error"));
      };
      speechSynthesis.speak(u);
    });
  }

  function stopCurrentSpeech() {
    try { speechSynthesis.cancel(); } catch (_) {}
    currentUtterance = null;
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.src = ""; } catch (_) {}
      currentAudio = null;
    }
  }

  async function processQueue() {
    if (speaking || paused) return;
    if (!queue.length) {
      setNowSpeaking("", "—");
      renderQueue();
      return;
    }
    speaking = true;
    const item = queue.shift();
    currentItem = item;
    renderQueue();
    setNowSpeaking(item.user, item.text);
    try {
      if (el.ttsProvider.value === "tokenme") {
        await speakTokenMe(item.speakText);
      } else {
        await speakWebSpeech(item.speakText, item.lang);
      }
    } catch (err) {
      console.warn("TTS error:", err);
      addChatLine("ระบบ", "TTS error: " + (err && err.message ? err.message : String(err)), {
        skipped: true, color: "#f31260",
      });
    } finally {
      speaking = false;
      currentItem = null;
      setNowSpeaking("", "—");
      processQueue();
    }
  }

  function enqueue(user, text) {
    const maxQ = Math.max(1, Number(el.maxQueue.value) || 20);
    if (queue.length >= maxQ) queue.shift();
    const lang = detectLang(text);
    let speakText = clampText(text);
    if (el.optSayName.checked) {
      speakText = lang === "th" ? `${user} บอกว่า ${speakText}` : `${user} says ${speakText}`;
    }
    queue.push({ id: ++msgSeq, user, text, speakText, lang, time: nowTime() });
    renderQueue();
    processQueue();
  }

  function textWithoutTwitchEmotes(text, emotesTag) {
    if (!emotesTag) return text;
    const ranges = [];
    for (const part of emotesTag.split("/")) {
      if (!part) continue;
      const colon = part.indexOf(":");
      if (colon === -1) continue;
      for (const range of part.slice(colon + 1).split(",")) {
        const bits = range.split("-");
        if (bits.length !== 2) continue;
        const a = Number(bits[0]);
        const b = Number(bits[1]);
        if (Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a) ranges.push([a, b]);
      }
    }
    ranges.sort((x, y) => y[0] - x[0]);
    let out = text;
    for (const [a, b] of ranges) out = out.slice(0, a) + " " + out.slice(b + 1);
    return out;
  }

  function isEmoteOrEmojiOnly(text, emotesTag) {
    return !speakableText(text, emotesTag);
  }

  /** Strip Twitch emotes + emoji + URLs; keep readable words for TTS. */
  function speakableText(text, emotesTag) {
    let t = textWithoutTwitchEmotes(String(text || ""), emotesTag || "");
    try {
      t = t.replace(/\p{Extended_Pictographic}/gu, " ");
      // Do not strip \p{Emoji_Component}: it includes ASCII 0-9, #, *
    } catch (_) {
      t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ");
    }
    t = t.replace(/[\uFE0F\u200D\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu, " ");
    // Strip URLs so TTS does not read links (display text still shows them)
    t = t.replace(/https?:\/\/[^\s]+/gi, " ");
    t = t.replace(/\b(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s]*)?/gi, " ");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  }

  function shouldSkip(user, text, tags) {
    const u = user.toLowerCase();
    const tg = tags || {};
    if (el.optSkipBots.checked && KNOWN_BOTS.has(u)) return "bot";
    if (parseIgnoreList().has(u)) return "ignore";
    if (el.optSkipCommands.checked && text.trim().startsWith("!")) return "command";
    if (el.optSkipRedeems.checked && tg["custom-reward-id"]) return "redeem";
    if (!text.trim()) return "empty";
    if (el.optSkipEmotes.checked && isEmoteOrEmojiOnly(text, tg.emotes || "")) return "emote";
    return null;
  }

  function connect() {
    let channel = el.channel.value.trim().replace(/^#/, "").toLowerCase();
    if (!channel) {
      setStatus("error", "กรุณาใส่ชื่อช่อง");
      el.channel.focus();
      return;
    }
    const m = channel.match(/twitch\.tv\/([a-z0-9_]+)/i);
    if (m) channel = m[1].toLowerCase();
    el.channel.value = channel;
    saveSettings();

    intentionallyClosed = false;
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    clearTimeout(reconnectTimer);

    setStatus("connecting", "กำลังเชื่อมต่อ…");
    el.btnConnect.disabled = true;
    el.btnDisconnect.disabled = false;

    const nick = "justinfan" + Math.floor(10000 + Math.random() * 80000);
    ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send(`NICK ${nick}`);
      ws.send(`JOIN #${channel}`);
    };

    ws.onmessage = (ev) => {
      const lines = String(ev.data).split(/\r?\n/).filter(Boolean);
      for (const line of lines) handleIrcLine(line, channel, nick);
    };

    ws.onerror = () => setStatus("error", "WebSocket error");

    ws.onclose = () => {
      const was = connectedChannel;
      connectedChannel = null;
      el.btnConnect.disabled = false;
      el.btnDisconnect.disabled = true;
      if (intentionallyClosed) {
        setStatus("disconnected", "ตัดการเชื่อมต่อแล้ว");
        return;
      }
      setStatus("connecting", "หลุดการเชื่อมต่อ — กำลังลองใหม่…");
      reconnectTimer = setTimeout(() => {
        if (!intentionallyClosed) connect();
      }, 2500);
      if (was) addChatLine("ระบบ", `ตัดจาก #${was} — กำลัง reconnect`, { color: "#f5a524" });
    };
  }

  function handleIrcLine(line, channel, nick) {
    if (line.startsWith("PING")) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send("PONG :tmi.twitch.tv");
      return;
    }
    if (line.includes(` 001 ${nick}`) || line.includes(`JOIN #${channel}`)) {
      if (connectedChannel !== channel) {
        connectedChannel = channel;
        setStatus("connected", `เชื่อมต่อแล้ว · #${channel}`);
        addChatLine("ระบบ", `เข้าร่วมแชท #${channel} แล้ว`, { color: "#3dd68c" });
      }
    }
    if (line.includes(" RECONNECT")) {
      try { ws && ws.close(); } catch (_) {}
      return;
    }
    const priv = line.match(/^(?:@([^ ]+) )?:([\w]+)![\w]+@[\w.]+ PRIVMSG #([\w]+) :(.*)$/);
    if (!priv) return;
    const tagsRaw = priv[1] || "";
    const user = priv[2];
    let text = sanitizeChatText(priv[4]);
    const tags = {};
    if (tagsRaw) {
      for (const part of tagsRaw.split(";")) {
        const i = part.indexOf("=");
        if (i === -1) tags[part] = "";
        else tags[part.slice(0, i)] = part.slice(i + 1);
      }
    }
    const display = tags["display-name"] || user;
    const color = tags.color || undefined;
    const reason = shouldSkip(user, text, tags);
    if (reason) {
      addChatLine(display, text, { skipped: true, color });
      return;
    }
    const forSpeech = speakableText(text, tags.emotes || "");
    if (!forSpeech) {
      addChatLine(display, text, { skipped: true, color });
      return;
    }
    addChatLine(display, text, { queued: true, color, speakText: forSpeech });
    enqueue(display, forSpeech);
  }

  function disconnect() {
    intentionallyClosed = true;
    clearTimeout(reconnectTimer);
    if (ws) {
      try {
        if (connectedChannel) ws.send(`PART #${connectedChannel}`);
        ws.close();
      } catch (_) {}
      ws = null;
    }
    connectedChannel = null;
    el.btnConnect.disabled = false;
    el.btnDisconnect.disabled = true;
    setStatus("disconnected", "ตัดการเชื่อมต่อแล้ว");
  }

  el.btnConnect.addEventListener("click", connect);
  el.btnDisconnect.addEventListener("click", disconnect);
  el.channel.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });

  el.chatLog.addEventListener("click", (e) => {
    const btn = e.target.closest(".chat-rerun");
    if (!btn) return;
    const line = btn.closest(".chat-line");
    if (!line || !line.dataset.speakText) return;
    rerunChatLine(
      line.dataset.user || "",
      line.dataset.displayText || line.dataset.speakText,
      line.dataset.speakText
    );
  });

  el.btnPause.addEventListener("click", () => {
    paused = true;
    el.btnPause.disabled = true;
    el.btnResume.disabled = false;
    stopCurrentSpeech();
    speaking = false;
    if (currentItem) {
      queue.unshift(currentItem);
      currentItem = null;
      renderQueue();
    }
    setNowSpeaking("", "พักอยู่");
  });

  el.btnResume.addEventListener("click", () => {
    paused = false;
    el.btnPause.disabled = false;
    el.btnResume.disabled = true;
    processQueue();
  });

  el.btnSkip.addEventListener("click", () => {
    stopCurrentSpeech();
    speaking = false;
    currentItem = null;
    processQueue();
  });

  el.btnClear.addEventListener("click", () => {
    queue.length = 0;
    stopCurrentSpeech();
    speaking = false;
    currentItem = null;
    setNowSpeaking("", "—");
    renderQueue();
  });

  el.btnTestVoice.addEventListener("click", () => {
    const text = "สวัสดีครับ นี่คือการทดสอบเสียงอ่านแชททวิตช์";
    queue.unshift({ id: ++msgSeq, user: "ทดสอบ", text, speakText: text, lang: "th", time: nowTime() });
    renderQueue();
    if (!speaking && !paused) processQueue();
  });

  if (el.btnRefreshVoices) {
    el.btnRefreshVoices.addEventListener("click", () => populateWebSpeechVoices());
  }

  el.btnTestProxy.addEventListener("click", async () => {
    el.proxyStatus.textContent = "กำลังทดสอบ…";
    el.proxyStatus.className = "mini-status";
    const key = getApiKey();
    if (!key) {
      el.proxyStatus.textContent = "ใส่ API Key ก่อน";
      el.proxyStatus.className = "mini-status bad";
      return;
    }
    try {
      const base = (el.proxyUrl.value || "").replace(/\/$/, "");
      let healthOk = false;
      if (base) {
        try {
          const h = await fetch(base + "/health", { signal: AbortSignal.timeout(2500) });
          healthOk = h.ok;
        } catch (_) {}
      }
      const blob = await fetchTokenMeMp3("ทดสอบ");
      if (!blob || blob.size < 100) throw new Error("ได้ไฟล์เสียงว่าง");
      el.proxyStatus.textContent = healthOk
        ? "พร้อมใช้ ✓ (ผ่าน proxy · " + blob.size + " bytes)"
        : "พร้อมใช้ ✓ (ตรง/สำรอง · " + blob.size + " bytes)";
      el.proxyStatus.className = "mini-status ok";
    } catch (e) {
      el.proxyStatus.textContent = "ล้มเหลว: " + (e && e.message ? e.message.slice(0, 80) : "error");
      el.proxyStatus.className = "mini-status bad";
    }
  });

  el.ttsProvider.addEventListener("change", onProviderChange);
  [
    "rate", "pitch", "volume", "optSayName", "optSkipCommands", "optSkipBots",
    "optSkipEmotes", "optSkipRedeems",
    "maxQueue", "ignoreList", "maxLen", "proxyUrl", "voiceSelect", "channel",
    "apiKey", "tmModel", "tmVoice",
  ].forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener("change", saveSettings);
    node.addEventListener("input", () => {
      if (id === "rate" || id === "pitch" || id === "volume") updateSliderLabels();
      saveSettings();
    });
  });

  function setupDesktopUpdater() {
    const api = window.desktopApi;
    if (!api) return;

    const banner = document.getElementById("updateBanner");
    const titleEl = document.getElementById("updateBannerTitle");
    const detailEl = document.getElementById("updateBannerDetail");
    const btnNow = document.getElementById("btnUpdateNow");
    const btnLater = document.getElementById("btnUpdateLater");
    const btnCheck = document.getElementById("btnCheckUpdate");
    const verEl = document.getElementById("appVersion");
    const progressWrap = document.getElementById("updateProgressWrap");
    const progressFill = document.getElementById("updateProgressFill");
    const progressLabel = document.getElementById("updateProgressLabel");

    function showBanner(info) {
      if (!banner) return;
      if (titleEl) titleEl.textContent = `มีเวอร์ชันใหม่ v${info.version}`;
      if (detailEl) {
        detailEl.textContent = info.current
          ? `ตอนนี้ v${info.current} — กดอัปเดตเพื่อดาวน์โหลดและติดตั้ง`
          : "กดอัปเดตเพื่อดาวน์โหลดและติดตั้ง";
      }
      if (progressWrap) progressWrap.classList.add("hidden");
      if (btnNow) {
        btnNow.disabled = false;
        btnNow.classList.remove("hidden");
      }
      if (btnLater) btnLater.classList.remove("hidden");
      banner.classList.remove("hidden");
    }

    function hideBanner() {
      if (banner) banner.classList.add("hidden");
    }

    function setProgress(p) {
      if (!progressWrap) return;
      progressWrap.classList.remove("hidden");
      const pct = typeof p.percent === "number" ? p.percent : 0;
      if (progressFill) progressFill.style.width = `${pct}%`;
      if (progressLabel) {
        progressLabel.textContent = p.stage === "install" ? "ติดตั้ง…" : `${pct}%`;
      }
      if (btnNow) btnNow.disabled = true;
      if (btnLater) btnLater.classList.add("hidden");
    }

    api.getAppVersion().then((v) => {
      if (verEl) {
        verEl.textContent = `v${v}`;
        verEl.classList.remove("hidden");
      }
      if (btnCheck) btnCheck.classList.remove("hidden");
    }).catch(() => {});

    api.onUpdateAvailable((info) => showBanner(info));
    api.onUpdateProgress((p) => setProgress(p));
    api.onUpdateError((msg) => {
      if (titleEl) titleEl.textContent = "อัปเดตไม่สำเร็จ";
      if (detailEl) detailEl.textContent = String(msg || "เกิดข้อผิดพลาด");
      if (banner) banner.classList.remove("hidden");
      if (btnNow) btnNow.disabled = false;
      if (btnLater) btnLater.classList.remove("hidden");
      if (progressWrap) progressWrap.classList.add("hidden");
    });

    if (btnNow) {
      btnNow.addEventListener("click", async () => {
        btnNow.disabled = true;
        setProgress({ percent: 0, stage: "download" });
        try {
          const result = await api.startUpdate();
          if (result && result.ok === false) {
            throw new Error(result.error || "อัปเดตไม่สำเร็จ");
          }
        } catch (err) {
          if (titleEl) titleEl.textContent = "อัปเดตไม่สำเร็จ";
          if (detailEl) detailEl.textContent = err.message || String(err);
          btnNow.disabled = false;
          if (btnLater) btnLater.classList.remove("hidden");
          if (progressWrap) progressWrap.classList.add("hidden");
        }
      });
    }
    if (btnLater) btnLater.addEventListener("click", hideBanner);
    if (btnCheck) {
      btnCheck.addEventListener("click", async () => {
        btnCheck.disabled = true;
        try {
          const result = await api.checkForUpdates();
          if (result && result.updateAvailable) {
            showBanner(result);
          } else if (result && result.error) {
            if (titleEl) titleEl.textContent = "ตรวจอัปเดตไม่สำเร็จ";
            if (detailEl) detailEl.textContent = result.error;
            if (banner) banner.classList.remove("hidden");
            if (btnNow) btnNow.classList.add("hidden");
          } else {
            if (titleEl) titleEl.textContent = "เป็นเวอร์ชันล่าสุดแล้ว";
            if (detailEl) {
              detailEl.textContent = result && result.current
                ? `v${result.current}`
                : "";
            }
            if (banner) banner.classList.remove("hidden");
            if (btnNow) btnNow.classList.add("hidden");
            if (btnLater) btnLater.textContent = "ปิด";
            setTimeout(hideBanner, 3500);
          }
        } catch (err) {
          if (titleEl) titleEl.textContent = "ตรวจอัปเดตไม่สำเร็จ";
          if (detailEl) detailEl.textContent = err.message || String(err);
          if (banner) banner.classList.remove("hidden");
          if (btnNow) btnNow.classList.add("hidden");
        } finally {
          btnCheck.disabled = false;
          if (btnLater) btnLater.classList.remove("hidden");
        }
      });
    }
  }

  // Desktop (Electron): ?desktop=1&proxy=http://127.0.0.1:PORT
  (function applyDesktopParams() {
    try {
      const q = new URLSearchParams(location.search);
      const proxy = q.get("proxy") || q.get("edgeProxy");
      const isDesktop = q.get("desktop") === "1" || !!proxy;
      if (proxy) el.proxyUrl.value = proxy;
      if (isDesktop) {
        document.body.classList.add("desktop-app");
        const hint = document.getElementById("proxyHint");
        if (hint) {
          hint.innerHTML = "แอป portable เปิด proxy ในเครื่องให้อัตโนมัติแล้ว — ใส่ API Key แล้วใช้งานได้เลย";
        }
        const proxyField = document.getElementById("proxyFieldWrap") ||
          (el.proxyUrl && el.proxyUrl.closest("label"));
        if (proxyField) proxyField.classList.add("hidden");
        setupDesktopUpdater();
      }
    } catch (_) {}
  })();

  loadSettings();
  (function keepDesktopProxy() {
    try {
      const q = new URLSearchParams(location.search);
      const proxy = q.get("proxy") || q.get("edgeProxy");
      if (proxy) el.proxyUrl.value = proxy;
    } catch (_) {}
  })();
  updateSliderLabels();
  renderQueue();
  onProviderChange();

  if ("speechSynthesis" in window) {
    populateWebSpeechVoices();
    speechSynthesis.onvoiceschanged = () => {
      if (el.ttsProvider.value === "webspeech") populateWebSpeechVoices();
    };
  }

  setInterval(() => {
    if (el.ttsProvider.value !== "webspeech") return;
    if (!speaking) return;
    try {
      if (speechSynthesis.speaking && speechSynthesis.paused) speechSynthesis.resume();
    } catch (_) {}
  }, 5000);
})();
