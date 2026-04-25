// rag.js
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("🚀 Loading vector store...");
  const embeddings = new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2"
  });

  const vectorStore = await HNSWLib.load("vector_store", embeddings);

  // 🔍 Example question (replace or pass dynamically)
  const question = "What courses are offered at JKUAT?";

  console.log("\n🔎 Retrieving relevant context...");
  const results = await vectorStore.similaritySearch(question, 5);

  if (results.length === 0) {
    console.error("❌ No relevant context found. Exiting.");
    process.exit(1);
  }

  const context = results
    .map((doc, i) => `Context #${i + 1}:\n${doc.pageContent}`)
    .join("\n\n");

  // 🧠 Strict, structured prompt to prevent hallucination
  const prompt = `
You are VeritasRAG.AI, the official AI assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Your job is to answer the user's question *strictly and only* based on the provided context about JKUAT.

If the answer cannot be found exactly in the context, respond with:
"I don't have that information in my knowledge base. Please contact JKUAT's official channels for assistance."

Follow these rules:
- Do NOT invent or assume information.
- Quote exact information about courses, academic programs, campus directions, learning hours, admissions when available.
- Never mix information from outside the retrieved context.
- Maintain a professional, helpful, and factual tone.
- Always reference JKUAT when answering.

-----------------------
Retrieved Context:
${context}
-----------------------

User Question: ${question}

Answer:
`;

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("❌ OPENROUTER_API_KEY is not set.");
    process.exit(1);
  }

  try {
    console.log("\n💬 Querying LLM...");
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "google/gemma-4-26b-a4b-it:free",
        messages: [
          { role: "system", content: "You are VeritasRAG.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). Answer questions accurately based only on provided context about JKUAT's courses, academic programs, campus information, and university operations." },
         
          { role: "user", content: prompt }
        ],
        temperature: 0.1, // 🔒 ensures factuality with minimal variation
        max_tokens: 500
      },
      {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const answer = response.data?.choices?.[0]?.message?.content?.trim() || "[No answer returned]";
    console.log("\n----- LLM Answer -----\n");
    console.log(answer);
  } catch (err) {
    console.error("\n❌ Error calling OpenRouter:");
    console.error(err.response?.data || err.message);
  }
}

main().catch(err => {
  console.error("❌ Fatal Error:", err);
  process.exit(1);
});
