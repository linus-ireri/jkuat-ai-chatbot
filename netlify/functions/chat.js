const greetingResponses = {
  "who are you": "I am Veritas.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology. I can help with courses, campus directions, learning hours, academic programs, admissions, and student services. How can I assist you today?",
  "hello": "Hello! Welcome to Veritas.AI. Ask me about JKUAT courses, academic programs, campus directions, learning hours, admissions, or student services.",
  "hi": "Hi there! You're chatting with Veritas.AI. How can I help you with JKUAT today?",
  "hey": "Hello! This is Veritas.AI — I can answer questions about JKUAT courses, academic programs, campus directions, learning hours, and student information.",
  "how are you": "I'm here to help with JKUAT questions — what would you like to know about courses, campus, or student services?",
  "good morning": "Good morning! JKUAT.AI at your service — would you like information about courses, campus directions, or learning hours?",
  "good afternoon": "Good afternoon! Veritas.AI can help with courses, campus information, learning hours, and academic programs.",
  "good evening": "Good evening! Ask me about JKUAT courses, campus directions, learning hours, or student services."
};

const commonQueries = {
  "what do you do": "I assist with questions about JKUAT, including courses, academic programs, campus directions, learning hours, admissions, and student services.",
  "how can you help": "I can provide information about JKUAT courses, academic programs, campus directions, contact details, learning hours, and student services. Feel free to ask!",
  "what information do you have": "I have information about JKUAT's courses, academic programs, campus directions, learning hours, admissions requirements, and student services.",
  "help": "I can help you with JKUAT questions. Ask about our courses, academic programs, campus directions, learning hours, or student services."
};

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function getCannedReply(userMessage) {
  const normalized = normalize(userMessage);
  if (greetingResponses[normalized]) {
    return greetingResponses[normalized];
  }
  for (const [key, reply] of Object.entries(commonQueries)) {
    if (normalized.includes(normalize(key))) {
      return reply;
    }
  }
  return null;
}

/** Structured snippets for the LLM when RAG is unavailable (not used as final canned text). */
function buildRuleBasedContextBlock() {
  const greetingLines = Object.entries(greetingResponses).map(
    ([intent, text]) => `- When the user means "${intent}": ${text}`
  );
  const queryLines = Object.entries(commonQueries).map(
    ([intent, text]) => `- When the user asks about "${intent}": ${text}`
  );
  return [
    "Official reference snippets for common greetings and queries (match intent; you may paraphrase naturally while keeping the same facts and JKUAT focus):",
    "",
    "Greetings / identity:",
    ...greetingLines,
    "",
    "Common queries:",
    ...queryLines,
  ].join("\n");
}

function ragBaseAndAsk() {
  const raw = process.env.RAG_SERVER_URL;
  if (!raw || !String(raw).trim()) return { base: null, askUrl: null };
  const trimmed = String(raw).replace(/\/$/, "");
  if (/\/ask$/i.test(trimmed)) {
    const base = trimmed.replace(/\/ask$/i, "");
    return { base: base || trimmed, askUrl: trimmed };
  }
  return { base: trimmed, askUrl: `${trimmed}/ask` };
}

