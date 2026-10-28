/**
 * Generic RAG document ingestion with per-workspace HNSW indexes.
 * Lifecycle: Uploaded → Extracting → Chunking → Embedding → Indexing → Ready
 */
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { PDFLoader } from '@langchain/community/document_loaders/fs/pdf';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { HNSWLib } from '@langchain/community/vectorstores/hnswlib';
import { HuggingFaceTransformersEmbeddings } from '@langchain/community/embeddings/huggingface_transformers';
import { Document } from '@langchain/core/documents';
import {
  DATA_DIR,
  getDocument,
  updateDocument,
  listDocuments,
} from './db.js';

const ALLOWED = new Set(['.pdf', '.txt', '.csv', '.docx']);
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

let sharedEmbeddings = null;

export function normalizeAllowedRoles(input) {
  if (input === undefined || input === null) return [];

  let raw = [];
  if (Array.isArray(input)) raw = input;
  else if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        raw = trimmed.split(',');
      }
    } else {
      raw = trimmed.split(',');
    }
  }

  const set = new Set();
  for (const item of raw) {
    const value = String(item || '').trim().toLowerCase();
    if (!value) continue;
    const normalized = value.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (normalized) set.add(normalized);
  }
  return [...set];
}

export function resolveDocumentAllowedRoles(explicitRoles, storedRoles) {
  if (explicitRoles !== undefined && explicitRoles !== null) {
    return normalizeAllowedRoles(explicitRoles);
  }
  if (storedRoles !== undefined && storedRoles !== null && String(storedRoles).trim() !== '') {
    return normalizeAllowedRoles(storedRoles);
  }
  return [];
}

export function getEmbeddings() {
  if (!sharedEmbeddings) {
    sharedEmbeddings = new HuggingFaceTransformersEmbeddings({
      modelName: 'Xenova/all-MiniLM-L6-v2',
      batchSize: 8,
    });
  }
  return sharedEmbeddings;
}

export function workspaceStorePath(workspaceId) {
  return path.join(DATA_DIR, 'workspaces', workspaceId, 'vector_store');
}

export function validateUpload(file) {
  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  if (!ALLOWED.has(ext)) {
    return { ok: false, error: `Unsupported type ${ext}. Allowed: PDF, DOCX, TXT, CSV` };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `File exceeds ${MAX_BYTES / (1024 * 1024)} MB limit` };
  }
  return { ok: true, ext: ext.slice(1) };
}

