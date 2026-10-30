// Rebuilds the FAQPage JSON-LD in faq-full.html from its visible <details> blocks.
// Optional argument: another FAQ file to rebuild, e.g. node scripts/faq-jsonld.mjs redo/content/faq-full.html
import fs from 'fs';
import path from 'path';
const F = process.argv[2] ? path.resolve(process.argv[2]) : new URL('../content/faq-full.html', import.meta.url);
let h = fs.readFileSync(F, 'utf8').replace(/\n<!-- FAQ-LD -->[\s\S]*$/, '\n');
const text = s => s.replace(/<ul class="go">[\s\S]*?<\/ul>/g, '').replace(/<li>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const qa = [...h.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<div class="ans">([\s\S]*?)<\/div>\s*<\/details>/g)]
  .map(m => ({ '@type': 'Question', name: text(m[1]), acceptedAnswer: { '@type': 'Answer', text: text(m[2]) } }));
const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa };
h += '<!-- FAQ-LD --><!-- FAQPage structured data: generated from the questions above; regenerate with: node scripts/faq-jsonld.mjs -->\n<script type="application/ld+json">\n' + JSON.stringify(ld).replace(/<\//g, '<\\/') + '\n</script>\n';
fs.writeFileSync(F, h);
console.log(qa.length + ' questions');
