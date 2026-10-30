// Pulls the live site's header, footer, body classes and Squarespace stylesheets
// into site/ so the preview hub can wrap each content page in the real site chrome.
// Usage: node scripts/pull-chrome.mjs [--force] [/path]   (default /home-1)
// header.html / footer.html are meant to be edited offline; without --force they are not overwritten.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const force = process.argv.includes('--force');
const page = process.argv.find((a, i) => i > 1 && a.startsWith('/')) || '/home-1';
const ORIGIN = 'https://www.veteranshealingfarm.org';

const html = await (await fetch(ORIGIN + page)).text();
const noScripts = s => s.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<noscript[\s\S]*?<\/noscript>/g, '');

// Everything between <div id="siteWrapper"> and <main> is the header (plus floating cart).
const wrapTag = html.match(/<div\s[^>]*id="siteWrapper"[^>]*>/);
if (!wrapTag) throw new Error('siteWrapper not found; Squarespace markup changed');
const wrapEnd = wrapTag.index + wrapTag[0].length;
const mainStart = html.search(/<main[ >]/);
const header = noScripts(html.slice(wrapEnd, mainStart)).trim();
const footer = noScripts(html.slice(html.indexOf('<footer'), html.indexOf('</footer>') + 9)).trim();
const bodyTag = html.match(/<body[\s\S]*?>/)[0];
const bodyClass = (bodyTag.match(/class="([\s\S]*?)"/)[1]).replace(/\s+/g, ' ').trim();
const wrapperClass = (wrapTag[0].match(/class="([^"]*)"/) || [, ''])[1];

for (const [name, body] of [['header.html', header], ['footer.html', footer]]) {
  const f = path.join(site, name);
  if (fs.existsSync(f) && !force) { console.log('kept existing', name, '(use --force to overwrite)'); continue; }
  fs.writeFileSync(f, body + '\n'); console.log('wrote', name, body.length);
}
fs.writeFileSync(path.join(site, 'live', 'chrome.json'), JSON.stringify({ bodyClass, wrapperClass, pulledFrom: ORIGIN + page, pulledOn: new Date().toISOString() }, null, 2));

// Stylesheets (skip the published custom.css: the hub compiles site/custom.less instead).
const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)].map(m => m[0].match(/href="([^"]+)"/)[1]);
const files = [];
for (const href of hrefs) {
  if (/custom-css/.test(href)) continue;
  const name = (href.match(/\/([^\/?]+\.css)(\?|$)/) || [])[1];
  const unique = String(files.length).padStart(2, '0') + '-' + name;
  fs.writeFileSync(path.join(site, 'live', unique), await (await fetch(href)).text());
  files.push(unique); console.log('css', unique);
}
const cc = hrefs.find(h => /custom-css/.test(h));
if (cc) fs.writeFileSync(path.join(site, 'live', 'published-custom.css'), await (await fetch(cc)).text());
fs.writeFileSync(path.join(site, 'live', 'css-order.json'), JSON.stringify(files));