async function extractText(filePath, format) {
  if (format === 'pdf') {
    const loader = new PDFLoader(filePath, { splitPages: true });
    const docs = await loader.load();
    return {
      pages: docs.length,
      docs: docs.map((d, i) => new Document({
        pageContent: d.pageContent,
        metadata: { ...d.metadata, page: d.metadata?.loc?.pageNumber || i + 1 },
      })),
    };
  }

  if (format === 'docx') {
    // Lightweight DOCX: zip XML text extraction without mammoth dependency
    const buf = fs.readFileSync(filePath);
    const text = extractDocxPlainText(buf);
    return {
      pages: 1,
      docs: [new Document({ pageContent: text, metadata: { page: 1 } })],
    };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const cleaned = raw.replace(/\u0000/g, '').trim();
  return {
    pages: cleaned.split(/\n\s*\n/).filter(Boolean).length || 1,
    docs: [new Document({ pageContent: cleaned, metadata: { page: 1 } })],
  };
}

/** Extract readable text from a DOCX zip by reading the document XML payload. */
function decodeXmlEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function normalizeDocxText(value) {
  return decodeXmlEntities(value)
    .replace(/<w:tab[^>]*\/>/gi, '\t')
    .replace(/<w:br[^>]*\/>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<w:t[^>]*>/gi, '')
    .replace(/<\/w:t>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u0000/g, '')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function extractDocxPlainText(filePath) {
  try {
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries().map((entry) => entry.entryName);
    const xmlEntry = entries.find((name) => name === 'word/document.xml')
      || entries.find((name) => name.endsWith('/document.xml'))
      || entries.find((name) => /(^|\/)word\/.*\.xml$/.test(name));

    if (!xmlEntry) return '';

    const xml = zip.readAsText(xmlEntry);
    const directMatches = Array.from(xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/gi)).map((m) => m[1]);
    if (directMatches.length) {
      return normalizeDocxText(directMatches.join(' '));
    }

    return normalizeDocxText(xml);
  } catch {
    return '';
  }
}

async function loadOrCreateStore(workspaceId) {
  const storePath = workspaceStorePath(workspaceId);
  const embeddings = getEmbeddings();
  if (fs.existsSync(path.join(storePath, 'hnswlib.index'))) {
    return HNSWLib.load(storePath, embeddings);
  }
  fs.mkdirSync(storePath, { recursive: true });
  // Create empty store with a placeholder that we immediately rebuild from docs if needed
  const store = await HNSWLib.fromDocuments(
    [new Document({ pageContent: '__workspace_init__', metadata: { internal: true } })],
    embeddings
  );
  await store.save(storePath);
  return store;
}

export async function rebuildWorkspaceIndex(workspaceId, { keepDocumentId = null } = {}) {
  const storePath = workspaceStorePath(workspaceId);
  const docs = listDocuments(workspaceId).filter((d) => d.id !== keepDocumentId && d.status === 'ready');

  if (!docs.length) {
    if (fs.existsSync(storePath)) fs.rmSync(storePath, { recursive: true, force: true });
    return;
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 700,
    chunkOverlap: 100,
    separators: ['\n\n', '\n', '. ', ' '],
  });

  const allChunks = [];
  for (const doc of docs) {
    try {
      const extracted = await extractText(doc.storage_path, doc.format);
      if (!extracted.docs?.length) continue;
      const docsWithMeta = extracted.docs.map((d) => new Document({
        pageContent: d.pageContent,
        metadata: {
          ...d.metadata,
          document_id: doc.id,
          workspace_id: doc.workspace_id,
          filename: doc.filename,
          source: doc.filename,
          type: doc.format,
          allowed_roles: resolveDocumentAllowedRoles(undefined, doc.allowed_roles),
        },
      }));
      const chunks = await splitter.splitDocuments(docsWithMeta);
      chunks.forEach((c, i) => {
        c.metadata.chunk_index = i;
      });
      allChunks.push(...chunks);
    } catch (err) {
      console.warn('workspace rebuild skipped document', doc.id, err.message);
    }
  }

  if (!allChunks.length) {
    if (fs.existsSync(storePath)) fs.rmSync(storePath, { recursive: true, force: true });
    return;
  }

  fs.mkdirSync(storePath, { recursive: true });
  const store = await HNSWLib.fromDocuments(allChunks, getEmbeddings());
  await store.save(storePath);
}

