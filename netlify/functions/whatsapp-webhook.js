const axios = require('axios');

const greetingResponses = {
  "who are you": "I am Veritas.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology. I can help with courses, campus directions, learning hours, academic programs, admissions, and student services. How can I assist you today?",
  "who are you?": "I am veritas.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology. I can help with courses, campus directions, learning hours, academic programs, admissions, and student services. How can I assist you today?",
  "hello": "Hello! Welcome to Veritas.AI. Ask me about JKUAT courses, academic programs, campus directions, learning hours, admissions, or student services.",
  "hi": "Hi there! You're chatting with Veritas.AI. How can I help with JKUAT today?",
  "hey": "Hello! This is Veritas.AI — I can answer questions about JKUAT courses, academic programs, campus directions, learning hours, and student information.",
  "how are you": "I'm here to help with JKUAT questions — what would you like to know about courses, campus, or student services?",
  "how are you?": "I'm here to help with JKUAT questions — what would you like to know about courses, campus, or student services?",
  "good morning": "Good morning! JKUAT.AI at your service — would you like information about courses, campus directions, or learning hours?",
  "good afternoon": "Good afternoon! Veritas.AI can help with courses, campus information, learning hours, and academic programs.",
  "good evening": "Good evening! Ask me about JKUAT courses, campus directions, learning hours, or student services."
};



// Common JKUAT queries - basic info only, detailed answers come from RAG
const commonQueries = {
  "what do you do": "I assist with questions about JKUAT, including courses, academic programs, campus directions, learning hours, admissions, and student services.",
  "how can you help": "I can provide information about JKUAT courses, academic programs, campus directions, contact details, learning hours, and student services. Feel free to ask!",
  "what information do you have": "I have information about JKUAT's courses, academic programs, campus directions, learning hours, admissions requirements, and student services.",
  "help": "I can help you with JKUAT questions. Ask about our courses, academic programs, campus directions, learning hours, or student services."
};

// Lino AI canned responses (fallback / cached QA). If you have a separate
// source for JKUAT-specific Q&A, load or replace this object accordingly.
const linoAIResponses = {
  ...commonQueries
};

exports.handler = async function(event, context) {
  // Webhook verification (GET request from Meta)
  if (event.httpMethod === "GET") {
    const params = event.queryStringParameters;
    const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
    
    if (!VERIFY_TOKEN) {
      console.error("WHATSAPP_VERIFY_TOKEN not configured");
      return {
        statusCode: 500,
        body: "Server configuration error"
      };
    }


    if (params["hub.mode"] === "subscribe" && params["hub.verify_token"] === VERIFY_TOKEN) {
      return {
        statusCode: 200,
        body: params["hub.challenge"]
      };
    } else {
      return {
        statusCode: 403,
        body: "Verification failed"
      };
    }
  }

  // Handle incoming messages (POST request from Meta)
  if (event.httpMethod === "POST") {
    try {
      const body = JSON.parse(event.body);
      console.log("Received WhatsApp webhook:", JSON.stringify(body, null, 2));

      // Extract message data
      if (body.object === "whatsapp_business_account" && body.entry && body.entry.length > 0) {
        const entry = body.entry[0];
        if (entry.changes && entry.changes.length > 0) {
          const change = entry.changes[0];
          if (change.value && change.value.messages && change.value.messages.length > 0) {
            const message = change.value.messages[0];
            const from = message.from; // Sender's phone number
            const text = message.text ? message.text.body : "";

            console.log(`Message from ${from}: ${text}`);

            // Process message with health check and fallbacks
            const response = await processMessage(text, from);
            
            // Send response back to WhatsApp
            await sendWhatsAppMessage(from, response);

            return {
              statusCode: 200,
              body: "Message processed"
            };
          }
        }
      }

      return {
        statusCode: 200,
        body: "Event received"
      };

    } catch (error) {
      console.error("Error processing webhook:", error);
      return {
        statusCode: 500,
        body: "Internal server error"
      };
    }
  }

  return {
    statusCode: 405,
    body: "Method Not Allowed"
  };
};

