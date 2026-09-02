# VeritasAI and VeritasRAG Chatbot

A modern AI chatbot project featuring Retrieval-Augmented Generation (RAG), vector search, and multi-channel support (web, WhatsApp, API). Built with Node.js, Express, Netlify Functions, and modern AI libraries.

## Features
- Conversational AI chatbot with rule-based and LLM-powered responses
- Retrieval-Augmented Generation (RAG) using vector search
- Web frontend (static HTML/CSS/JS)
- WhatsApp integration via webhook
- Secure, rate-limited Express server for RAG
- Environment variable support for secrets and API keys

## Project Structure
```
jkuatAI/
  public/           # Frontend (index.html, chat.js, style.css, SVGs)
  netlify/functions/ # Netlify serverless functions (askai.js, chat.js, whatsapp-webhook.js)
  rag-server.js     # Express RAG server
  rag.js, retrieve.js # RAG utilities and scripts
  vector_store/     # Vector DB files
  docs/             # Documentation PDFs
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