async function openRouterLlmWithRuleContext(userMessage, apiKey) {
  const ruleContext = buildRuleBasedContextBlock();
  const systemContent = `You are Veritas, the official JKUAT.AI assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Answer questions about JKUAT courses, programs, campus, admissions, and services. Be concise and professional. Document RAG is offline: use the reference snippets in the next message when they match the user's intent; for other JKUAT topics use general knowledge; for non-JKUAT topics, politely redirect.`;
  const llmRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "nvidia/nemotron-3-nano-30b-a3b:free",
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `Reference:\n${ruleContext}\n\nUser message: ${userMessage}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!llmRes.ok) {
    const errorText = await llmRes.text();
    console.error(`LLM fallback HTTP error ${llmRes.status}:`, errorText);
    return {
      reply:
        "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.",
      source: "llm-fallback-error",
    };
  }
  const llmData = await llmRes.json();
  const answer =
    llmData?.choices?.[0]?.message?.content?.trim() ||
    "Sorry, I do not have official information on that topic.";
  return { reply: answer, source: "llm-fallback" };
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { Allow: "POST", "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method Not Allowed. Use POST instead." }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const userMessage = body.message?.trim();

    if (!userMessage || typeof userMessage !== "string") {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Invalid request format. Expected a 'message' field with text.",
        }),
      };
    }

    console.log("Received user message:", userMessage);

    const { base: ragBase, askUrl: ragAskUrl } = ragBaseAndAsk();

    let ragIsHealthy = false;
    if (ragBase) {
      try {
        const healthCheck = await fetch(`${ragBase}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        ragIsHealthy = healthCheck.ok;
        console.log("RAG server health check:", ragIsHealthy ? "healthy" : "unhealthy");
      } catch (e) {
        console.error("RAG server health check failed:", e.message);
        ragIsHealthy = false;
      }
    } else {
      console.log("RAG_SERVER_URL not set; treating RAG as unavailable");
    }

    const jsonHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // RAG down: LLM answers using greetings + common queries as reference context
    if (!ragIsHealthy) {
      console.log("RAG server not available, using LLM with rule-based reference context");
      try {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          throw new Error("Missing OPENROUTER_API_KEY");
        }
        console.log("Making LLM call with rule context for:", userMessage.substring(0, 100) + "...");
        const { reply, source } = await openRouterLlmWithRuleContext(userMessage, apiKey);
        return {
          statusCode: 200,
          headers: jsonHeaders,
          body: JSON.stringify({ reply, context: [], source }),
        };
      } catch (llmErr) {
        console.error("LLM fallback error:", llmErr.message);
        const cannedReply = getCannedReply(userMessage);
        if (cannedReply) {
          return {
            statusCode: 200,
            headers: jsonHeaders,
            body: JSON.stringify({
              reply: cannedReply,
              context: [],
              source: "canned-after-llm-error",
            }),
          };
        }
        return {
          statusCode: 200,
          headers: jsonHeaders,
          body: JSON.stringify({
            reply:
              "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.",
            context: [],
            source: "error",
          }),
        };
      }
    }

    // RAG is healthy, attempt RAG server
    let response;
    try {
      response = await fetch(ragAskUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: userMessage
        }),
        signal: AbortSignal.timeout(5000)
      });
    } catch (e) {
      console.error("RAG server error:", e.message);
      response = undefined;
    }

    if (!response || !response.ok) {
      console.error("RAG server request failed, falling back to LLM with rule-based context");
      try {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          throw new Error("Missing OPENROUTER_API_KEY");
        }
        const { reply, source } = await openRouterLlmWithRuleContext(userMessage, apiKey);
        return {
          statusCode: 200,
          headers: jsonHeaders,
          body: JSON.stringify({ reply, context: [], source }),
        };
      } catch (llmErr) {
        console.error("LLM fallback error:", llmErr.message);
        const cannedReply = getCannedReply(userMessage);
        if (cannedReply) {
          return {
            statusCode: 200,
            headers: jsonHeaders,
            body: JSON.stringify({
              reply: cannedReply,
              context: [],
              source: "canned-after-llm-error",
            }),
          };
        }
        return {
          statusCode: 200,
          headers: jsonHeaders,
          body: JSON.stringify({
            reply:
              "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.",
            context: [],
            source: "error",
          }),
        };
      }
    }

    const data = await response.json();
    console.log("RAG Response:", data);

const cleanedReply = data?.answer?.trim() || "Hello! I'm Veritas, the official JKUAT AI assistant. Ask me about JKUAT courses, campus directions, learning hours, academic programs, admissions, or student services.";

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
      },
      body: JSON.stringify({ reply: cleanedReply, context: data?.context || [], source: "rag" }),
    };
  } catch (error) {
    console.error("Server Error:", error.message);
    const cannedReply = getCannedReply(body.message || "");
    if (cannedReply) {
      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
        },
        body: JSON.stringify({ reply: cannedReply, context: [], source: "canned-fallback" }),
      };
    }
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server Error: " + error.message }),
    };
  }
}
