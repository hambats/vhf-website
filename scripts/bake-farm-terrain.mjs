// Bake the farm's real terrain and an aerial photo for demos/farm-map.html.
// Elevation: AWS Terrain Tiles (Terrarium PNG, zoom 14, ~10 m USGS 3DEP data in the US).
// Aerial photo: USGS NAIP imagery (public domain) from The National Map.
// Usage: node scripts/bake-farm-terrain.mjs   (writes demos/farm-map/terrain.json and demos/farm-map/aerial.jpg)
import { inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const FARM = { lat: 35.388678, lon: -82.587255 }; // 138 Kimzey Road, Mills River, NC (US Census geocoder)
const HALF_KM = 2.0, N = 256, Z = 14, OUT = 'demos/farm-map';
const dLat = HALF_KM / 110.95, dLon = HALF_KM / (111.32 * Math.cos(FARM.lat * Math.PI / 180));
const box = { s: FARM.lat - dLat, n: FARM.lat + dLat, w: FARM.lon - dLon, e: FARM.lon + dLon };

const px = (lon) => (lon + 180) / 360 * 2 ** Z * 256;
const py = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** Z * 256; };

// Minimal PNG decoder: 8-bit RGB/RGBA, non-interlaced (what Terrarium tiles are).
function decodePNG(buf) {
  let o = 8, w, h, ct, idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12]) throw new Error('unsupported PNG'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[row + x - bpp] : 0, b = y ? out[row - stride + x] : 0, c = x >= bpp && y ? out[row - stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[row + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

const x0 = Math.floor(px(box.w) / 256), x1 = Math.floor(px(box.e) / 256), y0 = Math.floor(py(box.n) / 256), y1 = Math.floor(py(box.s) / 256);
const tiles = {};
for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`;
  const res = await fetch(url); if (!res.ok) throw new Error(url + ' ' + res.status);
  tiles[tx + ',' + ty] = decodePNG(Buffer.from(await res.arrayBuffer()));
  console.log('tile', tx, ty);
}
const elevAt = (gx, gy) => { // global pixel -> metres
  const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256), t = tiles[tx + ',' + ty];
  const lx = Math.min(255, Math.max(0, Math.floor(gx - tx * 256))), ly = Math.min(255, Math.max(0, Math.floor(gy - ty * 256))), i = (ly * 256 + lx) * t.bpp;
  return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
};
const bil = (gx, gy) => { const fx = Math.floor(gx), fy = Math.floor(gy), u = gx - fx, v = gy - fy;
  return elevAt(fx, fy) * (1 - u) * (1 - v) + elevAt(fx + 1, fy) * u * (1 - v) + elevAt(fx, fy + 1) * (1 - u) * v + elevAt(fx + 1, fy + 1) * u * v; };

const h = [];
let min = 1e9, max = -1e9;
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const lat = box.n - (box.n - box.s) * j / (N - 1), lon = box.w + (box.e - box.w) * i / (N - 1), e = bil(px(lon), py(lat));
  h.push(Math.round(e * 10) / 10); min = Math.min(min, e); max = Math.max(max, e);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/terrain.json`, JSON.stringify({ farm: FARM, box, n: N, sizeKm: HALF_KM * 2, min, max, source: 'AWS Terrain Tiles (USGS 3DEP), zoom 14', h }));
console.log('terrain', N + 'x' + N, 'min', min.toFixed(1), 'max', max.toFixed(1));

const naip = `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox=${box.w},${box.s},${box.e},${box.n}&bboxSR=4326&imageSR=4326&size=2048,2048&format=jpg&f=image`;
const r = await fetch(naip);
if (!r.ok || !(r.headers.get('content-type') || '').includes('image')) throw new Error('NAIP ' + r.status + ' ' + r.headers.get('content-type'));
writeFileSync(`${OUT}/aerial.jpg`, Buffer.from(await r.arrayBuffer()));
console.log('aerial.jpg written');
