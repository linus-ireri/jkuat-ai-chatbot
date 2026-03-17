import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";

const app = express();
app.set('trust proxy', 1); // Trust first proxy (ngrok)
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet());
// Disable x-powered-by
app.disable('x-powered-by');
// CORS (open for now, restrict in prod)
app.use(cors());
// Body size limit
app.use(express.json({ limit: '10kb' }));
// Rate limiting (DoS protection)
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // limit each IP to 20 requests per minute for testing
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

let vectorStore, embeddings;



async function loadRAG() {
  embeddings = new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2"
  });
  vectorStore = await HNSWLib.load("vector_store", embeddings);
  console.log("RAG vector store and embeddings loaded.");
}

app.post('/rag', async (req, res) => {
  const question = req.body.question;
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid question' });
  }
  try {
    const results = await vectorStore.similaritySearch(question, 3);
    const context = results.map((doc, i) => `Context #${i + 1}:\n${doc.pageContent}`);
    
    const systemPrompt = `You are the official Car&Gen.AI assistant for Car and General Kenya Ltd. Your role is to answer questions ONLY about Car and General Kenya Ltd, including products, services, branches, contact information, warranties, spare parts, and company operations. Use a concise, professional tone. Do not answer questions unrelated to Car and General; politely state you cannot help with unrelated topics and, when appropriate, suggest contacting Car & General's official channels (website or phone). Never identify yourself as an AI model or mention model providers.`;
    
    const systemPromptWithContext = systemPrompt + `\nGuidelines:\n1. Base answers ONLY on the retrieved context provided.\n2. Cite specific documents or sources from the context when referenced.\n3. If the context lacks relevant information, say "I don't have enough information about that in my knowledge base" and offer to direct the user to Car & General's official channels.\n4. Avoid speculation or inference.\n5. Keep answers concise and practical.`;
    
    const prompt = `Retrieved context: ${context.join(" ")}\n\nUser question: ${question}\n\nAnswer:`;

    // LLM call
    const apiKey = process.env.OPENROUTER_API_KEY;
    console.log("OPENROUTER_API_KEY:", process.env.OPENROUTER_API_KEY);
    if (!apiKey) {
      return res.status(500).json({ error: 'OPENROUTER_API_KEY not set in environment' });
    }
    const messages = [
      { role: "system", content: systemPromptWithContext },
      { role: "user", content: prompt }
    ];
    let answer = "";
    try {
      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model: "arcee-ai/trinity-large-preview:free",
          messages
        },
        {
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          timeout: 20000
        }
      );
      answer = response.data.choices?.[0]?.message?.content || "[No answer returned]";
    } catch (llmErr) {
      console.error('OpenRouter LLM error:', llmErr.response?.data || llmErr.message);
      return res.status(500).json({ error: 'LLM call failed', details: llmErr.response?.data || llmErr.message });
    }
    res.json({ context, prompt, answer });
  } catch (err) {
    console.error('RAG error:', err);
    res.status(500).json({ error: 'RAG retrieval failed' });
  }
});

// Provide a compatible /ask endpoint expected by Netlify functions
app.post('/ask', async (req, res) => {
  const question = req.body.question;
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid question' });
  }
  try {
    const results = await vectorStore.similaritySearch(question, 3);
    const context = results.map((doc, i) => `Context #${i + 1}:\n${doc.pageContent}`);

    const systemPrompt = `You are the official Car&Gen.AI assistant for Car and General Kenya Ltd.
     Your role is to answer questions ONLY about Car and General Kenya Ltd,
      including products, services, branches, contact information, warranties, spare parts, and company operations.
       Use a concise, professional tone. Do not answer questions unrelated to Car and General;
        politely state you cannot help with unrelated topics and, when appropriate, suggest contacting Car & General's official channels (website or phone).
         Never identify yourself as an AI model or mention model providers.`;
    
    const systemPromptWithContext = systemPrompt + `\nGuidelines:\n1. Base answers ONLY on the retrieved context provided.\n2. Cite specific documents or sources from the context when referenced.\n3. If the context lacks relevant information, say "I don't have enough information about that in my knowledge base" and offer to direct the user to Car & General's official channels.\n4. Avoid speculation or inference.\n5. Keep answers concise and practical.`;

    const prompt = `Retrieved context: ${context.join(" ")}\n\nUser question: ${question}\n\nAnswer:`;

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'OPENROUTER_API_KEY not set in environment' });
    }
    const messages = [
      { role: "system", content: systemPromptWithContext },
      { role: "user", content: prompt }
    ];

    let answer = "";
    try {
      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",

        { model: "arcee-ai/trinity-large-preview:free", messages },
        {
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          timeout: 20000
        }
      );
      answer = response.data.choices?.[0]?.message?.content || "[No answer returned]";
    } catch (llmErr) {
      console.error('OpenRouter LLM error:', llmErr.response?.data || llmErr.message);
      return res.status(500).json({ error: 'LLM call failed', details: llmErr.response?.data || llmErr.message });
    }

    // Align with Netlify functions expectations: { answer, context }
    res.json({ context, answer });
  } catch (err) {
    console.error('RAG error:', err);
    res.status(500).json({ error: 'RAG retrieval failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

loadRAG().then(() => {
  app.listen(PORT, () => {
    console.log(`RAG server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to load RAG:', err);
  process.exit(1);
});
