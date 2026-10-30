// After Rob uploads the photos in redo/upload/ to Squarespace, this swaps each local
// "../upload/FILE.jpg" image in redo/content/ for its Squarespace CDN address, with a srcset.
//
// 1. Upload each file in redo/upload/ (an Image Block on any hidden page works), then copy the
//    image address (right-click > Copy image address) into redo/upload/urls.json:
//      { "volunteers-tending-vegetable-rows.jpg": "https://images.squarespace-cdn.com/content/v1/.../volunteers-tending-vegetable-rows.jpg" }
// 2. node redo/apply-uploads.mjs          (or --dry to only list what would change)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const urlsFile = path.join(ROOT, 'redo/upload/urls.json');
const urls = fs.existsSync(urlsFile) ? JSON.parse(fs.readFileSync(urlsFile, 'utf8')) : {};
const man = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(ROOT, 'redo/upload/manifest.json'), 'utf8')).map(m => [m.file, m]));

function srcset(base, w) {
  const out = [];
  for (const s of [500, 750, 1000, 1500, 2500]) { if (s < w) out.push(`${base}?format=${s}w ${s}w`); else { out.push(`${base}?format=${s}w ${w}w`); break; } }
  return out.join(', ');
}
let changed = 0, pending = new Set();
for (const f of fs.readdirSync(path.join(ROOT, 'redo/content')).filter(f => f.endsWith('.html'))) {
  const p = path.join(ROOT, 'redo/content', f);
  let html = fs.readFileSync(p, 'utf8'), n = 0;
  html = html.replace(/<img\b[^>]*\bdata-upload="([^"]+)"[^>]*>/g, (tag, file) => {
    const url = urls[file] && urls[file].replace(/\?.*$/, '');
    if (!url) { pending.add(file); return tag; }
    const w = man[file] ? man[file].w : 1000;
    n++;
    return tag.replace(/\ssrc="[^"]*"/, ` src="${url}?format=${w >= 1000 ? 1000 : 750}w" srcset="${srcset(url, w)}"`)
      .replace(/\sdata-upload="[^"]*"/, '');
  });
  if (n) { changed += n; console.log(`${f}: ${n} image(s)`); if (!dry) fs.writeFileSync(p, html); }
}
console.log(`${dry ? 'Would update' : 'Updated'} ${changed} image(s).`);
if (pending.size) console.log('Still waiting for a URL in redo/upload/urls.json:\n  ' + [...pending].join('\n  '));