export async function ingestDocument(documentId, { allowedRoles } = {}) {
  const doc = getDocument(documentId);
  if (!doc) throw new Error('Document not found');
  const chunkRoles = resolveDocumentAllowedRoles(allowedRoles, doc.allowed_roles);

  try {
    updateDocument(documentId, { status: 'extracting', error_message: null });
    const extracted = await extractText(doc.storage_path, doc.format);
    if (!extracted.docs.length || !extracted.docs.some((d) => d.pageContent?.trim())) {
      throw new Error('No extractable text found');
    }

    updateDocument(documentId, {
      status: 'chunking',
      pages_or_sections: extracted.pages,
    });

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 700,
      chunkOverlap: 100,
      separators: ['\n\n', '\n', '. ', ' '],
    });

    const withMeta = extracted.docs.map((d) => new Document({
      pageContent: d.pageContent,
      metadata: {
        ...d.metadata,
        document_id: documentId,
        workspace_id: doc.workspace_id,
        filename: doc.filename,
        source: doc.filename,
        type: doc.format,
        allowed_roles: chunkRoles,
      },
    }));

    updateDocument(documentId, { allowed_roles: JSON.stringify(chunkRoles) });

    const chunks = await splitter.splitDocuments(withMeta);
    chunks.forEach((c, i) => {
      c.metadata.chunk_index = i;
    });

    updateDocument(documentId, { status: 'embedding', chunk_count: chunks.length });
    updateDocument(documentId, { status: 'indexing' });

    const workspaceDocs = listDocuments(doc.workspace_id).filter((d) => d.id === documentId || d.status === 'ready');
    const allChunks = [];
    for (const sibling of workspaceDocs) {
      try {
        const extractedSibling = await extractText(sibling.storage_path, sibling.format);
        const siblingMeta = extractedSibling.docs.map((d) => new Document({
          pageContent: d.pageContent,
          metadata: {
            ...d.metadata,
            document_id: sibling.id,
            workspace_id: sibling.workspace_id,
            filename: sibling.filename,
            source: sibling.filename,
            type: sibling.format,
            allowed_roles: resolveDocumentAllowedRoles(undefined, sibling.allowed_roles),
          },
        }));
        const siblingChunks = await splitter.splitDocuments(siblingMeta);
        siblingChunks.forEach((c, i) => { c.metadata.chunk_index = i; });
        allChunks.push(...siblingChunks);
      } catch (err) {
        console.warn('Skip sibling rebuild', sibling.id, err.message);
      }
    }

    const usable = allChunks.filter((c) => c.pageContent && !c.metadata.internal);
    if (!usable.length) throw new Error('No chunks to index');

    fs.mkdirSync(workspaceStorePath(doc.workspace_id), { recursive: true });
    const store = await HNSWLib.fromDocuments(usable, getEmbeddings());
    await store.save(workspaceStorePath(doc.workspace_id));

    const indexedAt = new Date().toISOString();
    return updateDocument(documentId, {
      status: 'ready',
      chunk_count: chunks.length,
      pages_or_sections: extracted.pages,
      indexed_at: indexedAt,
      error_message: null,
    });
  } catch (err) {
    console.error('Ingest failed', documentId, err);
    return updateDocument(documentId, {
      status: 'failed',
      error_message: err.message || 'Ingestion failed',
    });
  }
}

export async function deleteFromIndex(documentId) {
  const doc = getDocument(documentId);
  if (!doc) return;
  await rebuildWorkspaceIndex(doc.workspace_id, { keepDocumentId: documentId });
}

// Maximum L2 distance to consider a chunk relevant.
// HNSWLib returns L2 distances; lower = more similar. Chunks above this are semantically unrelated.
const WORKSPACE_SIMILARITY_THRESHOLD = 1.2;

async function _retrieveWorkspaceRaw(workspaceId, question, k = 5, documentIds = null) {
  const storePath = workspaceStorePath(workspaceId);
  if (!fs.existsSync(path.join(storePath, 'hnswlib.index'))) {
    return [];
  }
  const store = await HNSWLib.load(storePath, getEmbeddings());
  const rawResults = await store.similaritySearchWithScore(question, Math.max(k * 3, 15));
  let results = rawResults
    .filter(([doc, score]) => score <= WORKSPACE_SIMILARITY_THRESHOLD);
  if (documentIds?.length) {
    const set = new Set(documentIds);
    results = results.filter(([doc]) => set.has(doc.metadata?.document_id));
  }
  // Drop init placeholder
  results = results.filter(([doc]) => doc.pageContent !== '__workspace_init__' && !doc.metadata?.internal);
  return results.slice(0, k); // returns [doc, score] pairs
}

// Public API — returns plain docs for backward compatibility
export async function retrieveWorkspace(workspaceId, question, k = 5, documentIds = null) {
  const pairs = await _retrieveWorkspaceRaw(workspaceId, question, k, documentIds);
  return pairs.map(([doc]) => doc);
}

// Internal — returns [doc, score] pairs for global cross-workspace ranking
export async function retrieveWorkspaceWithScores(workspaceId, question, k = 5, documentIds = null) {
  return _retrieveWorkspaceRaw(workspaceId, question, k, documentIds);
}

export { ALLOWED, MAX_BYTES };
