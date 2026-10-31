# VeritasAI + VeritasRAG

A full-stack AI assistant project for a JKUAT-style environment, combining:

- a public web chatbot frontend
- a private workspace RAG experience for generic document ingestion
- a JKUAT-specific role-aware knowledge assistant
- a timetable and announcement workflow for student, lecturer, and staff demo roles
- an admin dashboard for document upload, role-scoped access, audit logging, and deletion
- a local SQLite-backed persistence layer and HNSW vector retrieval pipeline

This repository is a demonstration and working prototype for an evidence-grounded chatbot that can answer questions from uploaded documents while also understanding a structured institutional timetable, schedule changes, announcements, role policies, and audit events.

---

## Project Summary

The system is built around a Node.js + Express server that hosts:

- the main static site under `/`
- the admin dashboard at `/admin`
- the dedicated VeritasRAG UI at `/veritas-rag-ui/`
- the VeritasRAG API under `/veritas-rag`
- legacy RAG endpoints `/ask` and `/rag` for compatibility

It uses:

- Express for API and static serving
- Better-SQLite3 for SQLite persistence
- Multer for multipart document uploads
- LangChain + HNSWLib + Hugging Face embeddings for vector retrieval
- Groq for chat completions
- custom demo scheduler logic for timetable and announcement management

---

## What This Project Does

### 1. Generic document RAG

The system lets a user create a private workspace and upload documents such as:

- `.txt`
- `.md`
- `.pdf`
- `.docx`
- `.csv`

Those files are indexed into a workspace-specific vector store and then retrieved when a user asks a question. The answer is grounded in the uploaded document content and not just a generic model response.

### 2. JKUAT role-aware RAG

The app supports a second mode called `jkuat`, where the assistant answers questions using:

- the shared institutional knowledge base
- published timetable records
- published student/group announcements
- schedule changes and notifications
- role-aware access labels such as public, student, lecturer, and staff

This mode behaves like a demo environment for campus information access, not an SSO-backed institutional system.

### 3. Timetable and change management

The app includes a structured timetable model and schedule-change workflow:

- lecturers can propose changes
- conflicts are detected when changes overlap with another class or venue
- changes can be submitted, published, rejected, or cancelled
- students receive notifications about published changes
- announcements and schedule updates are preserved as the current source of truth

### 4. Role-based access control (RBAC)

Documents can be assigned allowed roles when uploaded. The system checks those roles before retrieving chunks for a user. If a user asks for content outside their allowed scope, the app logs an RBAC block and returns a short access-denied message instead of letting the system answer from restricted content.

### 5. Admin dashboard

The admin UI allows:

- uploading documents
- selecting the allowed audience roles
- viewing uploaded files in a table
- deleting uploaded documents
- inspecting the audit/security feed
- reviewing role-based access events and query history

---

## Modes and Roles

### Modes

- `generic`: private workspace mode for uploaded documents
- `jkuat`: demo institutional mode with timetables and campus knowledge

### Roles

- `public`
- `student`
- `lecturer`
- `staff`

The app uses demo identifiers such as:

- `demo-student`
- `demo-lecturer`
- `demo-staff`
- `demo-public`
- `demo-generic`

Important: demo roles are deliberately not verified institutional identities. They are used to simulate access control and workflow behaviors in a local demo environment.

---

## Main Runtime Stack

### Backend

- Node.js
- Express
- CORS
- Helmet
- Rate limiting
- Better-SQLite3
- Multer
- LangChain
- HNSWLib
- Hugging Face Transformers embeddings
- Groq API
- Axios

### Frontend

- static HTML/CSS/JS under `public/`
- dedicated static UI for VeritasRAG under `public/veritas-rag/`
- admin panel under `public/admin.html`, `public/admin.js`, `public/admin.css`

---

## Repository Structure

