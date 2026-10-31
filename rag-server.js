import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";
import { Document } from '@langchain/core/documents';

import { cleanLlmAnswer } from './lib/clean-llm-answer.js';
import { createVeritasRouter } from './lib/veritas-rag/routes.js';
import { loadWhisper } from './lib/veritas-rag/voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // Trust first proxy (ngrok)
const PORT = process.env.PORT || 3001;

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // static UI served separately / with own CSP
}));
// Disable x-powered-by
app.disable('x-powered-by');
// CORS (open for now, restrict in prod)
app.use(cors());
// Body size limit (uploads use multipart; JSON kept modest)
app.use(express.json({ limit: '256kb' }));
// Rate limiting (DoS protection) — higher budget for VeritasRAG demo traffic
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

let vectorStore, embeddings;

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isGreetingMessage(text) {
  const normalized = normalize(text);
  return /^(hi|hello|hey|how are you|good morning|good afternoon|good evening|who are you|who are you\?)/.test(normalized);
}

async function ensureRootVectorStore() {
  const storeDir = path.join(__dirname, 'vector_store');
  const argsPath = path.join(storeDir, 'args.json');
  const indexPath = path.join(storeDir, 'hnswlib.index');

  if (fs.existsSync(argsPath) && fs.existsSync(indexPath)) {
    return;
  }

  fs.mkdirSync(storeDir, { recursive: true });

  const placeholderEmbeddings = new HuggingFaceTransformersEmbeddings({
    modelName: 'Xenova/all-MiniLM-L6-v2',
  });

  const placeholderStore = await HNSWLib.fromDocuments(
    [new Document({ pageContent: '__workspace_init__', metadata: { internal: true } })],
    placeholderEmbeddings
  );

  await placeholderStore.save(storeDir);
}

async function loadRAG() {
  embeddings = new HuggingFaceTransformersEmbeddings({
    modelName: "Xenova/all-MiniLM-L6-v2"
  });

  const storeDir = path.join(__dirname, 'vector_store');
  if (!fs.existsSync(storeDir) || !fs.existsSync(path.join(storeDir, 'args.json')) || !fs.existsSync(path.join(storeDir, 'hnswlib.index'))) {
    await ensureRootVectorStore();
  }

  vectorStore = await HNSWLib.load(storeDir, embeddings);
  console.log("RAG vector store and embeddings loaded.");
}

// Maximum L2 distance to consider a chunk relevant (HNSWLib returns L2 distances; lower = more similar).
// Chunks beyond this threshold are discarded as semantically unrelated to the question.
const SIMILARITY_THRESHOLD = 1.2;

