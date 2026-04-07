const axios = require("axios");

// --- Environment Variable Check ---
if (!process.env.OPENROUTER_API_KEY) {
  throw new Error("OPENROUTER_API_KEY is not configured. Please check your environment variables.");
}

// --- Constants ---
const RAG_SERVER_URL = process.env.RAG_SERVER_URL; // optional: if missing, we'll skip RAG and use LLM fallback
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const GREETING_RESPONSES = {
  "who are you": "I am Veritas.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology. I can help with courses, campus directions, learning hours, academic programs, admissions, and student services. How can I assist you today?",
  "hello": "Hello! Welcome to Veritas.AI. Ask me about JKUAT courses, campus directions, learning hours, academic programs, admissions, or student services.",
  "hi": "Hi there! You're chatting with Veritas.AI. How can I help with JKUAT information today?",
  "hey": "Hello! This is Veritas.AI — I can answer questions about JKUAT courses, campus directions, learning hours, academic programs, and student information.",
  "how are you": "I'm here to help with JKUAT questions — what would you like to know about courses, campus, or student services?",
  "good morning": "Good morning! Veritas.AI at your service — would you like information about courses, campus directions, or learning hours?",
  "good afternoon": "Good afternoon! Veritas.AI can help with courses, campus information, learning hours, and academic programs.",
  "good evening": "Good evening! Ask me about JKUAT courses, campus directions, learning hours, or student services."
};

// --- System prompt (hard-coded) 
// This prompt focuses the assistant exclusively on JKUAT.
const SYSTEM_PROMPT = `You are Veritas, the official JKUAT AI assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT).
 Your role is to answer questions ONLY about JKUAT, including courses offered, academic programs, campus directions, learning hours, admissions requirements, student services, facilities, and university operations. 
 Use a concise, professional tone. Do not answer questions unrelated to JKUAT; politely state you cannot help with unrelated topics and, when appropriate, suggest contacting JKUAT's official channels (website or phone).
  Never identify yourself as an AI model or mention model providers.`;

// --- Helper Functions ---

/**
 * Normalizes a string by converting it to lowercase, removing special characters, and trimming whitespace.
 * @param {string} text - The text to normalize.
 * @returns {string} The normalized text.
 */
function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Handles rule-based responses for common greetings.
 * @param {string} normalizedMessage - The normalized user message.
 * @returns {object|null} A response object or null if no greeting is matched.
 */
function getGreetingResponse(normalizedMessage) {
  if (GREETING_RESPONSES[normalizedMessage]) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: GREETING_RESPONSES[normalizedMessage],
        context: [],
        source: "rule-based"
      }),
    };
  }
  return null;
}

/**
 * Queries the RAG server for an answer.
 * @param {string} userMessage - The user's message.
 * @returns {Promise<object|null>} The RAG server's response or null on error.
 */
async function queryRagServer(userMessage) {
  try {
    if (!RAG_SERVER_URL) {
      return null;
    }
    // Use the configured endpoint as-is; expected to be '/ask'
    const ragUrl = RAG_SERVER_URL;
    console.log("Querying RAG server at:", ragUrl);
    const ragResponse = await axios.post(
      ragUrl,
      { question: userMessage },
      { timeout: 4000 } // keep RAG call short to fit Netlify's 10s limit
    );
    return ragResponse.data;
  } catch (error) {
    console.error("RAG server error:", error.message);
    return null;
  }
}

/**
 * Queries the LLM with context from the RAG server.
 * @param {string} userMessage - The user's message.
 * @param {Array<string>} context - The context from the RAG server.
 * @returns {Promise<object>} The LLM's response.
 */
async function queryLlmWithContext(userMessage, context) {
  const systemPrompt = SYSTEM_PROMPT + `\nGuidelines:\n1. Base answers ONLY on the retrieved context provided.\n2. Cite specific documents or sources from the context when referenced.\n
  3. If the context lacks relevant information, say "I don't have enough information about that in my knowledge base. Please contact JKUAT's official enquiries for detailed assistance."\n
  4. For questions unrelated to JKUAT, politely redirect: "I appreciate your question, but I'm specifically designed to assist with JKUAT-related inquiries. How can I help you with JKUAT?"\n
  5. Avoid speculation or inference.\n
  6. Respond to greetings politely and ask back how the user is. Keep answers concise and practical and be jovial to keep conversation lively.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Retrieved context: ${context.join(" ")}` },
    { role: "user", content: userMessage }
  ];

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      { model: "arcee-ai/trinity-large-preview:free", messages },
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 6000
      }
    );
    const answer = response.data.choices?.[0]?.message?.content?.trim();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: answer || "Sorry, I do not have official information on that topic.",
        context: context,
        source: "rag+llm"
      }),
    };
  } catch (error) {
    console.error("LLM with context error:", error.message);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "Sorry, I do not have official information on that topic.",
        context: context,
        source: "rag+llm-fallback"
      }),
    };
  }
}

/**
 * Queries the LLM as a fallback when the RAG server fails.
 * @param {string} userMessage - The user's message.
 * @returns {Promise<object>} The LLM's response.
 */
async function queryLlmFallback(userMessage) {
  const systemPrompt = SYSTEM_PROMPT + `\nNo-context guidance: For JKUAT questions with no context available, answer based on general knowledge about the university or suggest contacting JKUAT's official enquiries. For non-JKUAT questions, politely redirect: "I appreciate your question, but I'm specifically designed to assist with JKUAT-related inquiries. How can I help you with JKUAT?"`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "arcee-ai/trinity-large-preview:free",
        messages
      },
      {
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 3000
      }
    );
    const answer = response.data.choices?.[0]?.message?.content?.trim();
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: answer || "Sorry, I do not have official information on that topic.",
        context: [],
        source: "llm-fallback"
      }),
    };
  } catch (error) {
    console.error("LLM fallback error:", error.message);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply: "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!",
        context: [],
        source: "rule-fallback"
      }),
    };
  }
}

// --- Main Handler ---

exports.handler = async function (event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method Not Allowed. Use POST instead." }),
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const userMessage = body.message?.trim();

    if (!userMessage || typeof userMessage !== "string") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid request format. Expected a 'message' field with text." }),
      };
    }

    const normalizedMessage = normalize(userMessage);

    // 1) Greetings: return rule-based reply
    const greetingResponse = getGreetingResponse(normalizedMessage);
    if (greetingResponse) {
      return greetingResponse;
    }

    // 2) Health check RAG server before attempting to use it
    let ragIsHealthy = false;
    try {
      if (RAG_SERVER_URL) {
        await axios.get(`${RAG_SERVER_URL}/health`, { timeout: 1000 });
        ragIsHealthy = true;
        console.log("RAG server is healthy");
      }
    } catch (healthError) {
      console.log("RAG server health check failed, will use LLM fallback");
      ragIsHealthy = false;
    }

    // If RAG is not healthy, use LLM fallback
    if (!ragIsHealthy) {
      return await queryLlmFallback(userMessage);
    }

    // 3) Query RAG server at /ask
    const ragData = await queryRagServer(userMessage);
    if (ragData) {
      if (ragData.answer) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reply: ragData.answer, context: ragData.context || [], source: "rag" }),
        };
      }
      if (ragData.context && Array.isArray(ragData.context) && ragData.context.length > 0) {
        // 4) LLM with context if no direct answer
        return await queryLlmWithContext(userMessage, ragData.context);
      }
    }

    // 5) Fallback LLM without context
    return await queryLlmFallback(userMessage);

  } catch (error) {
    console.error("Unexpected error:", error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Unexpected error", details: error.message }),
    };
  }
};