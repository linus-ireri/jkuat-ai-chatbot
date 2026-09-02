import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { HNSWLib } from "@langchain/community/vectorstores/hnswlib";
import { HuggingFaceTransformersEmbeddings } from "@langchain/community/embeddings/huggingface_transformers";

import { cleanLlmAnswer } from './lib/clean-llm-answer.js';

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

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isGreetingMessage(text) {
  const normalized = normalize(text);
  return /^(hi|hello|hey|how are you|good morning|good afternoon|good evening|who are you|who are you\?)/.test(normalized);
}

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
    const results = await vectorStore.similaritySearch(question, 5);
    const context = results.map((doc, i) => `Context #${i + 1}:\n${doc.pageContent}`);

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
    
    const prompt = `Retrieved context: ${context.join(" ")}\n\nUser question: ${question}\n\nAnswer:`;

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
    const results = await vectorStore.similaritySearch(question, 5);
    const context = results.map((doc, i) => `Context #${i + 1}:\n${doc.pageContent}`);

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

    const prompt = `Retrieved context: ${context.join(" ")}\n\nUser question: ${question}\n\nAnswer:`;

    // Use Groq only for /ask
    const apiKey2 = process.env.GROQ_API_KEY;
    if (!apiKey2) {
      return res.status(500).json({ error: 'LLM API key not set. Set GROQ_API_KEY' });
    }
    const groqModel2 = 'qwen/qwen3.6-27b';
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

app.get('/health', (req, res) => res.json({ status: 'ok' }));

loadRAG().then(() => {
  app.listen(PORT, () => {
    console.log(`RAG server listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to load RAG:', err);
  process.exit(1);
});
