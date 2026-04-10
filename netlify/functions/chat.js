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

    // First, check RAG server health
    let ragIsHealthy = false;
    try {
      const ragUrl = process.env.RAG_SERVER_URL || "http://localhost:3001";
      const healthCheck = await fetch(`${ragUrl}/health`, {
        signal: AbortSignal.timeout(1000)
      });
      ragIsHealthy = healthCheck.ok;
      console.log("RAG server health check:", ragIsHealthy ? "healthy" : "unhealthy");
    } catch (e) {
      console.error("RAG server health check failed:", e.message);
      ragIsHealthy = false;
    }

    // If RAG is not healthy, use LLM fallback
    if (!ragIsHealthy) {
      console.log("RAG server not available, using LLM fallback");
      const cannedReply = getCannedReply(userMessage);
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
      const allFaqs = [
        ...Object.values(greetingResponses),
        ...Object.values(commonQueries)
      ].join(" ");
      try {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          throw new Error("Missing OPENROUTER_API_KEY");
        }
        const llmRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "meta-llama/llama-3.2-3b-instruct:free",
            messages: [
              { role: "system", content: `You are Veritas, the official JKUAT.AI assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Your role is to answer questions ONLY about JKUAT, including courses offered, academic programs, campus directions, learning hours, admissions requirements, student services, facilities, and university operations. Use a concise, professional tone. For questions unrelated to JKUAT, politely redirect: "I appreciate your question, but I'm specifically designed to assist with JKUAT-related inquiries. How can I help you with JKUAT?" Never identify yourself as an AI model or mention model providers.` },
              { role: "user", content: `Official JKUAT information: ${allFaqs}` },
              { role: "user", content: userMessage }
            ]
          }),
          signal: AbortSignal.timeout(6000)
        });
        if (!llmRes.ok) {
          const errorText = await llmRes.text();
          console.error(`LLM fallback HTTP error ${llmRes.status}:`, errorText);
          return {
            statusCode: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type",
            },
            body: JSON.stringify({ reply: "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.", context: [], source: "llm-fallback-error" }),
          };
        }
        const llmData = await llmRes.json();
        const answer = llmData?.choices?.[0]?.message?.content?.trim() || "Sorry, I do not have official information on that topic.";
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
          },
          body: JSON.stringify({ reply: answer, context: [], source: "llm-fallback" }),
        };
      } catch (llmErr) {
        console.error("LLM fallback error:", llmErr.message);
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
          },
          body: JSON.stringify({ reply: "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.", context: [], source: "error" }),
        };
      }
    }

    // RAG is healthy, attempt RAG server
    let response;
    try {
      response = await fetch(process.env.RAG_SERVER_URL || "http://localhost:3001/ask", {
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
      console.error("RAG server request failed, falling back to LLM");
      const cannedReply = getCannedReply(userMessage);
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
      const allFaqs = [
        ...Object.values(greetingResponses),
        ...Object.values(commonQueries)
      ].join(" ");
      // Fallback to LLM directly (OpenRouter) if RAG request fails
      try {
        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
          throw new Error("Missing OPENROUTER_API_KEY");
        }
        const llmRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "meta-llama/llama-3.2-3b-instruct:free",
            messages: [
              { role: "system", content: `You are Veritas, the official JKUAT AI assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Your role is to answer questions ONLY about JKUAT, including courses offered, academic programs, campus directions, learning hours, admissions requirements, student services, facilities, and university operations. Use a concise, professional tone. For questions unrelated to JKUAT, politely redirect: "I appreciate your question, but I'm specifically designed to assist with JKUAT-related inquiries. How can I help you with JKUAT?" Never identify yourself as an AI model or mention model providers.` },
              { role: "user", content: `Official JKUAT information: ${allFaqs}` },
              { role: "user", content: userMessage }
            ]
          }),
          signal: AbortSignal.timeout(6000)
        });
        if (!llmRes.ok) {
          const errorText = await llmRes.text();
          console.error(`LLM fallback HTTP error ${llmRes.status}:`, errorText);
          return {
            statusCode: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "Content-Type",
            },
            body: JSON.stringify({ reply: "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.", context: [], source: "llm-fallback-error" }),
          };
        }
        const llmData = await llmRes.json();
        const answer = llmData?.choices?.[0]?.message?.content?.trim() || "Sorry, I do not have official information on that topic.";
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
          },
          body: JSON.stringify({ reply: answer, context: [], source: "llm-fallback" }),
        };
      } catch (llmErr) {
        console.error("LLM fallback error:", llmErr.message);
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type",
          },
          body: JSON.stringify({ reply: "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.", context: [], source: "error" }),
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