// Function to process message with health check and fallbacks
async function processMessage(message, from) {
  const normalizedMessage = normalize(message); // lower-cased, punctuation-stripped

  let ragIsHealthy = false;
  const ragBase = ragBaseUrl();
  try {
    if (ragBase) {
      await axios.get(`${ragBase}/health`, { timeout: 1000 });
      ragIsHealthy = true;
      console.log("RAG server is healthy");
    } else {
      console.log("RAG_SERVER_URL not set; using LLM with rule-based reference context");
    }
  } catch (healthError) {
    console.log("RAG server health check failed, will use fallback mode");
    ragIsHealthy = false;
  }

  if (!ragIsHealthy) {
    console.log("Using fallback mode without RAG (LLM + greeting/common reference context)");
    try {
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY not set in environment");
      }
      const ruleContext = buildRuleBasedContextBlock();
      const systemPrompt = `You are Veritas.AI, the official AI assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Document RAG is offline: use the reference snippets in the next message when they match the user's intent; for other JKUAT topics use general knowledge. Be concise and professional. For non-JKUAT questions, redirect politely to JKUAT topics.`;

      const messages = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `Reference:\n${ruleContext}\n\nUser message: ${message}`,
        },
      ];
      try {
        console.log("Making LLM fallback call for message:", message.substring(0, 100) + "...");
        const response = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model: "nvidia/nemotron-3-nano-30b-a3b:free",
            messages,
            max_tokens: 150,
            temperature: 0.7
          },
          {
            headers: {
              "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json"
            },
            timeout: 8000 // 8 seconds timeout for LLM fallback
          }
        );
        const answer = response.data.choices?.[0]?.message?.content?.trim();
        console.log("LLM response received, length:", answer?.length || 0);
        console.log("Full response data:", JSON.stringify(response.data, null, 2));
        return answer || "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
      } catch (llmError) {
        console.error("Fallback LLM error:", llmError.response?.status, llmError.response?.data || llmError.message);
        return "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.";
      }
    } catch (error) {
      console.error("Error in LLM fallback when RAG is down:", error);
      return "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
    }
  }

  if (greetingResponses[normalizedMessage]) {
    return greetingResponses[normalizedMessage];
  }

  // If RAG is healthy, proceed with RAG
  try{
    const RAG_SERVER_URL = process.env.RAG_SERVER_URL;
    if (!RAG_SERVER_URL) {
      throw new Error("RAG_SERVER_URL not set in environment");
    }
    const ragResponse = await axios.post(
      `${RAG_SERVER_URL}/rag`,
      { question: message },
      { timeout: 5000 } // 5 seconds timeout for RAG retrieval when up
    );

    // If answer is present, return it
    if (ragResponse.data && ragResponse.data.answer) {
      return ragResponse.data.answer;
    }

    // If no answer, but context exists, use it in LLM fallback
    const retrievedContext = ragResponse.data && ragResponse.data.context;
    if (retrievedContext) {
      // --- LLM must answer ONLY from retrieved RAG context ---
      try {
        if (!process.env.OPENROUTER_API_KEY) {
          throw new Error("OPENROUTER_API_KEY not set in environment");
        }
        const systemPrompt = `You are Veritas.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Your role is to answer questions ONLY about JKUAT, including courses offered, academic programs, campus directions, learning hours, admissions requirements, student services, facilities, and university operations. Base answers ONLY on the retrieved context provided. If the context lacks relevant information, say "I don't have enough information about that in my knowledge base. Please contact JKUAT's official enquiries for detailed assistance." For questions unrelated to JKUAT, politely redirect: "I appreciate your question, but I'm specifically designed to assist with JKUAT-related inquiries. How can I help you with JKUAT?" Never identify yourself as an AI model or mention model providers.`;
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Retrieved context: ${Array.isArray(retrievedContext) ? retrievedContext.join(" ") : retrievedContext}` },
          { role: "user", content: message }
        ];
        const response = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          { model: "nvidia/nemotron-3-nano-30b-a3b:free", messages },
          {
            headers: {
              'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
              'Content-Type': 'application/json'
            },
            timeout: 8000 // 8 seconds timeout for LLM fallback
          }
        );
        const answer = response.data.choices?.[0]?.message?.content?.trim();
        return answer || "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
      } catch (llmError) {
        console.error("Error in LLM request:", llmError);
        return "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
      }
    }

    // If no context, fall back to FAQ/cached info as context
    const allFaqs = [
      ...Object.values(greetingResponses),
      ...Object.values(linoAIResponses)
    ].join(" ");
    try {
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY not set in environment");
      }
      const systemPrompt = `You are Veritas.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Your role is to answer questions ONLY about JKUAT using the official information provided. Do not speculate and do not use general knowledge. If the information is not present, say you do not have official information about that topic. For questions unrelated to JKUAT, politely redirect the user to JKUAT-related topics. Never identify yourself as an AI model or mention model providers.`;
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Official information: ${allFaqs}` },
        { role: "user", content: message }
      ];
      try {
        const response = await axios.post(
          "https://openrouter.ai/api/v1/chat/completions",
          {
            model: "nvidia/nemotron-3-nano-30b-a3b:free",
            messages
          },
          {
            headers: {
              "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
              "Content-Type": "application/json"
            },
            timeout: 8000 // 8 seconds timeout for LLM fallback
          }
        );
        const answer = response.data.choices?.[0]?.message?.content?.trim();
        return answer || "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
      } catch (llmError) {
        console.error("Error in LLM request:", llmError.response?.status, llmError.response?.data || llmError.message);
        return "I'm currently unable to answer because the AI service is temporarily unavailable. Please try again shortly.";
      }
    } catch (error) {
      console.error("Error in fallback LLM request:", error);
      return "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
    }
  } catch (error) {
    console.error("Error in RAG request:", error);
    // If RAG fails, proceed with LLM fallback using greetings and common query context
    try {
      if (!process.env.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY not set in environment");
      }
      const allFaqs = [
        ...Object.values(greetingResponses),
        ...Object.values(commonQueries)
      ].join(" ");
      const systemPrompt = `You are Veritas.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Your primary role is to answer questions about JKUAT. For JKUAT questions, answer based on available information or suggest contacting official channels. For non-JKUAT questions, politely redirect: "I appreciate your question, but I'm specifically designed to assist with JKUAT-related inquiries. How can I help you with JKUAT?" Never identify yourself as an AI model or mention model providers.`;
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: message }
      ];
      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        { model: "nvidia/nemotron-3-nano-30b-a3b:free", messages },
        {
          headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000 // 8 seconds timeout for LLM fallback
        }
      );
      const answer = response.data.choices?.[0]?.message?.content?.trim();
      return answer || "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
    } catch (llmError) {
      console.error("Error in LLM fallback:", llmError);
      return "I'm experiencing high traffic right now and can't answer this question at the moment. Please try again in a few minutes!";
    }
  }
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

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

function ragBaseUrl() {
  const raw = process.env.RAG_SERVER_URL;
  if (!raw || !String(raw).trim()) return null;
  const t = String(raw).replace(/\/$/, "");
  if (/\/ask$/i.test(t)) return t.replace(/\/ask$/i, "") || t;
  return t;
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

// Function to send message back to WhatsApp
async function sendWhatsAppMessage(to, message) {
  try {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneNumberId) {
      console.error("Missing WhatsApp credentials");
      return;
    }

    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: message }
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("WhatsApp message sent:", response.data);
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
  }
}