app.post('/rag', async (req, res) => {
  const question = req.body.question;
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid question' });
  }

  try {
    const rawResults = await vectorStore.similaritySearchWithScore(question, 10);
    const results = rawResults
      .filter(([doc, score]) => score <= SIMILARITY_THRESHOLD && doc?.pageContent !== '__workspace_init__' && !doc?.metadata?.internal)
      .map(([doc]) => doc)
      .slice(0, 5);
    const filtered = results;
    const context = filtered.map((doc, i) => `Context #${i + 1}:\n${doc.pageContent}`);

    const greetingInstruction = isGreetingMessage(question)
      ? "The user is greeting you. Respond warmly and briefly as a JKUAT assistant, then offer help with JKUAT topics. Do not sound rigid or say you cannot help with greetings."
      : "";

    const systemPrompt = `You are VeritasRAG.AI, the official assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT). 
    Your role is to answer questions ONLY about JKUAT, including courses offered,
     academic programs, campus directions, learning hours, admissions requirements, student services, facilities, and university operations.
      Use a concise, professional tone. ${greetingInstruction}
      If the question is unrelated to JKUAT, politely redirect to JKUAT topics. Never identify yourself as an AI model or mention model providers.`;
    
    const systemPromptWithContext = systemPrompt + `\nGuidelines:\n1. Base answers ONLY on the retrieved context provided.\n
    2. Use the retrieved context as your primary source of truth.\n
    3. If the context contains relevant information, answer from it directly before saying you lack information.\n
    4. Cite specific documents or sources from the context when referenced.\n
    5. If the context truly lacks relevant information, say "I don't have enough information about that in my knowledge base" and offer to direct the user to JKUAT's official channels.\n
    6. Avoid speculation or inference.\n7. Keep answers concise and practical.`;
    
    const prompt = `Retrieved context:\n${context.join("\n\n")}\n\nUser question: ${question}\n\nAnswer:`;

    // LLM call: use Groq only
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'LLM API key not set. Set GROQ_API_KEY' });
    }
    const groqModel = 'qwen/qwen3.6-27b';
    const apiUrl = 'https://api.groq.com/openai/v1/chat/completions';
    const messages = [
      { role: "system", content: systemPromptWithContext },
      { role: "user", content: prompt }
    ];
    let answer = "";
    try {
      const body = { model: groqModel, messages };
      const response = await axios.post(apiUrl, body, {
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 20000
      });
      answer = cleanLlmAnswer(response.data.choices?.[0]?.message?.content) || "[No answer returned]";
    } catch (llmErr) {
      console.error('LLM provider error:', llmErr.response?.data || llmErr.message);
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
    const rawResults2 = await vectorStore.similaritySearchWithScore(question, 10);
    const results = rawResults2
      .filter(([doc, score]) => score <= SIMILARITY_THRESHOLD && doc?.pageContent !== '__workspace_init__' && !doc?.metadata?.internal)
      .map(([doc]) => doc)
      .slice(0, 5);
    const filtered = results;
    const context = filtered.map((doc, i) => `Context #${i + 1}:\n${doc.pageContent}`);

    const greetingInstruction = isGreetingMessage(question)
      ? "The user is greeting you. Respond warmly and briefly as a JKUAT assistant, then offer help with JKUAT topics. Do not sound rigid or say you cannot help with greetings."
      : "";

    const systemPrompt = `You are VeritasRAG.AI, the official AI assistant for Jomo Kenyatta University of Agriculture and Technology (JKUAT).
     Your role is to answer questions about JKUAT,
      including courses offered, academic programs, campus directions, learning hours, admissions requirements, student services, facilities, and university operations.
       Use a concise, professional tone. ${greetingInstruction}
       If the question is unrelated to JKUAT, politely redirect to JKUAT topics.
         Never identify yourself as an AI model or mention model providers.`;
    
    const systemPromptWithContext = systemPrompt + `\nGuidelines:\n1. Base answers ONLY on the retrieved context provided.\n2. Use the retrieved context as your primary source of truth.\n3. If the context contains relevant information, answer from it directly before saying you lack information.\n4. Cite specific documents or sources from the context when referenced.\n5. If the context truly lacks relevant information, say "I don't have enough information about that in my knowledge base" and offer to direct the user to JKUAT's official channels.\n6. Avoid speculation or inference.\n7. Keep answers concise and practical.`;

    const prompt = `Retrieved context:\n${context.join("\n\n")}\n\nUser question: ${question}\n\nAnswer:`;

    // Use Groq only for /ask
    const apiKey2 = process.env.GROQ_API_KEY;
    if (!apiKey2) {
      return res.status(500).json({ error: 'LLM API key not set. Set GROQ_API_KEY' });
    }
    const groqModel2 = 'openai/gpt-oss-120b';
    const apiUrl2 = 'https://api.groq.com/openai/v1/chat/completions';
    const messages = [
      { role: "system", content: systemPromptWithContext },
      { role: "user", content: prompt }
    ];

    let answer = "";
    try {
      const body = { model: groqModel2, messages };
      const response = await axios.post(apiUrl2, body, {
        headers: { "Authorization": `Bearer ${apiKey2}`, "Content-Type": "application/json" },
        timeout: 20000
      });
      answer = cleanLlmAnswer(response.data.choices?.[0]?.message?.content) || "[No answer returned]";
    } catch (llmErr) {
      console.error('LLM provider error:', llmErr.response?.data || llmErr.message);
      return res.status(500).json({ error: 'LLM call failed', details: llmErr.response?.data || llmErr.message });
    }

    // Align with Netlify functions expectations: { answer, context }
    res.json({ context, answer });
  } catch (err) {
    console.error('RAG error:', err);
    res.status(500).json({ error: 'RAG retrieval failed' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', veritasRag: true }));

// VeritasRAG dedicated API (does not replace legacy /ask or /rag)
app.use('/veritas-rag', createVeritasRouter({
  getJkuatStore: () => vectorStore,
}));

// Serve the main public site and static assets from the app root for local/demo use
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve VeritasRAG static UI from the same origin during local/dev demos
app.use('/veritas-rag-ui', express.static(path.join(__dirname, 'public', 'veritas-rag')));

loadRAG().then(() => {
  // Pre-warm Whisper in the background so the first voice request is fast.
  // Errors here are non-fatal — voice will fail gracefully if the model
  // can't be loaded (e.g. no internet on first run).
  loadWhisper().catch((err) => {
    console.warn('[voice] Whisper pre-warm failed (voice ASR will be unavailable):', err.message);
  });

  app.listen(PORT, () => {
    console.log(`RAG server listening on port ${PORT}`);
    console.log(`VeritasRAG API: http://localhost:${PORT}/veritas-rag/meta`);
    console.log(`VeritasRAG UI:  http://localhost:${PORT}/veritas-rag-ui/`);
  });
}).catch(err => {
  console.error('Failed to load RAG:', err);
  process.exit(1);
});
