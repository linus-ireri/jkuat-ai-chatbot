import pkg from 'hnswlib-node';
const { HierarchicalNSW } = pkg;
import fs from 'fs';

// --- Configuration ---
const dim = 384; // set your embedding dimension
const space = 'cosine'; // or 'l2'
const indexPath = './vector_store/hnswlib.index';
const metadataPath = './vectorstore/metadata.json';

// --- Load the HNSWLib index ---
const index = new HierarchicalNSW(space, dim);
index.readIndexSync(indexPath, false); // ✅ fixed argument
console.log('✅ HNSWLib index loaded successfully');

// --- Inspect ---
const count = index.getCurrentCount();
console.log(`📊 Index currently holds ${count} vectors.`);

// --- Load metadata (if available) ---
if (fs.existsSync(metadataPath)) {
  const raw = fs.readFileSync(metadataPath, 'utf-8');
  const metadata = JSON.parse(raw);
  console.log(`🧠 Loaded ${metadata.length} metadata entries`);

  fs.writeFileSync('./vectorstore_readable.json', JSON.stringify(metadata, null, 2));
  console.log('📄 Exported readable data → vectorstore_readable.json');
} else {
  console.warn('⚠️ No metadata file found. Only vector data exists (not human-readable).');
}