```text
jkuat-ai-chatbot/
├── .env                           # local environment variables
├── .gitignore
├── ask.js                         # legacy ask script / helper
├── DEPLOYMENT-GUIDE.md            # Netlify deployment notes
├── ingest.js                     # offline document ingestion / indexing helper
├── inspectVectorStore.js         # vector store inspection utility
├── netlify.toml                  # Netlify config
├── package.json                  # package metadata and scripts
├── rag-server.js                 # Express app entrypoint
├── rag.js                        # additional rag-related helper
├── readDocstore.js               # document store inspection utility
├── README.md                     # this file
├── retrieve.js                   # retrieval helper
├── VERITASRAG.md                 # product-focused notes for VeritasRAG
├── data/
│   ├── uploads/
│   ├── workspaces/
│   ├── veritas.db               # SQLite database
│   └── ...
├── docs/
│   └── ...                       # source/reference docs
├── lib/
│   ├── clean-llm-answer.js
│   └── veritas-rag/
│       ├── auth.js               # demo user/role parsing and role guards
│       ├── date-utils.js         # temporal filtering and date logic
│       ├── db.js                # SQLite schema and persistence
│       ├── ingest-pipeline.js   # validation, chunking, indexing, retrieval
│       ├── query.js             # grounded retrieval + LLM prompt assembly
│       ├── routes.js            # Express routes for VeritasRAG endpoints
│       ├── seed.js              # demo knowledge and timetable seeding
│       └── timetable.js         # timetable, notifications, announcements, changes
├── public/
│   ├── admin.css                 # admin static styling
│   ├── admin.html                # admin dashboard
│   ├── admin.js                 # admin upload/list/delete logic
│   ├── chat.js                  # legacy chat UI logic
│   ├── index.html               # main frontend entry
│   ├── style.css                # main frontend styling
│   └── veritas-rag/
│       └── ...                   # dedicated VeritasRAG UI files
├── sample-data/
│   └── demo-knowledge.txt
├── tests/
│   └── veritas-rag.test.js      # core regression and workflow tests
├── vector_store/
│   ├── args.json
│   ├── docstore.json
│   └── hnswlib.index
└── ...
```

---

## Voice Input and Output

The assistant supports a **push-to-talk voice interface** in the VeritasRAG UI. You can hold the microphone button (or hold **Space** when the mic button is focused) to record, then release to send. The server transcribes your speech with Whisper, runs it through the same RAG + RBAC pipeline as typed questions, and returns a spoken reply using Piper TTS.

### How it works

1. Browser records audio via `MediaRecorder`
2. Audio is mixed to mono, resampled to 16 kHz, and sent as raw `Float32LE` PCM to `POST /veritas-rag/voice/ask`
3. Server transcribes with **Whisper** (`Xenova/whisper-base.en`, loaded once at startup)
4. The transcribed text passes through the same `runVeritasQuery()` function as typed questions — identical RBAC checks and audit logging apply
5. Server converts the answer to speech using **Piper** (if configured) and returns it as base64 WAV
6. Browser plays the WAV via Web Audio API, or falls back to `speechSynthesis` if Piper is not configured

### Model download — Whisper

Whisper is downloaded automatically from Hugging Face on first server startup. No manual download is needed. The model is cached in the default Hugging Face cache directory (`~/.cache/huggingface` or the `HF_CACHE_DIR` env var).

The default model is `Xenova/whisper-base.en` (~150 MB). It runs on CPU and is fast enough for 30-second clips.

To use a larger model (higher accuracy, slower startup):

```env
WHISPER_MODEL=Xenova/whisper-small.en
```

### Piper TTS setup (optional)

Piper is an open-source neural TTS engine. Server-side speech synthesis is optional — if it is not configured the browser uses `speechSynthesis`.

**Install Piper:**

```bash
# Linux x86_64 — download a release from:
# https://github.com/rhasspy/piper/releases
wget https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_linux_x86_64.tar.gz
tar xf piper_linux_x86_64.tar.gz
sudo cp piper/piper /usr/local/bin/piper
```

**Download a voice model:**

```bash
# Example: English (US), medium quality, Lessac voice
mkdir -p /opt/piper/models
wget -P /opt/piper/models \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
```

Browse all available voices at: https://huggingface.co/rhasspy/piper-voices

**Set environment variables:**

```env
PIPER_BINARY=piper
PIPER_MODEL=/opt/piper/models/en_US-lessac-medium.onnx
```

### Voice endpoint

| Method | Path | Description |
|--------|------|-------------|
| POST | `/veritas-rag/voice/ask` | Transcribe audio → RAG query → TTS reply |

**Request:**
- `Content-Type: application/octet-stream`
- Body: raw Float32LE PCM, 16 kHz, mono, max 30 s / 2 MB
- Headers: same `X-Veritas-*` headers as typed `/ask`

**Response:**
```json
{
  "question": "When is the library open?",
  "answer": "The library is open Monday to Friday...",
  "audioBase64": "<base64-encoded WAV or null>"
}
```

`audioBase64` is `null` when Piper is not configured or fails. The browser falls back to `speechSynthesis` automatically.

### UI controls

The mic button appears in the AI Assistant view next to the **Ask** button:

- **Hold** the button (or hold **Space** when it is focused) to record
- **Release** to send
- **Repeat** button — replay the last spoken answer
- **Stop** button — stop playback immediately
- Typed input continues to work as before

### Security

- Role and userId are taken **only** from server-side context (`X-Veritas-*` headers read at the Express layer) — never from the request body
- Voice queries go through the same RBAC filter as typed questions
- Blocked voice queries are logged to `audit_events` with `action = 'voice.ask.rejected'`
- Audio is **not stored** — it is transcribed in memory and discarded

---



Create a `.env` file in the project root.

