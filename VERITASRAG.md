# VeritasRAG

Dedicated Retrieval-Augmented Generation UI and APIs for **VeritasRAG**, independent of the existing **Veritas.AI** chat at `/`.

## What was audited

| Area | Finding |
|------|---------|
| Existing UI | `public/index.html`, `public/chat.js`, `public/style.css` — **left intact** |
| RAG server | `rag-server.js` — legacy `POST /ask`, `POST /rag`, `GET /health` preserved |
| Embeddings | Xenova `all-MiniLM-L6-v2` via LangChain |
| Vector store | HNSWLib (`vector_store/` for JKUAT KB) |
| LLM | Groq (`GROQ_API_KEY`) — OpenRouter is not used |
| Ingest | Offline `ingest.js` for JKUAT KB; new HTTP ingest for Generic workspaces |
| Persistence | SQLite `data/veritas.db` + per-workspace indexes under `data/workspaces/` |

## Architecture

```
Browser  →  /veritas-rag/          (static UI; also served at :3001/veritas-rag-ui/)
         →  /veritas-rag/*         (Express API on rag-server)

Modes:
  generic → private workspace HNSW index (data/workspaces/<id>/vector_store)
  jkuat   → shared institutional vector_store + SQLite timetable/notifications
```

Every API request must send:

- `X-Veritas-Mode`: `generic` | `jkuat`
- `X-Veritas-User-Id`: demo user id
- `X-Veritas-Role`: `student` | `lecturer` | `staff` | `public` (JKUAT)
- `X-Veritas-Demo`: `true`

**Demo roles are never verified identities.** Server-side checks still enforce role gates (e.g. public cannot read timetables; lecturers only change their allocations).

## Quick start

```sh
npm install
# ensure GROQ_API_KEY is in .env for LLM answers
npm start
```

- VeritasRAG UI: http://localhost:3001/veritas-rag-ui/
- VeritasRAG API: http://localhost:3001/veritas-rag/meta
- Legacy Veritas.AI static site: `npx serve public` → http://localhost:3000/ (unchanged)
- VeritasRAG static path on Netlify publish dir: `/veritas-rag/`

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `GROQ_API_KEY` | Yes (for answers) | Groq chat completions |
| `PORT` | No | Default `3001` |
| `RAG_SERVER_URL` | Netlify only | Existing askai proxy target |
| `WHATSAPP_*` | WhatsApp only | Unchanged |

Optional UI override: set `localStorage.veritasrag_api` to your API base (Settings page).

## Persistence warning

Workspace uploads and SQLite live under `data/` (gitignored). On ephemeral hosts (many PaaS/serverless disks), **uploads do not survive redeploys** unless you attach durable storage. The committed JKUAT `vector_store/` remains the institutional baseline.

## Demo script

1. Open http://localhost:3001/veritas-rag-ui/
2. **Generic RAG** → Upload Documents → upload `sample-data/demo-knowledge.txt` → Ask: “What is the workspace demo passphrase?”
3. Confirm Evidence inspector shows the excerpt; ask something absent and confirm abstention.
4. **JKUAT RAG** → Enter as Student → view demo timetable & ask about ICS2405.
5. Enter as Lecturer → Propose change → Publish (demo) → switch to Student → Notifications / Announcements reflect the change.
6. Enter as Public User → confirm timetable is forbidden; ask admissions-style questions from the knowledge base.

## Tests

```sh
npm test
# optional HTTP smoke (server must be running):
npm start &
npm test
```

## Key API routes

| Method | Path | Notes |
|--------|------|-------|
| GET | `/veritas-rag/meta` | Modes, demo users, persistence notes |
| POST | `/veritas-rag/documents/upload` | Multipart `files` |
| GET | `/veritas-rag/documents` | List workspace docs |
| DELETE | `/veritas-rag/documents/:id` | Delete + reindex |
| POST | `/veritas-rag/ask` | Mode-aware grounded Q&A |
| GET | `/veritas-rag/jkuat/dashboard` | Role dashboard payload |
| POST | `/veritas-rag/jkuat/schedule-changes` | Lecturer draft |
| POST | `/veritas-rag/jkuat/schedule-changes/:id/publish` | Requires demo publish header/body |

Legacy `/ask` and `/rag` are unchanged for Veritas.AI and WhatsApp.
