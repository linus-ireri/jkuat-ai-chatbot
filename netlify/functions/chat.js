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

    // Attempt RAG server first
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
      console.error("RAG server not available, falling back to LLM");
      // Fallback to LLM directly (OpenRouter) if RAG is down
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
            model: "arcee-ai/trinity-large-preview:free",
            messages: [
              { role: "system", content: `You are the official Car&Gen.AI assistant for Car and General Kenya Ltd. Your role is to answer questions ONLY about Car and General Kenya Ltd, including products, services, branches, contact information, warranties, spare parts, and company operations. Use a concise, professional tone. Do not answer questions unrelated to Car and General; politely state you cannot help with unrelated topics and, when appropriate, suggest contacting Car & General's official channels. Never identify yourself as an AI model or mention model providers.` },
              { role: "user", content: userMessage }
            ]
          }),
          signal: AbortSignal.timeout(6000)
        });
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
          body: JSON.stringify({ reply: "I'm experiencing issues right now. Please try again in a few moments.", context: [], source: "error" }),
        };
      }
    }

    const data = await response.json();
    console.log("RAG Response:", data);

    const cleanedReply = data?.answer?.trim() || "Hello! I'm Car&Gen.AI, the official Car and General assistant. Ask me about Car & General products, services, branches, contact information, warranties, or spare parts.";

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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server Error: " + error.message }),
    };
  }
}