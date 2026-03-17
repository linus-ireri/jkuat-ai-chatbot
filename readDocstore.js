import fs from 'fs';
import util from 'util';

const path = './vector_store/docstore.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

console.log(`✅ Found ${Object.keys(data).length} entries.`);

let count = 0;
for (const [id, obj] of Object.entries(data)) {
  console.log(`\n🧾 Entry #${++count} — ID: ${id}`);
  console.log(util.inspect(obj, { depth: null, colors: true })); // expand nested objects fully
  if (count >= 5) break; // limit output for readability
}
