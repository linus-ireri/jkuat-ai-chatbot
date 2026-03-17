// ingest.js
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import fs from "fs";
import path from "path";

// ===============================
// 📁 SOURCE FILES & CONFIG
// ===============================
const pdfPaths = [
  "./docs/MCS_timetable.pdf",
];

const urls = [
  "https://jkuat-ai.netlify.app/"
];

const VECTOR_STORE_PATH = "./vector_store";


// 🧠 LOADERS
async function loadPDFs() {
  console.log("📄 Loading PDFs...");
  const docs = [];

  for (const pdfPath of pdfPaths) {
    try {
      if (!fs.existsSync(pdfPath)) {
        console.warn(`⚠️  Skipping missing file: ${pdfPath}`);
        continue;
      }

      console.log(`  Loading: ${path.basename(pdfPath)}`);
      const loader = new PDFLoader(pdfPath, {
        splitPages: true,
      });

      const pdfDocs = await loader.load();

      const actName = path.basename(pdfPath)
        .replace(/\.pdf$/i, "")
        .replace(/_/g, " ")
        .trim();

      pdfDocs.forEach(doc => {
        doc.metadata = {
          ...doc.metadata,
          source: actName,
          type: "pdf"
        };
      });

      docs.push(...pdfDocs);
      console.log(`  ✓ Loaded ${pdfDocs.length} pages`);
    } catch (error) {
      console.error(`  ✗ Error loading ${pdfPath}:`, error.message);
    }
  }

  return docs;
}

async function loadURLs() {
  console.log("\n🌐 Loading URLs...");
  const docs = [];

  for (const url of urls) {
    try {
      console.log(`  Scraping: ${url}`);
      const loader = new CheerioWebBaseLoader(url);
      const urlDocs = await loader.load();

      urlDocs.forEach(doc => {
        doc.metadata = {
          ...doc.metadata,
          source: url,
          type: "web"
        };
      });

      docs.push(...urlDocs);
      console.log(`  ✓ Loaded ${urlDocs.length} documents`);
    } catch (error) {
      console.error(`  ✗ Error loading ${url}:`, error.message);
    }
  }

  return docs;
}

// ===============================
// 🧩 MAIN INGESTION PIPELINE
// ===============================
async function main() {
  console.log("🚀 Starting RAG ingestion pipeline...\n");

  // 1. Load all sources
  const pdfDocs = await loadPDFs();
  const urlDocs = await loadURLs();
  const allDocs = [...pdfDocs, ...urlDocs];

  if (allDocs.length === 0) {
    console.error("❌ No documents loaded. Exiting.");
    process.exit(1);
  }

  console.log(`\n📊 Total documents loaded: ${allDocs.length}`);

  // 2. Smart splitting for legal documents
  console.log("\n✂️  Splitting documents into structured chunks...");
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 700,
    chunkOverlap: 100,
    separators: ["\nSection ", "\nPART ", "\nCHAPTER ", "\n\n", ". "]
  });

  const splitDocs = await splitter.splitDocuments(allDocs);
  console.log(`  ✓ Created ${splitDocs.length} section-based chunks`);

  // 3. Clean and normalize
  const cleanDocs = splitDocs.map(doc => {
    doc.pageContent = doc.pageContent
      .replace(/Page\s\d+\sof\s\d+/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    return doc;
  });

  // 4. Initialize embeddings model (CPU-optimized)
  console.log("\n🤖 Loading embedding model...");
  const embeddings = new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2",
    batchSize: 8 // ✅ small batch size prevents memory errors
  });

  // 5. Create vector store incrementally
  console.log("\n🔢 Creating vector store in safe batches...");
  if (!fs.existsSync(VECTOR_STORE_PATH)) {
    fs.mkdirSync(VECTOR_STORE_PATH, { recursive: true });
  }

  const vectorStore = await HNSWLib.fromDocuments([], embeddings);

  const BATCH_SIZE = 50;
  for (let i = 0; i < cleanDocs.length; i += BATCH_SIZE) {
    const batch = cleanDocs.slice(i, i + BATCH_SIZE);
    console.log(`  → Processing batch ${Math.ceil(i / BATCH_SIZE) + 1}/${Math.ceil(cleanDocs.length / BATCH_SIZE)}...`);
    await vectorStore.addDocuments(batch);
    global.gc?.(); // Force garbage collection if available
  }

  await vectorStore.save(VECTOR_STORE_PATH);
  console.log(`\n💾 Vector store saved to: ${VECTOR_STORE_PATH}`);

  // 6. Summary
  console.log("\n✅ Ingestion complete!");
  console.log("📈 Summary:");
  console.log(`  - PDFs processed: ${pdfPaths.length}`);
  console.log(`  - URLs scraped: ${urls.length}`);
  console.log(`  - Total chunks: ${cleanDocs.length}`);
  console.log(`  - Vector store location: ${VECTOR_STORE_PATH}`);
}

main().catch(err => {
  console.error("\n❌ Ingestion failed:");
  console.error(err);
  process.exit(1);
});
