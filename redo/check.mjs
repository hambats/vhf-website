// Checks a redo page (or all of them) against redo/BRIEF.md.
// Usage: node redo/check.mjs [redo/content/file.html ...]   (no args = every file in redo/content)
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(path.join(ROOT, 'redo/content')).filter(f => f.endsWith('.html')).map(f => 'redo/content/' + f);

// Anchors other pages link to (file -> ids that must exist).
const NEEDED = {
  'volunteer-full.html': ['bee-squad', 'herb-squad', 'garden-squad', 'vhf-v-squads', 'vhf-v-how'],
  'programs-a.html': ['agritherapy', 'clay'],
  'programs-b.html': ['workshops', 'events'],
  'events-full.html': ['vhf-e-regular'],
  'faq-full.html': ['faq-basics', 'faq-visit', 'faq-programs', 'faq-volunteer', 'faq-give', 'faq-about', 'faq-help'],
  'clay-full.html': ['clay-upcoming'],
  'garden-full.html': ['vhf-garden-squads'],
  'beekeeping-full.html': ['vhf-bee-squad'],
};
const KEYED = ['events-full.html', 'garden-full.html', 'herb-full.html', 'beekeeping-full.html', 'clay-full.html'];
const attr = (t, n) => { const m = t.match(new RegExp('\\s' + n + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i')); return m ? (m[2] ?? m[3]) : null; };

let totalErr = 0;
for (const rel of files) {
  const file = path.resolve(ROOT, rel), base = path.basename(file);
  const html = fs.readFileSync(file, 'utf8');
  const errs = [], warns = [];
  const orig = path.join(ROOT, 'content', base);
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  const scope = (css.match(/\.(vhf-[a-z0-9]+):not\(\.is-on\)\s*\{\s*display:\s*none/) || [])[1] || (css.match(/^\s*\.(vhf-[a-z0-9]+)\s*\{/m) || [])[1];
  const hasHide = /\.vhf-[a-z0-9]+:not\(\.is-on\)\s*\{\s*display:\s*none/.test(css);
  // Events hides its pieces individually (calendar boxes wait for data); the brief only asks pages without any reveal to add one.
  if (!hasHide && !/events-full/.test(base)) errs.push('missing .vhf-X:not(.is-on){display:none}');
  const extraScopes = /events-full/.test(base) ? ['dialog.vhf-e-dlg', '.vhf-e-dlg'] : [];
  if (scope) {
    if (!new RegExp("classList\\.add\\(['\"]is-on['\"]\\)").test(html)) errs.push('no script adds is-on');
    // Every selector inside <style> must start with the scope (skip @-rules, keyframes steps, :root-less things).
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@keyframes[^{]+\{([^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const m of flat.matchAll(/(^|\})\s*([^{}@][^{}]*)\{/g)) {
      const sels = m[2].split(',').map(s => s.trim()).filter(Boolean);
      for (const s of sels) if (!s.startsWith("@") && !s.startsWith('.' + scope) && !extraScopes.some(x => s.startsWith(x)) && !/^(from|to|\d+%)$/.test(s)) { errs.push('unscoped selector: ' + s.slice(0, 60)); break; }
    }
    if (/<img\b/i.test(html) && !new RegExp('\\.' + scope + '\\s+img\\s*\\{[^}]*height:\\s*auto').test(css)) errs.push(`missing .${scope} img{max-width:100%;height:auto}`);
  }
  const body = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  // ids
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i); if (dup.length) errs.push('duplicate ids: ' + [...new Set(dup)].join(', '));
  for (const id of NEEDED[base] || []) if (!ids.includes(id)) errs.push('missing id other pages link to: #' + id);
  if (fs.existsSync(orig)) {
    const oids = [...fs.readFileSync(orig, 'utf8').replace(/<script[\s\S]*?<\/script>/gi, '').matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    const lost = oids.filter(i => !ids.includes(i));
    if (lost.length) warns.push('ids in the staged file that are gone (check nothing needs them): ' + lost.join(', '));
  }
  // in-page anchors
  // Programs is one page in two Code blocks: part A's jump cards point at ids in part B.
  const sibling = base === 'programs-a.html' ? path.join(path.dirname(file), 'programs-b.html') : null;
  const sibIds = sibling && fs.existsSync(sibling) ? [...fs.readFileSync(sibling, 'utf8').matchAll(/\sid="([^"]+)"/g)].map(m => m[1]) : [];
  for (const m of body.matchAll(/href="#([^"]+)"/g)) if (!ids.includes(m[1]) && !sibIds.includes(m[1])) errs.push('in-page link to missing #' + m[1]);
  // images
  const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  imgs.forEach((t, i) => {
    const src = attr(t, 'src') || '', name = decodeURIComponent(src.split('/').pop().split('?')[0]), alt = attr(t, 'alt');
    const where = `img ${i + 1} (${name.slice(0, 40)})`;
    if (alt === null) errs.push(where + ': no alt');
    else if (/^(image|photo|picture) of/i.test(alt)) errs.push(where + ': alt starts with "image/photo of"');
    else if (alt.length > 180) warns.push(where + ': alt over 180 characters');
    if (!attr(t, 'width') || !attr(t, 'height')) errs.push(where + ': no width/height');
    if (/hambats\.github\.io/.test(src)) errs.push(where + ': still served from GitHub Pages');
    if (/squarespace-cdn/.test(src) && !/\.(png)$/i.test(name) && !/(logo|LOGO|CMYK|print)/.test(name) && !attr(t, 'srcset') && !/sponsors|resources/.test(base)) warns.push(where + ': CDN photo without srcset');
    if (attr(t, 'srcset') && !attr(t, 'sizes')) errs.push(where + ': srcset without sizes');
    if (src.startsWith('../upload/') && !attr(t, 'data-upload')) errs.push(where + ': upload image without data-upload');
    if (src.startsWith('../upload/') && !fs.existsSync(path.join(ROOT, 'redo/upload', src.slice(10)))) errs.push(where + ': upload file not found');
    if (i === 0 && attr(t, 'loading') === 'lazy' && !/programs-b/.test(base)) warns.push(where + ': first image is lazy (should it be the LCP image?)');
    if (i > 0 && attr(t, 'loading') !== 'lazy') warns.push(where + ': not lazy');
  });
  // comments
  const cm = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map(m => m[1]).filter(c => !/FAQ-LD|FAQPage structured data/.test(c));
  if (cm.length > 1) warns.push(`${cm.length} HTML comments (brief: keep one header comment)`);
  if (/TODO|FIXME/.test(html)) errs.push('TODO/FIXME left in the file');
  // landmarks
  if (/<section[^>]*aria-label(ledby)?=[^>]*>(?:(?!<\/section>)[\s\S])*<aside/i.test(body)) errs.push('<aside> inside a labelled <section>');
  // headings
  const h1 = (body.match(/<h1\b/gi) || []).length;
  if (base !== 'programs-b.html' && h1 !== 1) errs.push(`${h1} h1 elements`);
  if (/<h[1-6][^>]*>\s*<\/h[1-6]>/i.test(body)) warns.push('empty heading in the HTML');
  // links
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const t = '<a' + m[1] + '>', href = attr(t, 'href'), txt = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (href === null || href === '') { if (!/data-reg|vhf-[a-z]+-reg|id="/.test(m[1])) warns.push('link with empty href: ' + txt.slice(0, 40)); }
    if (attr(t, 'target') === '_blank' && !/noopener/.test(attr(t, 'rel') || '')) errs.push('target=_blank without rel=noopener: ' + (href || '').slice(0, 60));
    if (/^(click here|here|learn more|read more|more)$/i.test(txt)) warns.push('vague link text: "' + txt + '"');
    if (/paypal\.com/.test(href || '') && !['donate-full.html', 'home-full.html', 'faq-full.html'].includes(base)) errs.push('PayPal link outside Donate/Home/FAQ');
  }
  // calendar key
  if (KEYED.includes(base) && !html.includes('__VHF_CAL_KEY__')) errs.push('calendar key placeholder __VHF_CAL_KEY__ missing');
  if (/AIza[0-9A-Za-z_-]{20,}/.test(html)) errs.push('a real Google API key is in the file');
  // copy style
  const text = body.replace(/<[^>]+>/g, ' ');
  const em = (text.match(/—|&mdash;/g) || []).length; if (em > 2) warns.push(`${em} em dashes in body copy`);
  const bang = (text.match(/!/g) || []).length; if (bang > 1) warns.push(`${bang} exclamation marks (quotes may account for some)`);
  if (/\bBee Squad\b/.test(text)) warns.push('"Bee Squad" (brief: Bee Keeping Squad)');
  if (/Plant Medicine Director/.test(text)) warns.push('"Plant Medicine Director" (brief: Director of Plant Medicine)');
  if (/70,000/.test(text)) warns.push('70,000 (brief: 75,000+)');
  // JSON-LD parses
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) { try { JSON.parse(m[1]); } catch (e) { errs.push('JSON-LD does not parse: ' + e.message); } }
  // inline scripts parse
  for (const m of html.matchAll(/<script(?![^>]*(?:src=|ld\+json))([^>]*)>([\s\S]*?)<\/script>/g)) {
    // Module scripts may use top-level await and imports: check them as the body of an async function.
    const code = /type="module"/.test(m[1]) ? '(async () => {' + m[2].replace(/^\s*import\s[^;]+;/gm, '') + '\n})' : m[2];
    try { new Function(code); } catch (e) { errs.push('inline script syntax error: ' + e.message); }
  }

  totalErr += errs.length;
  console.log(`\n${rel}: ${errs.length} errors, ${warns.length} warnings`);
  errs.forEach(e => console.log('  ERROR ' + e));
  warns.forEach(w => console.log('  warn  ' + w));
}
process.exitCode = totalErr ? 1 : 0;
