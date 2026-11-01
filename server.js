require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Providers
// Every provider except Gemini speaks the OpenAI chat-completions format.
// Model names can be overridden from .env (e.g. MISTRAL_MODEL=...) so you do
// not have to edit this file when a provider retires a model.
// ---------------------------------------------------------------------------
const PROVIDERS = {
  gemini: {
    envKey: "GEMINI_API_KEY",
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash"
  },
  groq: {
    envKey: "GROQ_API_KEY",
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    url: "https://api.groq.com/openai/v1/chat/completions",
    // gpt-oss is a reasoning model: thinking tokens count toward the limit.
    extraBody: { max_completion_tokens: 2500, reasoning_effort: "low" }
  },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    model: process.env.OPENROUTER_MODEL || "openrouter/free",
    url: "https://openrouter.ai/api/v1/chat/completions",
    extraHeaders: (port) => ({
      "HTTP-Referer": `http://localhost:${port}`,
      "X-OpenRouter-Title": "ASAD AI"
    }),
    extraBody: { max_tokens: 1200 }
  },
  mistral: {
    envKey: "MISTRAL_API_KEY",
    model: process.env.MISTRAL_MODEL || "mistral-small-latest",
    url: "https://api.mistral.ai/v1/chat/completions",
    extraBody: { max_tokens: 1200 }
  },
  cloudflare: {
    envKey: "CLOUDFLARE_API_KEY",
    // Cloudflare also needs your Account ID (CLOUDFLARE_ACCOUNT_ID in .env).
    needsAccountId: true,
    model: process.env.CLOUDFLARE_MODEL || "@cf/openai/gpt-oss-20b",
    url: (accountId) =>
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
    extraBody: { max_tokens: 2500 }
  },
  nvidia: {
    envKey: "NVIDIA_API_KEY",
    model: process.env.NVIDIA_MODEL || "meta/llama-3.1-70b-instruct",
    url: "https://integrate.api.nvidia.com/v1/chat/completions",
    // NVIDIA's free endpoint queues requests and can be slow on the first call
    timeoutMs: 90000,
    extraBody: { max_tokens: 1200 }
  },
  cohere: {
    envKey: "COHERE_API_KEY",
    model: process.env.COHERE_MODEL || "command-a-plus-05-2026",
    url: "https://api.cohere.ai/compatibility/v1/chat/completions",
    extraBody: { max_tokens: 1200 }
  },
  sambanova: {
    envKey: "SAMBANOVA_API_KEY",
    model: process.env.SAMBANOVA_MODEL || "Meta-Llama-3.3-70B-Instruct",
    url: "https://api.sambanova.ai/v1/chat/completions",
    extraBody: { max_tokens: 1200 }
  }
};

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/status", (_req, res) => {
  const status = {};

  for (const [provider, config] of Object.entries(PROVIDERS)) {
    const hasKey = Boolean(process.env[config.envKey]);
    const hasAccount = config.needsAccountId
      ? Boolean(process.env.CLOUDFLARE_ACCOUNT_ID)
      : true;

    status[provider] = {
      configured: hasKey && hasAccount,
      model: config.model
    };
  }

  res.json({ providers: status });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { provider, message, history, apiKey, accountId, voice } = req.body || {};

    const config = PROVIDERS[provider];

    if (!config) {
      return res.status(400).json({
        error: "Please select a valid AI provider."
      });
    }

    const key = process.env[config.envKey] || apiKey;

    if (!key) {
      return res.status(400).json({
        error: `API key missing for ${provider}. Open API Settings.`
      });
    }

    let cfAccountId = "";
    if (config.needsAccountId) {
      cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || accountId || "";
      if (!/^[a-zA-Z0-9]+$/.test(cfAccountId)) {
        return res.status(400).json({
          error:
            "Cloudflare Account ID missing. Add CLOUDFLARE_ACCOUNT_ID to your .env file."
        });
      }
    }

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        error: "Please enter a message."
      });
    }

    const messages = [{
      role: "system",
      content:
        "You are ASAD AI, a helpful assistant. Help with general questions and coding. " +
        "Always reply in the same language and script the user writes in. " +
        "Important: many users write Hindi/Urdu in English letters (Hinglish), for example " +
        "'kaise ho', 'kya kar rahe ho', 'mera naam Asad hai', 'bhai ye samjhao'. " +
        "Treat that as Hinglish, NOT Spanish or any other language, and reply in simple Hinglish " +
        "(Hindi written in English letters). If the user writes in Devanagari, reply in Hindi. " +
        "If the user writes in English, reply in English. Never switch to Spanish unless the user writes Spanish."
    }];

    // Voice chat: the reply is read aloud, so keep it short and speakable
    if (voice === true) {
      messages[0].content +=
        " VOICE MODE (this overrides the Hinglish rule above): the user is talking to you by voice " +
        "and your reply will be read aloud. Reply in 1 to 3 short, natural, friendly sentences. " +
        "No markdown, no lists, no code, no emojis, no asterisks. " +
        "If the user speaks Hindi or Hinglish, reply in Hindi written in Devanagari script so it can be spoken properly. " +
        "If the user speaks English, reply in English.";
    }

    if (Array.isArray(history)) {
      for (const item of history.slice(-10)) {
        if (
          item &&
          ["user", "assistant", "model"].includes(item.role) &&
          typeof item.text === "string"
        ) {
          messages.push({
            role: item.role === "model" ? "assistant" : item.role,
            content: item.text.slice(0, 6000)
          });
        }
      }
    }

    messages.push({
      role: "user",
      content: message.trim().slice(0, 6000)
    });

    let url;
    let headers;
    let body;

    if (provider === "gemini") {
      url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        config.model +
        ":generateContent";

      headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      };

      body = {
        contents: messages
          .filter(item => item.role !== "system")
          .map(item => ({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.content }]
          })),
        systemInstruction: {
          parts: [{ text: messages[0].content }]
        },
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1200
        }
      };
    } else {
      // All other providers: OpenAI-compatible chat completions
      url = typeof config.url === "function" ? config.url(cfAccountId) : config.url;

      headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        ...(config.extraHeaders ? config.extraHeaders(PORT) : {})
      };

      body = {
        model: config.model,
        messages,
        temperature: 0.7,
        ...(config.extraBody || {})
      };
    }

    // Give up after a while so one slow provider never blocks Auto mode
    const timeoutMs = config.timeoutMs || 25000;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      console.error(`${provider} API error:`, JSON.stringify(data));

      return res.status(response.status).json({
        error:
          data?.error?.message ||
          data?.errors?.[0]?.message || // Cloudflare format
          (typeof data?.error === "string" ? data.error : "") ||
          data?.message ||
          (typeof data?.detail === "string" ? data.detail : "") || // NVIDIA format
          (Array.isArray(data?.detail) ? JSON.stringify(data.detail) : "") ||
          (typeof data?.title === "string" ? data.title : "") ||
          `${provider} request failed (HTTP ${response.status}).`
      });
    }

    let answer = "";

    if (provider === "gemini") {
      answer = (data.candidates || [])
        .flatMap(candidate => candidate.content?.parts || [])
        .map(part => part.text || "")
        .join("")
        .trim();
    } else {
      const content = data.choices?.[0]?.message?.content;

      if (typeof content === "string") {
        answer = content.trim();
      } else if (Array.isArray(content)) {
        // Some providers return content as an array of parts
        answer = content
          .map(part => (typeof part === "string" ? part : part?.text || ""))
          .join("")
          .trim();
      }
    }

    if (!answer) {
      return res.status(502).json({
        error: "AI returned an empty response. Please try again."
      });
    }

    res.json({
      answer,
      provider,
      model: data.model || config.model
    });
  } catch (error) {
    console.error("ASAD AI error:", error);

    if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return res.status(504).json({
        error: "This provider took too long and was skipped. Try another model or provider."
      });
    }

    res.status(500).json({
      error: "Server error. Check your internet and restart the server."
    });
  }
});

app.listen(PORT, () => {
  console.log(`ASAD AI running at http://localhost:${PORT}`);
});
