// retrieve.js
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import fs from "fs";

async function main() {
  console.log(" Initializing retrieval...");

  // 1. Ensure vector store exists
  const VECTOR_STORE_PATH = "vector_store";
  if (!fs.existsSync(VECTOR_STORE_PATH)) {
    console.error(` Vector store not found at: ${VECTOR_STORE_PATH}`);
    console.error("Run 'node ingest.js' first to build it.");
    process.exit(1);
  }

  // 2. Load embeddings and vector store
  console.log(" Loading embeddings model and vector store...");
  const embeddings = new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2"
  });

  const vectorStore = await HNSWLib.load(VECTOR_STORE_PATH, embeddings);
  console.log(" Vector store loaded successfully.");

  // 3. Define a user query (you can replace or pass dynamically)
  const query = "What products and services does Car and General Kenya Ltd offer?";

  console.log(`\n Searching top 5 most relevant chunks for:\n"${query}"\n`);

  // 4. Retrieve top-k relevant chunks
  const results = await vectorStore.similaritySearch(query, 5);

  if (!results.length) {
    console.warn(" No matching results found. Try re-ingesting or adjusting embeddings.");
    process.exit(0);
  }

  // 5. Display results clearly
  console.log(` Retrieved ${results.length} relevant chunk(s):\n`);
  results.forEach((doc, i) => {
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`🧩 Result #${i + 1}`);
    console.log(`📄 Source: ${doc.metadata?.source || "Unknown document"}`);
    console.log(`🔢 Score: ${doc.score ?? "N/A"}`);
    console.log(`📜 Content Preview:\n${doc.pageContent.slice(0, 700)}\n`);
  });

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("✅ Retrieval complete. Inspect the context to verify factual content before sending it to the LLM.");
}

main().catch(err => {
  console.error("\n❌ Retrieval failed:");
  console.error(err);
  process.exit(1);
});