```env
GROQ_API_KEY=your_groq_api_key_here
PORT=3001
RAG_SERVER_URL=http://localhost:3001
WHATSAPP_VERIFY_TOKEN=optional

# Voice I/O (optional — see Voice Input and Output section above)
WHISPER_MODEL=Xenova/whisper-base.en
PIPER_BINARY=piper
PIPER_MODEL=/opt/piper/models/en_US-lessac-medium.onnx
```

### Required variables

- `GROQ_API_KEY`: required for LLM completions and answer generation

### Optional variables

- `PORT`: defaults to `3001`
- `RAG_SERVER_URL`: used by some Netlify or proxy scenarios
- `WHATSAPP_VERIFY_TOKEN`: only if WhatsApp webhook logic is being used
- `WHISPER_MODEL`: Hugging Face model ID for ASR (default: `Xenova/whisper-base.en`, auto-downloaded on first startup)
- `PIPER_BINARY`: name or full path of the Piper binary (default: `piper`)
- `PIPER_MODEL`: absolute path to the Piper `.onnx` voice model; leave blank to disable server TTS and use browser `speechSynthesis`
- `HF_CACHE_DIR`: override the Hugging Face model cache directory

---

## Setup and Run

### Install dependencies

```bash
npm install
```

### Start the app

```bash
npm start
```

This runs:

```bash
node rag-server.js
```

### Default local URLs

- Main app: http://localhost:3001/
- Admin dashboard: http://localhost:3001/admin
- VeritasRAG UI: http://localhost:3001/veritas-rag-ui/
- VeritasRAG API meta: http://localhost:3001/veritas-rag/meta

### Legacy static frontend

The project also still supports serving the base static site directly if needed:

```bash
npx serve public
```

Then visit:

- http://localhost:3000/

---

## API Overview

### Legacy endpoints

These are preserved for compatibility with the earlier chatbot build:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/rag` | vector retrieval + Groq answer generation |
| POST | `/ask` | legacy ask endpoint |
| GET | `/health` | health check |

### VeritasRAG endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/veritas-rag/meta` | server metadata, modes, roles, demo users |
| POST | `/veritas-rag/workspaces` | create a workspace (generic mode) |
| GET | `/veritas-rag/workspaces/current` | current workspace and docs |
| GET | `/veritas-rag/documents` | list uploaded documents |
| POST | `/veritas-rag/documents/upload` | upload one or more files |
| GET | `/veritas-rag/documents/:id` | fetch doc details |
| DELETE | `/veritas-rag/documents/:id` | delete a document and its index |
| POST | `/veritas-rag/documents/:id/reindex` | reindex a document |
| POST | `/veritas-rag/ask` | grounded question answering |
| POST | `/veritas-rag/voice/ask` | voice question (Float32 PCM → transcribe → RAG → TTS) |
| GET | `/veritas-rag/conversations` | list conversations |
| GET | `/veritas-rag/conversations/:id` | fetch a conversation history |
| GET | `/veritas-rag/admin/audit` | audit/security trail |
| GET | `/veritas-rag/admin/freshness` | freshness/document status monitor |
| GET | `/veritas-rag/jkuat/dashboard` | role-authenticated dashboard JSON |
| GET | `/veritas-rag/jkuat/timetable` | timetable data |
| GET | `/veritas-rag/jkuat/announcements` | announcements |
| GET | `/veritas-rag/jkuat/notifications` | notifications |
| POST | `/veritas-rag/jkuat/schedule-changes` | propose a timetable change |
| POST | `/veritas-rag/jkuat/schedule-changes/:id/submit` | submit for approval |
| POST | `/veritas-rag/jkuat/schedule-changes/:id/publish` | publish a change |
| POST | `/veritas-rag/jkuat/schedule-changes/:id/reject` | reject a change |
| POST | `/veritas-rag/jkuat/schedule-changes/:id/cancel` | cancel a draft or pending change |
| POST | `/veritas-rag/demo/reset` | reset demo notifications and data |

### Required request headers

Most VeritasRAG routes expect headers like:

```http
X-Veritas-Mode: generic
X-Veritas-User-Id: demo-generic
X-Veritas-Demo: true
```

For JKUAT mode, additional headers may be used:

```http
X-Veritas-Role: student
X-Veritas-User-Id: demo-student
X-Veritas-Mode: jkuat
X-Veritas-Demo: true
```

---

## Generic Workspace Ingestion

Generic mode is designed for a user-owned workspace:

1. user creates or uses a workspace
2. uploads files
3. role restrictions are set
4. ingestion validates file types and size
5. content is split and embedded
6. chunks are stored in the workspace vector index
7. the assistant retrieves only relevant, allowed-role chunks

This mode is resilient and can answer questions only from the files the user explicitly indexed.

---

## JKUAT Knowledge and Workflow

