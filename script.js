/* ASAD AI - script.js */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Providers (ids must match the ids in server.js)
  // ---------------------------------------------------------------------------
  const PROVIDERS = [
    { id: "gemini",     name: "Google Gemini",       url: "https://aistudio.google.com/apikey",              hint: "Get a free key from Google AI Studio." },
    { id: "groq",       name: "Groq",                url: "https://console.groq.com/keys",                   hint: "Very fast. Free key from the Groq console." },
    { id: "openrouter", name: "OpenRouter Free",     url: "https://openrouter.ai/keys",                      hint: "Uses free models. Create a key on OpenRouter." },
    { id: "mistral",    name: "Mistral",             url: "https://console.mistral.ai/api-keys",             hint: "Choose the free plan, no card needed." },
    { id: "cloudflare", name: "Cloudflare Workers AI", url: "https://dash.cloudflare.com/profile/api-tokens", hint: "Needs an API token and your Account ID.", needsAccount: true },
    { id: "nvidia",     name: "NVIDIA NIM",          url: "https://build.nvidia.com",                        hint: "Open any model and click 'Get API Key'." },
    { id: "cohere",     name: "Cohere",              url: "https://dashboard.cohere.com/api-keys",           hint: "Trial key is free (testing use only)." },
    { id: "sambanova",  name: "SambaNova",           url: "https://cloud.sambanova.ai/apis",                 hint: "Free tier, low daily request limit." }
  ];
  const byId = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));
  const pname = id => (byId[id] ? byId[id].name : id);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);

  const LS = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    }
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // ---------------------------------------------------------------------------
  // Tiny, safe Markdown renderer (no external libraries)
  // @@MD_START
  // ---------------------------------------------------------------------------
  function inlineMd(text) {
    return text
      .split(/(`[^`]+`)/g)
      .map((part, i) => {
        if (i % 2 === 1) return "<code>" + part.slice(1, -1) + "</code>";
        return part
          .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
            '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
      })
      .join("");
  }

  function renderMarkdown(src) {
    const blocks = [];
    let text = String(src).replace(/\r\n/g, "\n");

    // 1) pull out fenced code blocks
    text = text.replace(/```([\w+-]*)[^\n]*\n?([\s\S]*?)```/g, (_m, lang, code) => {
      blocks.push({ lang, code: code.replace(/\n$/, "") });
      return "\n\u0000" + (blocks.length - 1) + "\u0000\n";
    });

    // 2) escape everything else, then do block parsing line by line
    const lines = escapeHtml(text).split("\n");
    const out = [];
    let para = [];
    let list = null; // "ul" | "ol"

    const flushPara = () => {
      if (para.length) { out.push("<p>" + inlineMd(para.join("<br>")) + "</p>"); para = []; }
    };
    const closeList = () => {
      if (list) { out.push("</" + list + ">"); list = null; }
    };

    for (const line of lines) {
      let m;
      if ((m = line.match(/^\u0000(\d+)\u0000$/))) {
        flushPara(); closeList();
        const b = blocks[Number(m[1])];
        out.push(
          '<div class="code"><div class="code-head"><span>' + escapeHtml(b.lang || "code") +
          '</span><button type="button" class="copy-code">Copy</button></div><pre><code>' +
          escapeHtml(b.code) + "</code></pre></div>"
        );
      } else if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        flushPara(); closeList();
        const n = m[1].length;
        out.push("<h" + n + ">" + inlineMd(m[2]) + "</h" + n + ">");
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
        out.push("<li>" + inlineMd(m[1]) + "</li>");
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
        out.push("<li>" + inlineMd(m[1]) + "</li>");
      } else if ((m = line.match(/^&gt;\s?(.*)$/))) {
        flushPara(); closeList();
        out.push("<blockquote>" + inlineMd(m[1]) + "</blockquote>");
      } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
        flushPara(); closeList();
        out.push("<hr>");
      } else if (line.trim() === "") {
        flushPara(); closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara(); closeList();
    return out.join("\n");
  }
  // @@MD_END

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let chats = LS.get("asad.chats", []);
  let activeId = LS.get("asad.active", null);
  let keys = LS.get("asad.keys", {});
  let cfAccount = LS.get("asad.cfAccount", "");
  let selected = LS.get("asad.provider", "auto");
  let serverStatus = {};
  let busy = false;
  let voiceMode = false; // true while the voice-talk overlay is open
  let controller = null;
  const animateIds = new Set(); // ids of replies that should "type out"
  let unlocked = false; // settings always start locked on every page load

  if (selected !== "auto" && !byId[selected]) selected = "auto";

  // ---------------------------------------------------------------------------
  // Elements
  // ---------------------------------------------------------------------------
  const el = {
    app: $("#app"), scrim: $("#scrim"), menuBtn: $("#menuBtn"),
    newChatBtn: $("#newChatBtn"), chatSearch: $("#chatSearch"), chatList: $("#chatList"),
    themeBtn: $("#themeBtn"), sideSettingsBtn: $("#sideSettingsBtn"),
    providerSelect: $("#providerSelect"), onlineDot: $("#onlineDot"), modelBadge: $("#modelBadge"),
    exportBtn: $("#exportBtn"), settingsBtn: $("#settingsBtn"),
    chatArea: $("#chatArea"), welcome: $("#welcome"), messages: $("#messages"),
    chatForm: $("#chatForm"), messageInput: $("#messageInput"),
    chatProviderLabel: $("#chatProviderLabel"), sendBtn: $("#sendBtn"),
    settingsModal: $("#settingsModal"), closeSettingsBtn: $("#closeSettingsBtn"),
    settingsProvider: $("#settingsProvider"), providerHelp: $("#providerHelp"),
    apiKeyInput: $("#apiKeyInput"), toggleKeyBtn: $("#toggleKeyBtn"),
    cfRow: $("#cfRow"), cfAccountInput: $("#cfAccountInput"),
    settingsMessage: $("#settingsMessage"), removeKeyBtn: $("#removeKeyBtn"), saveKeyBtn: $("#saveKeyBtn"),
    providerStatusList: $("#providerStatusList"),
    lockState: $("#lockState"), newPassword: $("#newPassword"),
    savePasswordBtn: $("#savePasswordBtn"),
    clearChatsBtn: $("#clearChatsBtn"),
    lockTitle: $("#lockTitle"), lockText: $("#lockText"), lockConfirm: $("#lockConfirm"), lockSubmit: $("#lockSubmit"),
    settingsLock: $("#settingsLock"), lockForm: $("#lockForm"), lockPassword: $("#lockPassword"),
    lockError: $("#lockError"), cancelLock: $("#cancelLock"),
    toast: $("#toast")
  };

  // ---------------------------------------------------------------------------
  // Persistence + small utilities
  // ---------------------------------------------------------------------------
  function saveChats() {
    // keep storage small: newest 60 chats
    chats.sort((a, b) => b.updated - a.updated);
    if (chats.length > 60) chats = chats.slice(0, 60);
    LS.set("asad.chats", chats);
    LS.set("asad.active", activeId);
  }

  const getActive = () => chats.find(c => c.id === activeId) || null;

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    toast("Copied");
  }

  // ---------------------------------------------------------------------------
  // Provider availability
  // ---------------------------------------------------------------------------
  function isAvailable(id) {
    if (serverStatus[id] && serverStatus[id].configured) return true;
    if (!keys[id]) return false;
    if (byId[id].needsAccount && !cfAccount) return false;
    return true;
  }

  function sourceOf(id) {
    if (serverStatus[id] && serverStatus[id].configured) return "server";
    if (isAvailable(id)) return "browser";
    return "none";
  }

  function renderProviderSelect() {
    el.providerSelect.innerHTML = "";
    const add = (value, label) => {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = label;
      el.providerSelect.appendChild(o);
    };
    add("auto", "⚡ Auto (fallback)");
    PROVIDERS.forEach(p => add(p.id, (isAvailable(p.id) ? "● " : "○ ") + p.name));
    el.providerSelect.value = selected;
    updateProviderUi();
  }

  function updateProviderUi() {
    const label = selected === "auto" ? "Auto" : pname(selected);
    el.chatProviderLabel.textContent = "Using " + label;
    const anyOn = selected === "auto" ? PROVIDERS.some(p => isAvailable(p.id)) : isAvailable(selected);
    el.onlineDot.classList.toggle("on", anyOn);
    if (selected === "auto") {
      const n = PROVIDERS.filter(p => isAvailable(p.id)).length;
      el.modelBadge.textContent = n + " ready";
    } else {
      el.modelBadge.textContent = (serverStatus[selected] && serverStatus[selected].model) || "";
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch("/api/status");
      const data = await r.json();
      serverStatus = data.providers || {};
    } catch {
      serverStatus = {};
    }
    renderProviderSelect();
    renderStatusList();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderSidebar() {
    const q = el.chatSearch.value.trim().toLowerCase();
    const list = chats
      .slice()
      .sort((a, b) => b.updated - a.updated)
      .filter(c => !q || c.title.toLowerCase().includes(q));

    el.chatList.innerHTML = "";
    if (!list.length) {
      const d = document.createElement("div");
      d.className = "empty-list";
      d.textContent = q ? "No chats found." : "No chats yet.";
      el.chatList.appendChild(d);
      return;
    }
    for (const c of list) {
      const item = document.createElement("div");
      item.className = "chat-item" + (c.id === activeId ? " active" : "");
      item.dataset.id = c.id;

      const t = document.createElement("span");
      t.className = "t";
      t.textContent = c.title;

      const del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.title = "Delete chat";
      del.setAttribute("aria-label", "Delete chat");
      del.dataset.del = c.id;
      del.textContent = "✕";

      item.append(t, del);
      el.chatList.appendChild(item);
    }
  }

  // Reveal a fresh reply progressively (typewriter effect, about 2.5 seconds max)
  function typeInto(node, full, actions) {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      node.innerHTML = renderMarkdown(full);
      return;
    }
    const total = full.length;
    const step = Math.max(2, Math.ceil(total / 150));
    let i = 0;
    node.classList.add("typing-live");
    if (actions) actions.style.visibility = "hidden";
    const timer = setInterval(() => {
      if (!node.isConnected) { clearInterval(timer); return; }
      i = Math.min(total, i + step);
      let part = full.slice(0, i);
      // keep an unfinished code block renderable
      if ((part.match(/```/g) || []).length % 2 === 1) part += "\n```";
      node.innerHTML = renderMarkdown(part);
      el.chatArea.scrollTop = el.chatArea.scrollHeight;
      if (i >= total) {
        clearInterval(timer);
        node.classList.remove("typing-live");
        if (actions) actions.style.visibility = "";
      }
    }, 16);
  }

  function buildMessage(m, index, isLast) {
    const wrap = document.createElement("div");

    if (m.role === "user") {
      wrap.className = "msg user";
      const b = document.createElement("div");
      b.className = "bubble";
      b.textContent = m.text;
      wrap.appendChild(b);
      return wrap;
    }

    wrap.className = "msg assistant" + (m.error ? " error" : "");

    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = "A";

    const body = document.createElement("div");
    body.className = "msg-body";

    const head = document.createElement("div");
    head.className = "msg-head";
    const nm = document.createElement("strong");
    nm.textContent = "ASAD AI";
    head.appendChild(nm);
    if (m.provider && !m.error) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = pname(m.provider) + (m.model ? " · " + m.model : "");
      head.appendChild(tag);
    }

    const content = document.createElement("div");
    content.className = "content";
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "act";
    copy.dataset.act = "copy";
    copy.dataset.index = String(index);
    copy.textContent = "Copy";
    actions.appendChild(copy);
    if (isLast) {
      const re = document.createElement("button");
      re.type = "button";
      re.className = "act";
      re.dataset.act = "regen";
      re.textContent = "↻ Regenerate";
      actions.appendChild(re);
    }

    body.append(head, content, actions);
    wrap.append(av, body);

    if (m.id && animateIds.has(m.id)) {
      animateIds.delete(m.id);
      typeInto(content, m.text, actions);
    } else {
      content.innerHTML = renderMarkdown(m.text);
    }
    return wrap;
  }

  function buildTyping() {
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    wrap.id = "typingRow";
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = "A";
    const body = document.createElement("div");
    body.className = "msg-body";
    const t = document.createElement("div");
    t.className = "typing";
    t.innerHTML = "<i></i><i></i><i></i>";
    body.appendChild(t);
    wrap.append(av, body);
    return wrap;
  }

  function renderMessages() {
    const chat = getActive();
    const msgs = chat ? chat.messages : [];
    el.welcome.hidden = msgs.length > 0 || busy;
    el.messages.innerHTML = "";
    msgs.forEach((m, i) => {
      el.messages.appendChild(buildMessage(m, i, i === msgs.length - 1 && m.role === "assistant" && !busy));
    });
    if (busy) el.messages.appendChild(buildTyping());
    // empty chat: stay at the top so the welcome photo is fully visible
    el.chatArea.scrollTop = (msgs.length || busy) ? el.chatArea.scrollHeight : 0;
  }

  function renderAll() {
    renderSidebar();
    renderMessages();
  }

  // ---------------------------------------------------------------------------
  // Chats
  // ---------------------------------------------------------------------------
  function newChat() {
    const existing = getActive();
    if (existing && existing.messages.length === 0) { closeSidebar(); el.messageInput.focus(); return existing; }
    const chat = { id: uid(), title: "New chat", messages: [], updated: Date.now() };
    chats.unshift(chat);
    activeId = chat.id;
    saveChats();
    renderAll();
    closeSidebar();
    el.messageInput.focus();
    return chat;
  }

  function deleteChat(id) {
    chats = chats.filter(c => c.id !== id);
    if (activeId === id) activeId = chats.length ? chats[0].id : null;
    saveChats();
    renderAll();
  }

  function openChat(id) {
    if (busy) { toast("Wait for the current reply"); return; }
    activeId = id;
    saveChats();
    renderAll();
    closeSidebar();
  }

  function exportChat() {
    const chat = getActive();
    if (!chat || !chat.messages.length) { toast("Nothing to export"); return; }
    const md = chat.messages
      .map(m => (m.role === "user" ? "### You\n\n" : "### ASAD AI" + (m.provider ? " (" + pname(m.provider) + ")" : "") + "\n\n") + m.text)
      .join("\n\n---\n\n");
    const blob = new Blob(["# " + chat.title + "\n\n" + md + "\n"], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (chat.title.replace(/[^\w-]+/g, "_").slice(0, 40) || "chat") + ".md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------
  function setBusy(v) {
    busy = v;
    el.sendBtn.textContent = v ? "■" : "↑";
    el.sendBtn.classList.toggle("stop", v);
    el.sendBtn.setAttribute("aria-label", v ? "Stop" : "Send");
  }

  async function send(rawText, regen = false) {
    const text = String(rawText).trim();
    if (!text || busy) return;

    let chat = getActive() || newChat();

    if (!regen) {
      chat.messages.push({ role: "user", text, t: Date.now() });
      if (chat.title === "New chat") chat.title = text.slice(0, 44);
    }
    chat.updated = Date.now();
    saveChats();

    // history = everything before the latest user message
    const history = chat.messages
      .slice(0, -1)
      .filter(m => !m.error)
      .slice(-10)
      .map(m => ({ role: m.role, text: m.text }));

    setBusy(true);
    renderAll();

    // Auto mode tries the fastest providers first
    const AUTO_ORDER = ["groq", "mistral", "cohere", "sambanova", "gemini", "openrouter", "cloudflare", "nvidia"];
    const order = selected === "auto"
      ? AUTO_ORDER.filter(isAvailable)
      : [selected];

    let reply = null;
    let aborted = false;
    const failures = [];

    if (!order.length) {
      failures.push("No API key found. Open API Settings and add a key (or put one in .env).");
    }

    controller = new AbortController();

    for (const p of order) {
      try {
        const r = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            provider: p,
            message: text,
            history,
            apiKey: keys[p] || "",
            accountId: cfAccount || "",
            voice: voiceMode
          })
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.answer) throw new Error(data.error || "HTTP " + r.status);
        reply = { id: uid(), role: "assistant", text: data.answer, provider: p, model: data.model, t: Date.now() };
        animateIds.add(reply.id);
        break;
      } catch (e) {
        if (e && e.name === "AbortError") { aborted = true; break; }
        failures.push((order.length > 1 || selected !== "auto" ? pname(p) + ": " : "") + (e.message || "Request failed"));
      }
    }

    controller = null;

    if (reply) {
      chat.messages.push(reply);
    } else if (aborted) {
      chat.messages.push({ role: "assistant", text: "Stopped.", error: true, t: Date.now() });
    } else {
      chat.messages.push({
        role: "assistant",
        text: "Error: " + failures.join("\n\nError: "),
        error: true,
        t: Date.now()
      });
    }

    chat.updated = Date.now();
    setBusy(false);
    saveChats();
    renderAll();
  }

  function regenerate() {
    const chat = getActive();
    if (!chat || busy) return;
    // drop trailing assistant message(s)
    while (chat.messages.length && chat.messages[chat.messages.length - 1].role === "assistant") {
      chat.messages.pop();
    }
    const last = chat.messages[chat.messages.length - 1];
    if (!last) return;
    send(last.text, true);
  }

  // ---------------------------------------------------------------------------
  // Settings modal
  // ---------------------------------------------------------------------------
  function renderProviderHelp() {
    const p = byId[el.settingsProvider.value];
    el.providerHelp.innerHTML = "";
    el.providerHelp.append(document.createTextNode(p.hint + " "));
    const a = document.createElement("a");
    a.href = p.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = "Get API key ↗";
    el.providerHelp.appendChild(a);
    el.cfRow.hidden = !p.needsAccount;
    el.apiKeyInput.value = keys[p.id] || "";
    el.cfAccountInput.value = cfAccount || "";
    el.settingsMessage.textContent = "";
    el.settingsMessage.className = "settings-message";
  }

  function renderStatusList() {
    el.providerStatusList.innerHTML = "";
    for (const p of PROVIDERS) {
      const row = document.createElement("div");
      row.className = "status-row";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = p.name;
      const md = document.createElement("span");
      md.className = "md";
      md.textContent = (serverStatus[p.id] && serverStatus[p.id].model) || "";
      const pill = document.createElement("span");
      const src = sourceOf(p.id);
      pill.className = "pill " + (src === "none" ? "" : src);
      pill.textContent = src === "server" ? "Server key" : src === "browser" ? "Browser key" : "Not set";
      row.append(nm, md, pill);
      el.providerStatusList.appendChild(row);
    }
  }

  function renderLockState() {
    el.lockState.textContent = "A password is required every time you open these settings.";
  }

  function showSettings() {
    el.settingsProvider.innerHTML = "";
    PROVIDERS.forEach(p => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      el.settingsProvider.appendChild(o);
    });
    el.settingsProvider.value = selected !== "auto" ? selected : "gemini";
    renderProviderHelp();
    renderStatusList();
    renderLockState();
    el.settingsModal.hidden = false;
  }

  // The lock is always on: first time you must create a password,
  // after that it is asked every time settings are opened.
  let lockMode = "enter"; // "create" | "enter"

  function openSettings() {
    closeSidebar();
    if (unlocked) { showSettings(); return; }

    lockMode = LS.get("asad.lock", null) ? "enter" : "create";
    el.lockPassword.value = "";
    el.lockConfirm.value = "";
    el.lockError.textContent = "";
    if (lockMode === "create") {
      el.lockTitle.textContent = "Create a password";
      el.lockText.textContent = "Set a password to protect your API Settings. You will need it every time.";
      el.lockPassword.placeholder = "New password (min 4 characters)";
      el.lockPassword.autocomplete = "new-password";
      el.lockConfirm.hidden = false;
      el.lockConfirm.required = true;
      el.lockSubmit.textContent = "Save password & open";
    } else {
      el.lockTitle.textContent = "ASAD AI Security";
      el.lockText.textContent = "Enter your password to access API Settings.";
      el.lockPassword.placeholder = "Enter security password";
      el.lockPassword.autocomplete = "current-password";
      el.lockConfirm.hidden = true;
      el.lockConfirm.required = false;
      el.lockSubmit.textContent = "Unlock Settings";
    }
    el.settingsLock.hidden = false;
    el.lockPassword.focus();
  }

  function relock() {
    unlocked = false;
    try { sessionStorage.removeItem("asad.unlocked"); } catch { /* ignore */ }
  }

  const closeSettings = () => { el.settingsModal.hidden = true; relock(); };

  function setMsg(text, ok) {
    el.settingsMessage.textContent = text;
    el.settingsMessage.className = "settings-message " + (ok ? "ok" : "err");
  }

  function saveKey() {
    const id = el.settingsProvider.value;
    const val = el.apiKeyInput.value.trim();
    if (!val) { setMsg("Paste an API key first.", false); return; }
    if (/\s/.test(val)) { setMsg("The key must not contain spaces.", false); return; }
    keys[id] = val;
    if (byId[id].needsAccount) {
      const acc = el.cfAccountInput.value.trim();
      if (!/^[a-zA-Z0-9]+$/.test(acc)) { setMsg("Enter a valid Cloudflare Account ID.", false); return; }
      cfAccount = acc;
      LS.set("asad.cfAccount", cfAccount);
    }
    LS.set("asad.keys", keys);
    setMsg(byId[id].name + " key saved in this browser.", true);
    renderProviderSelect();
    renderStatusList();
  }

  function removeKey() {
    const id = el.settingsProvider.value;
    delete keys[id];
    LS.set("asad.keys", keys);
    el.apiKeyInput.value = "";
    setMsg("Browser key removed.", true);
    renderProviderSelect();
    renderStatusList();
  }

  async function hashPw(pw) {
    const bytes = new TextEncoder().encode("asad-ai:" + pw);
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    let h = 5381;
    for (const c of pw) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
    return "x" + h;
  }

  // ---------------------------------------------------------------------------
  // Theme + sidebar (mobile)
  // ---------------------------------------------------------------------------
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    LS.set("asad.theme", t);
  }
  const openSidebar = () => document.body.classList.add("sidebar-open");
  function closeSidebar() { document.body.classList.remove("sidebar-open"); }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  el.chatForm.addEventListener("submit", e => {
    e.preventDefault();
    if (busy) { if (controller) controller.abort(); return; }
    const text = el.messageInput.value;
    if (!text.trim()) return;
    el.messageInput.value = "";
    autoGrow();
    send(text);
  });

  el.messageInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      el.chatForm.requestSubmit();
    }
  });

  function autoGrow() {
    el.messageInput.style.height = "auto";
    el.messageInput.style.height = Math.min(el.messageInput.scrollHeight, 200) + "px";
  }
  el.messageInput.addEventListener("input", autoGrow);

  document.querySelectorAll(".suggestion").forEach(btn => {
    btn.addEventListener("click", () => send(btn.dataset.prompt || ""));
  });

  el.messages.addEventListener("click", e => {
    const copyCode = e.target.closest(".copy-code");
    if (copyCode) {
      const code = copyCode.closest(".code").querySelector("code");
      copyText(code.textContent);
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "copy") {
      const chat = getActive();
      const m = chat && chat.messages[Number(act.dataset.index)];
      if (m) copyText(m.text);
    } else if (act.dataset.act === "regen") {
      regenerate();
    }
  });

  el.chatList.addEventListener("click", e => {
    const del = e.target.closest("[data-del]");
    if (del) { e.stopPropagation(); deleteChat(del.dataset.del); return; }
    const item = e.target.closest(".chat-item");
    if (item) openChat(item.dataset.id);
  });

  el.chatSearch.addEventListener("input", renderSidebar);
  el.newChatBtn.addEventListener("click", newChat);
  el.exportBtn.addEventListener("click", exportChat);
  el.themeBtn.addEventListener("click", () => {
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });
  el.menuBtn.addEventListener("click", openSidebar);
  el.scrim.addEventListener("click", closeSidebar);

  el.providerSelect.addEventListener("change", () => {
    selected = el.providerSelect.value;
    LS.set("asad.provider", selected);
    updateProviderUi();
  });

  el.settingsBtn.addEventListener("click", openSettings);
  el.sideSettingsBtn.addEventListener("click", openSettings);
  el.closeSettingsBtn.addEventListener("click", closeSettings);
  el.settingsModal.addEventListener("click", e => { if (e.target === el.settingsModal) closeSettings(); });
  el.settingsProvider.addEventListener("change", renderProviderHelp);
  el.saveKeyBtn.addEventListener("click", saveKey);
  el.removeKeyBtn.addEventListener("click", removeKey);
  el.toggleKeyBtn.addEventListener("click", () => {
    const show = el.apiKeyInput.type === "password";
    el.apiKeyInput.type = show ? "text" : "password";
    el.toggleKeyBtn.textContent = show ? "Hide" : "Show";
  });

  el.savePasswordBtn.addEventListener("click", async () => {
    const pw = el.newPassword.value;
    if (pw.length < 4) { setMsg("Password must be at least 4 characters.", false); return; }
    LS.set("asad.lock", await hashPw(pw));
    unlocked = true;
    try { sessionStorage.setItem("asad.unlocked", "1"); } catch { /* ignore */ }
    el.newPassword.value = "";
    renderLockState();
    setMsg("Settings password saved.", true);
  });

  el.clearChatsBtn.addEventListener("click", () => {
    if (!confirm("Delete all chats? This cannot be undone.")) return;
    chats = [];
    activeId = null;
    saveChats();
    renderAll();
    setMsg("All chats deleted.", true);
  });

  el.lockForm.addEventListener("submit", async e => {
    e.preventDefault();

    if (lockMode === "create") {
      const pw = el.lockPassword.value;
      if (pw.length < 4) { el.lockError.textContent = "Use at least 4 characters."; return; }
      if (pw !== el.lockConfirm.value) { el.lockError.textContent = "Passwords do not match."; return; }
      LS.set("asad.lock", await hashPw(pw));
      unlocked = true;
      el.settingsLock.hidden = true;
      showSettings();
      return;
    }

    const stored = LS.get("asad.lock", null);
    if (stored && (await hashPw(el.lockPassword.value)) === stored) {
      unlocked = true;
      el.settingsLock.hidden = true;
      showSettings();
    } else {
      el.lockError.textContent = "Wrong password.";
      el.lockPassword.value = "";
    }
  });
  el.cancelLock.addEventListener("click", () => { el.settingsLock.hidden = true; });

  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      newChat();
    } else if (e.key === "Escape") {
      if (!el.settingsModal.hidden) closeSettings();
      else if (!el.settingsLock.hidden) el.settingsLock.hidden = true;
      else closeSidebar();
    }
  });

  // ---------------------------------------------------------------------------
  // Hero photo: 3D tilt that follows the mouse + click burst
  // ---------------------------------------------------------------------------
  (function heroPhoto() {
    const hero = $("#heroPhoto");
    const wrap = $("#photoWrap");
    if (!hero || !wrap) return;

    document.addEventListener("pointermove", e => {
      if (el.welcome.hidden) return;
      const r = hero.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / Math.max(window.innerWidth / 2, 1);
      const dy = (e.clientY - (r.top + r.height / 2)) / Math.max(window.innerHeight / 2, 1);
      wrap.style.setProperty("--ry", Math.max(-1, Math.min(1, dx)) * 22 + "deg");
      wrap.style.setProperty("--rx", Math.max(-1, Math.min(1, dy)) * -22 + "deg");
    });
    document.addEventListener("pointerleave", () => {
      wrap.style.setProperty("--rx", "0deg");
      wrap.style.setProperty("--ry", "0deg");
    });

    hero.addEventListener("click", () => {
      hero.classList.remove("boom");
      void hero.offsetWidth; // restart animation
      hero.classList.add("boom");
      for (let i = 0; i < 36; i++) {
        const p = document.createElement("span");
        p.className = "particle";
        const angle = (Math.PI * 2 * i) / 36 + Math.random() * 0.4;
        const dist = 80 + Math.random() * 90;
        p.style.setProperty("--x", Math.cos(angle) * dist + "px");
        p.style.setProperty("--y", Math.sin(angle) * dist + "px");
        p.style.setProperty("--h", String(Math.floor(Math.random() * 360)));
        hero.appendChild(p);
        setTimeout(() => p.remove(), 1000);
      }
    });
  })();

  // ---------------------------------------------------------------------------
  // Voice talk: click the photo, speak, and the AI answers out loud
  // ---------------------------------------------------------------------------
  (function talk() {
    const t = {
      root: $("#talk"), stage: $("#talkStage"), status: $("#talkStatus"), caption: $("#talkCaption"),
      mic: $("#talkMic"), lang: $("#talkLang"), form: $("#talkForm"), input: $("#talkInput"),
      close: $("#talkClose"), chip: $("#talkBtn"), hero: $("#heroPhoto")
    };
    if (!t.root) return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const synth = window.speechSynthesis;
    let isOpen = false;
    let state = "idle";
    let rec = null;
    let handsFree = true;   // after the AI finishes speaking, listen again
    let watchdog = null;

    function setState(s, msg) {
      state = s;
      t.stage.dataset.state = s;
      if (msg !== undefined) t.status.textContent = msg;
    }

    function stopAll() {
      clearTimeout(watchdog);
      if (rec) { try { rec.abort(); } catch { /* ignore */ } rec = null; }
      if (synth) { try { synth.cancel(); } catch { /* ignore */ } }
    }

    function openTalk() {
      if (isOpen) return;
      isOpen = true;
      voiceMode = true;
      handsFree = true;
      t.root.hidden = false;
      t.caption.textContent = "";
      setState("idle", SR ? "Tap the mic and speak" : "Voice input needs Chrome. You can type below.");
      if (SR) setTimeout(() => { if (isOpen && state === "idle") startListening(); }, 500);
    }

    function closeTalk() {
      if (!isOpen) return;
      isOpen = false;
      voiceMode = false;
      handsFree = false;
      stopAll();
      t.root.hidden = true;
      setState("idle", "");
    }

    function startListening() {
      if (!isOpen) return;
      if (!SR) { setState("idle", "Voice input is not supported here. Use Chrome, or type below."); return; }
      if (busy) return;
      stopAll();

      rec = new SR();
      rec.lang = t.lang.value;
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;

      let finalText = "";
      let gotFinal = false;

      rec.onstart = () => setState("listening", "Listening... speak now");
      rec.onresult = e => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) { finalText += r[0].transcript; gotFinal = true; }
          else interim += r[0].transcript;
        }
        t.caption.textContent = "🎤 " + (finalText + interim);
      };
      rec.onerror = e => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          handsFree = false;
          setState("idle", "Microphone is blocked. Allow the mic in your browser, or type below.");
        } else if (e.error === "no-speech") {
          handsFree = false;
          setState("idle", "I did not hear anything. Tap the mic to try again.");
        } else if (e.error !== "aborted") {
          setState("idle", "Voice error: " + e.error + ". Tap the mic to retry.");
        }
      };
      rec.onend = () => {
        rec = null;
        if (!isOpen) return;
        if (gotFinal && finalText.trim()) handle(finalText.trim());
        else if (state === "listening") setState("idle", "Tap the mic and speak");
      };

      try { rec.start(); } catch { setState("idle", "Could not start the microphone."); }
    }

    async function handle(text) {
      if (!isOpen || busy) return;
      stopAll();
      t.caption.textContent = "🗣 " + text;
      setState("thinking", "Thinking...");

      await send(text);
      if (!isOpen) return;

      const chat = getActive();
      const last = chat && chat.messages[chat.messages.length - 1];
      if (last && last.role === "assistant" && !last.error) {
        speak(last.text);
      } else {
        setState("idle", "Something went wrong");
        t.caption.textContent = last ? last.text.slice(0, 200) : "";
      }
    }

    function speakable(md) {
      return md
        .replace(/```[\s\S]*?```/g, " code block. ")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/https?:\/\/\S+/g, " link ")
        .replace(/[*_#>~|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function pickVoice(lang) {
      const list = synth.getVoices ? synth.getVoices() : [];
      const prefix = lang.slice(0, 2).toLowerCase();
      return list.find(v => v.lang.replace("_", "-").toLowerCase() === lang.toLowerCase())
        || list.find(v => v.lang.toLowerCase().startsWith(prefix))
        || null;
    }

    function speak(raw) {
      const text = speakable(raw);
      if (!text) { setState("idle", "Tap the mic and speak"); return; }
      t.caption.textContent = text.length > 320 ? text.slice(0, 320) + "..." : text;

      const finish = () => {
        clearTimeout(watchdog);
        if (!isOpen) return;
        setState("idle", "Tap the mic and speak");
        if (handsFree && SR) setTimeout(() => { if (isOpen && state === "idle") startListening(); }, 350);
      };

      if (!synth || typeof SpeechSynthesisUtterance === "undefined") { finish(); return; }

      const lang = /[ऀ-ॿ]/.test(text) ? "hi-IN" : "en-IN";
      const parts = text.match(/[^.!?।\n]+[.!?।]*/g) || [text];
      const chunks = [];
      let cur = "";
      for (const p of parts) {
        if ((cur + p).length > 170 && cur) { chunks.push(cur.trim()); cur = p; }
        else cur += p;
      }
      if (cur.trim()) chunks.push(cur.trim());

      synth.cancel();
      setState("speaking", "Speaking...");
      const voice = pickVoice(lang);

      chunks.forEach((c, i) => {
        const u = new SpeechSynthesisUtterance(c);
        u.lang = lang;
        if (voice) u.voice = voice;
        u.rate = 1;
        u.pitch = 1;
        if (i === chunks.length - 1) { u.onend = finish; u.onerror = finish; }
        synth.speak(u);
      });

      // safety: some browsers never fire onend
      clearTimeout(watchdog);
      watchdog = setTimeout(finish, Math.min(90000, 4000 + text.length * 110));
    }

    // --- events ---
    if (t.hero) t.hero.addEventListener("click", () => setTimeout(openTalk, 500));
    if (t.chip) t.chip.addEventListener("click", openTalk);
    t.close.addEventListener("click", closeTalk);

    t.mic.addEventListener("click", () => {
      if (state === "listening") {
        handsFree = false;
        stopAll();
        setState("idle", "Tap the mic and speak");
      } else if (state === "speaking") {
        stopAll();
        setState("idle", "Tap the mic and speak");
        handsFree = true;
        startListening();
      } else {
        handsFree = true;
        startListening();
      }
    });

    t.lang.addEventListener("change", () => {
      if (state === "listening") startListening();
    });

    t.form.addEventListener("submit", e => {
      e.preventDefault();
      const v = t.input.value.trim();
      if (!v) return;
      t.input.value = "";
      handle(v);
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && isOpen) closeTalk();
    });

    if (synth && synth.getVoices) { synth.getVoices(); }
  })();

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  applyTheme(LS.get("asad.theme", "dark"));
  if (activeId && !getActive()) activeId = null;
  if (!activeId && chats.length) activeId = chats.slice().sort((a, b) => b.updated - a.updated)[0].id;
  renderProviderSelect();
  renderAll();
  loadStatus();
  el.messageInput.focus();
})();
