# VeritasAI and VeritasRAG Chatbot

A modern AI chatbot project featuring Retrieval-Augmented Generation (RAG), vector search, and multi-channel support (web, WhatsApp, API). Built with Node.js, Express, Netlify Functions, and modern AI libraries.

## Features
- Conversational AI chatbot with rule-based and LLM-powered responses
- Retrieval-Augmented Generation (RAG) using vector search
- Web frontend (static HTML/CSS/JS) — **Veritas.AI** at `/`
- **VeritasRAG** dedicated UI at `/veritas-rag/` (Generic document RAG + JKUAT role dashboards)
- WhatsApp integration via webhook
- Secure, rate-limited Express server for RAG
- Environment variable support for secrets and API keys

## VeritasRAG

New independent product surface (does **not** replace Veritas.AI). See **[VERITASRAG.md](./VERITASRAG.md)** for architecture, demo script, APIs, and persistence limits.

```sh
npm start
# UI:  http://localhost:3001/veritas-rag-ui/
# API: http://localhost:3001/veritas-rag/meta
```

## Project Structure

```
jkuatAI/
  public/                  # Veritas.AI frontend (unchanged entry)
  public/veritas-rag/      # VeritasRAG dedicated UI
  lib/veritas-rag/         # Workspaces, ingest, timetable, routes
  netlify/functions/       # Netlify serverless functions
  rag-server.js            # Express RAG server (+ /veritas-rag API)
  data/                    # Runtime SQLite + workspace indexes (gitignored)
  sample-data/             # Demo documents for Generic RAG
  tests/                   # VeritasRAG workflow tests
  vector_store/            # JKUAT institutional HNSW index
  docs/                    # Source PDFs for offline ingest
```

## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- npm

### Install dependencies
```sh
npm install
```

### Run the Web Frontend Locally
```sh
npx serve public
```
Then open http://localhost:3000 in your browser.

### Run the RAG Server
```sh
node rag-server.js
```

### Deploying Netlify Functions
- Functions are in `netlify/functions/` and auto-deployed by Netlify.
- Set environment variables in Netlify dashboard for API keys and URLs.

### Environment Variables
- `RAG_SERVER_URL` (for RAG)
- `GROQ_API_KEY` (required; set to your Groq API key)
- `WHATSAPP_VERIFY_TOKEN` (for WhatsApp webhook)

## Security & Best Practices
- Do not commit secrets to version control.
- Restrict CORS in production.
- Add authentication for sensitive endpoints if needed.

## Author
Ireri Linus Mugendi

---
For more details, see the `DEPLOYMENT-GUIDE.md` or contact hello.linoai@gmail.com.