JKUAT mode combines two sources:

1. institutionally relevant vector documents
2. structured timetable and schedule change records stored in SQLite

This allows the assistant to answer questions such as:

- when is my next class?
- has a class changed?
- what announcements affect my group?
- what class is scheduled for a lecturer?
- what was changed and why?

The assistant is told to treat published timetable records as the official current state and to report previous schedule state only when there is a published change record.

---

## Demo Schedule Logic

The timetable logic is structured to support demos without acting like an official data source.

### Important behavior

- published timetable data is the current truth for active class times
- schedule changes are compared against the published timetable
- draft or pending changes are not presented as official
- when a change is published, students see notifications and announcements
- current date/time is included in prompts to keep answers temporally aware
- the app asks the model to use the last 15 conversation messages for continuity

This is implemented in:

- `lib/veritas-rag/timetable.js`
- `lib/veritas-rag/query.js`
- `lib/veritas-rag/date-utils.js`

---

## Document Role Policy

Uploaded content can be scoped to allowed roles. For example:

- `public` documents can be read by public users
- `student` documents are only available to student-role users
- `lecturer` and `staff` docs are restricted to matching roles

When a role is not included, retrieval does not expose the chunk, and an audit log records the blocked access.

This is handled by:

- `normalizeAllowedRoles()` in `lib/veritas-rag/ingest-pipeline.js`
- `roleAllowsChunk()` in `lib/veritas-rag/query.js`
- `logRbacBlock()` in the same query layer

---

## Admin Dashboard and Security Feed

The dashboard is served at `/admin` and includes:

- upload panel
- role checkbox selectors
- uploaded document table
- delete action for uploaded documents
- audit table called “Security & Audit Feed”

This feed reflects:

- document uploads
- document deletions
- role-block violations
- answered queries
- no-context or invalid access warnings

It polls the `/veritas-rag/admin/audit` endpoint periodically so it updates while the app is running.

---

## Persistence Model

The project stores information in two main places:

### SQLite database

The app writes to `data/veritas.db` using Better-SQLite3. It tracks:

- workflows
- documents
- workspaces
- conversations
- messages
- timetable entries
- announcements
- notifications
- schedule changes
- audit events

### Vector store indexes

The system maintains:

- shared JKUAT vector store in `vector_store/`
- per-workspace vector indexes in `data/workspaces/<workspace-id>/`

### Important warning

On ephemeral environments such as some serverless platforms, local disk storage may be lost during redeploy. The project is designed to work locally, but durable storage should be configured before production use.

---

## Testing

The project includes regression tests in:

```text
tests/veritas-rag.test.js
```

Run them with:

```bash
npm test
```

The test suite covers:

- role checks and access denial behavior
- JKUAT timetable workflow
- schedule changes and published updates
- announcement persistence
- date-sensitive filtering
- workspace upload and retrieval behavior
- RBAC document protection
- answer sanitization
- generic RAG ingestion and deletion
- voice: `stripMarkdownForSpeech` output validation
- voice: Piper TTS fallback when `PIPER_MODEL` is unset
- voice: student voice request for lecturer-only content is refused and audited
- voice: typed and spoken questions return the same answer for the same role

---

## Demo Use Cases

### Generic workflow

1. open a workspace in generic mode
2. upload a file
3. ask a question from the file
4. verify the answer is grounded in the uploaded content
5. delete the file and verify it disappears from the workspace index

### JKUAT workflow

1. select a demo role such as `student`, `lecturer`, or `staff`
2. ask timetable or campus questions
3. propose a class change as a lecturer
4. publish the change as a demo action
5. switch to student view and see notifications and announcement updates
6. verify public users cannot access protected timetable data

---

## Production Notes and Security Warnings

This project is a prototype and demo system. Before production use, you should consider:

- real authentication and authorization
- production-grade storage and backup
- secure secret management
- strict CORS configuration
- access control on all admin routes
- audit retention and export policies
- request logging and anomaly monitoring
- proper rate limiting and DDoS protection at the edge

The current system is intentionally demo-first and does not replace real identity management or institutional access controls.

---

## Deployment

The project includes a Netlify deployment guide in:

- `DEPLOYMENT-GUIDE.md`
- `netlify.toml`

The app is intended to run as a Node server for local demo and can also be adapted to serverless deployment patterns with care.

---

## Useful Commands

```bash
# install dependencies
npm install

# run app
npm start

# run tests
npm test

# check health
curl http://localhost:3001/health

# view VeritasRAG meta
curl http://localhost:3001/veritas-rag/meta
```

---

## Author

Ireri Linus Mugendi

## Notes

This project intentionally keeps a legacy chatbot experience while layering in the newer VeritasRAG system. The legacy endpoints remain functional, but the dedicated VeritasRAG interface is the primary modern implementation.
