/* Proposta 8 · versione 1.2 — hero 3D
   I cosmetici girano su un piedistallo, disegnati in tempo reale con WebGL (three.js r170, in ./three.module.min.js).
   - il movimento segue lo schermo (fino a 60 fotogrammi al secondo), non i 24 fotogrammi di un video;
   - niente video da scaricare: la scena pesa quanto la libreria (~170 KB compressi) più questo file;
   - gira in un worker (OffscreenCanvas), quindi non occupa il thread principale della pagina;
   - si ferma da sola quando l'hero esce dallo schermo o la scheda è in background;
   - con "riduci movimento" attivo mostra la composizione ferma.
   Uso: import('./_runtime/p8-hero3d.js').then(m => m.mount(elemento, { look })) → { destroy(), snapshot(), info() }
   look: 'sospeso' (piatto sottile che fluttua, predefinito) oppure 'base' (piedistallo basso e pieno); anche da ?h3d= nell'indirizzo.
   Per le prove: ?h3dw=0 nell'indirizzo fa girare la scena sul thread principale invece che nel worker. */
import * as THREE from './three.module.min.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ---------- geometrie ---------- */

const spow = (c, n) => Math.sign(c) * Math.pow(Math.abs(c), 2 / n);

// superficie "tornita": ogni anello ha i suoi raggi (sx, sz) e una sezione superellittica
// (n = 2 cerchio, n > 2 rettangolo con gli angoli arrotondati). Gli anelli con raggio 0 chiudono il solido.
function loft(rings, seg = 96) {
  const R = rings.length, S = seg + 1;
  const pos = new Float32Array(R * S * 3), uv = new Float32Array(R * S * 2), idx = [];
  for (let i = 0; i < R; i++) {
    const r = rings[i], n = r.n || 2;
    for (let j = 0; j < S; j++) {
      const a = (j / seg) * TAU, k = i * S + j;
      pos[k * 3] = r.sx * spow(Math.cos(a), n);
      pos[k * 3 + 1] = r.y;
      pos[k * 3 + 2] = r.sz * spow(Math.sin(a), n);
      uv[k * 2] = j / seg; uv[k * 2 + 1] = i / (R - 1);
    }
  }
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * S + j, b = a + S;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  const nr = g.attributes.normal;           // cucitura: i due vertici sovrapposti prendono la stessa normale
  for (let i = 0; i < R; i++) {
    const a = i * S, b = a + seg;
    const x = nr.getX(a) + nr.getX(b), y = nr.getY(a) + nr.getY(b), z = nr.getZ(a) + nr.getZ(b), l = Math.hypot(x, y, z) || 1;
    nr.setXYZ(a, x / l, y / l, z / l); nr.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

function arc(cx, cy, rx, ry, a0, a1, steps, out) {
  for (let i = 0; i <= steps; i++) { const a = a0 + (a1 - a0) * (i / steps); out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
  return out;
}
// profilo [raggio, y] di un cilindro con gli spigoli arrotondati (fb sotto, ft sopra)
function rcyl(r, h, fb = 0.02, ft = 0.02, y0 = 0) {
  const p = [[0, y0]];
  if (fb > 0) arc(r - fb, y0 + fb, fb, fb, -Math.PI / 2, 0, 7, p); else p.push([r, y0]);
  if (ft > 0) arc(r - ft, y0 + h - ft, ft, ft, 0, Math.PI / 2, 7, p); else p.push([r, y0 + h]);
  p.push([0, y0 + h]);
  return p;
}
// flacone con spalla arrotondata: corpo di raggio r alto h, spalla alta sh fino al collo di raggio nr (alto nh)
function bottle(r, h, sh, nr, nh, fb = 0.035, y0 = 0) {
  const p = [[0, y0]];
  arc(r - fb, y0 + fb, fb, fb, -Math.PI / 2, 0, 7, p);
  arc(nr, y0 + h - sh, r - nr, sh, 0, Math.PI / 2, 16, p);
  p.push([nr, y0 + h + nh], [0, y0 + h + nh]);
  return p;
}
const lathe = (profile, seg = 72, n = 2) => loft(profile.map(([r, y]) => ({ y, sx: r, sz: r, n })), seg);
// blocco a sezione rettangolare smussata (sx × sz), alto h, spigoli arrotondati con raggio f
function block(sx, sz, h, f, n, y0 = 0, closeTop = true) {
  const rg = [{ y: y0, sx: 0, sz: 0, n }];
  for (let i = 0; i <= 6; i++) { const ph = -Math.PI / 2 + (i / 6) * (Math.PI / 2), ins = f - f * Math.cos(ph); rg.push({ y: y0 + f + f * Math.sin(ph), sx: sx - ins, sz: sz - ins, n }); }
  for (let i = 0; i <= 6; i++) { const ph = (i / 6) * (Math.PI / 2), ins = f - f * Math.cos(ph); rg.push({ y: y0 + h - f + f * Math.sin(ph), sx: sx - ins, sz: sz - ins, n }); }
  if (closeTop) rg.push({ y: y0 + h, sx: 0, sz: 0, n });
  return rg;
}

/* ---------- materiali ----------
   palette del sito: il blu resta l'identità (il piedistallo è tono su tono), prodotti perla, nude, vetro chiaro,
   argento e tocchi di nero; il rosa #CC6B85 compare una volta sola, nel rossetto */
function materials() {
  const P = (o) => new THREE.MeshPhysicalMaterial(o);
  const c = (h) => new THREE.Color(h);
  const glass = (o) => P({ color: 0xFFFFFF, metalness: 0, roughness: 0.035, transmission: 1, ior: 1.5, specularIntensity: 1, ...o });
  return {
    pearl: P({ color: 0xEFEAE4, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.12, sheen: 0.4, sheenRoughness: 0.45, sheenColor: c(0xFFFFFF), iridescence: 0.22, iridescenceIOR: 1.32, iridescenceThicknessRange: [140, 420] }),
    nude: P({ color: 0xF3D8CF, roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.18, sheen: 0.45, sheenRoughness: 0.45, sheenColor: c(0xFFF0EA) }),
    rose: P({ color: 0xCC6B85, roughness: 0.3, clearcoat: 0.55, clearcoatRoughness: 0.16 }),
    lacquer: P({ color: 0x121116, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.04 }),
    silver: P({ color: 0xDCDFE5, metalness: 1, roughness: 0.32, anisotropy: 0.45 }),
    rubber: P({ color: 0x18161A, roughness: 0.58, sheen: 0.5, sheenRoughness: 0.55, sheenColor: c(0x5E5866) }),
    clearGlass: glass({ thickness: 0.9, attenuationColor: c(0xF3EEE8), attenuationDistance: 4, dispersion: 0.25 }),
    serumGlass: glass({ thickness: 0.4, attenuationColor: c(0xF6EEE6), attenuationDistance: 4 }),
    frosted: glass({ roughness: 0.36, thickness: 0.9, attenuationColor: c(0xEDE2DC), attenuationDistance: 2 }),
    perfume: P({ color: 0xF0D2B4, roughness: 0.12, clearcoat: 0.6, emissive: c(0x5A3A22), emissiveIntensity: 0.25 }),   // il liquido, visto attraverso il vetro
    serum: P({ color: 0xEBC28E, roughness: 0.15, clearcoat: 0.6, emissive: c(0x5E4020), emissiveIntensity: 0.28 }),
    cream: new THREE.MeshStandardMaterial({ color: 0xF6F1EA, roughness: 0.6 }),
    lid: P({ color: 0xD2D6DC, metalness: 1, roughness: 0.28, anisotropy: 0.6 }),
    // piedistallo: lo stesso blu dell'hero; fianco satinato, piano laccato che prende i riflessi delle luci
    side: P({ color: 0x182B63, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, sheen: 0.6, sheenRoughness: 0.45, sheenColor: c(0x6F8FD6) }),
    top: P({ color: 0x1A2E69, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 }),
    inlay: P({ color: 0xB9BFC9, metalness: 1, roughness: 0.35 }),
  };
}

/* ---------- prodotti (1 unità ≈ 10 cm; appoggiano su y = 0) ---------- */

const mesh = (g, m, cast = true) => { const o = new THREE.Mesh(g, m); o.castShadow = cast; o.receiveShadow = true; return o; };

function pumpBottle(M) {
  const g = new THREE.Group(), r = 0.31, h = 1.42;
  g.add(mesh(lathe(bottle(r, h, 0.17, 0.115, 0.05)), M.pearl));
  g.add(mesh(lathe(rcyl(0.14, 0.14, 0.012, 0.03, h - 0.005)), M.silver));     // ghiera
  g.add(mesh(lathe(rcyl(0.045, 0.1, 0, 0, h + 0.13), 32), M.silver));          // stelo
  g.add(mesh(lathe(rcyl(0.118, 0.1, 0.02, 0.04, h + 0.22)), M.pearl));         // testa, nello stesso perla del flacone
  const noz = mesh(lathe(rcyl(0.03, 0.21, 0.008, 0.012), 32), M.pearl);        // beccuccio
  noz.rotation.z = -Math.PI / 2 - 0.08; noz.position.set(0.05, h + 0.272, 0);
  g.add(noz);
  return { group: g, rx: r, rz: r };
}

function dropper(M) {
  const g = new THREE.Group(), r = 0.26, h = 0.74;
  g.add(mesh(lathe(bottle(r, h, 0.13, 0.095, 0.06, 0.04)), M.serumGlass, false));     // vetro chiaro
  g.add(mesh(lathe(bottle(r - 0.035, h * 0.62, 0.05, r - 0.09, 0, 0.03, 0.045)), M.serum));  // il siero, a due terzi
  g.add(mesh(lathe(rcyl(0.112, 0.17, 0.015, 0.025, h - 0.02)), M.silver));      // ghiera
  const b = [[0, h + 0.14], [0.082, h + 0.14]];                                // tettarella
  arc(0, h + 0.33, 0.082, 0.092, 0, Math.PI / 2, 12, b);
  g.add(mesh(lathe(b, 64), M.rubber));
  g.add(mesh(lathe(rcyl(0.022, h - 0.02, 0.02, 0, 0.1), 24), M.silver));         // pipetta (si intravede)
  return { group: g, rx: r, rz: r };
}

function jar(M) {
  const g = new THREE.Group(), r = 0.42, hb = 0.3, hl = 0.17;
  g.add(mesh(lathe(rcyl(r, hb, 0.05, 0.02)), M.frosted, false));               // vasetto in vetro satinato
  g.add(mesh(lathe(rcyl(r - 0.075, hb - 0.09, 0.04, 0.03, 0.055)), M.cream));  // la crema, vista attraverso il vetro
  g.add(mesh(lathe(rcyl(r + 0.012, hl, 0.012, 0.055, hb + 0.004)), M.lid));    // coperchio
  return { group: g, rx: r, rz: r };
}

function perfume(M) {
  const g = new THREE.Group(), w = 0.33, d = 0.17, h = 0.74, f = 0.05, n = 5;
  const rg = block(w, d, h, f, n, 0, false);
  rg.push({ y: h, sx: 0.085, sz: 0.085, n: 2 }, { y: h + 0.05, sx: 0.085, sz: 0.085, n: 2 }, { y: h + 0.05, sx: 0, sz: 0, n: 2 });
  g.add(mesh(loft(rg, 128), M.clearGlass, false));                               // flacone in vetro spesso
  g.add(mesh(loft(block(w - 0.06, d - 0.055, h * 0.72, 0.03, n, 0.075), 96), M.perfume)); // il profumo, con il fondo spesso del vetro
  g.add(mesh(lathe(rcyl(0.1, 0.06, 0.01, 0.015, h)), M.silver));                // collarino
  g.add(mesh(loft(block(0.135, 0.135, 0.3, 0.04, 4, h + 0.055), 96), M.lacquer)); // tappo laccato
  return { group: g, rx: w, rz: d };
}

function tube(M) {
  const g = new THREE.Group(), cr = 0.165, capH = 0.2;
  g.add(mesh(lathe(rcyl(cr, capH, 0.03, 0.012)), M.pearl));                      // tappo (il tubetto sta in piedi sul tappo)
  const rg = [{ y: capH - 0.01, sx: 0, sz: 0 }, { y: capH - 0.01, sx: 0.06, sz: 0.06 }, { y: capH + 0.03, sx: 0.062, sz: 0.062 },
    { y: capH + 0.055, sx: 0.15, sz: 0.15 }, { y: capH + 0.075, sx: 0.183, sz: 0.183 }, { y: capH + 0.1, sx: 0.19, sz: 0.19 }];
  const y0 = capH + 0.1, y1 = 1.46;
  for (let i = 1; i <= 28; i++) {
    const t = i / 28, e = Math.pow(t, 1.55), s = smooth(0, 1, t);
    rg.push({ y: y0 + (y1 - y0) * t, sx: 0.19 + (0.262 - 0.19) * s, sz: 0.19 * (1 - e) + 0.017 * e });
  }
  rg.push({ y: y1 + 0.002, sx: 0.27, sz: 0.024, n: 10 }, { y: 1.58, sx: 0.27, sz: 0.024, n: 10 }, { y: 1.58, sx: 0, sz: 0, n: 10 });
  g.add(mesh(loft(rg, 96), M.nude));
  return { group: g, rx: cr, rz: cr };
}

function lipstick(M) {
  const g = new THREE.Group();
  g.add(mesh(lathe(rcyl(0.112, 0.4, 0.015, 0.01)), M.lacquer));                  // astuccio
  g.add(mesh(lathe(rcyl(0.114, 0.035, 0.006, 0.006, 0.4)), M.silver));           // anello
  g.add(mesh(lathe(rcyl(0.093, 0.13, 0, 0.01, 0.43)), M.silver));                // camicia
  const b = new THREE.CylinderGeometry(0.076, 0.076, 0.24, 64, 10);              // stick con il taglio obliquo
  b.translate(0, 0.12, 0);
  const p = b.attributes.position, tg = Math.tan(0.6);
  for (let i = 0; i < p.count; i++) { const top = 0.24 - (0.076 - p.getX(i)) * tg; p.setY(i, p.getY(i) * (top / 0.24)); }
  b.computeVertexNormals();
  b.translate(0, 0.555, 0);
  g.add(mesh(b, M.rose));
  return { group: g, rx: 0.112, rz: 0.112 };
}

function lipstickCap(M) {
  const g = new THREE.Group();
  const c = mesh(lathe(rcyl(0.118, 0.34, 0.012, 0.012)), M.lacquer);              // cappuccio appoggiato su un fianco
  c.rotation.z = Math.PI / 2; c.position.set(0.17, 0.118, 0);
  g.add(c);
  return { group: g, rx: 0.2, rz: 0.12 };
}

/* ---------- ombre di contatto morbide (texture radiale, calcolata una volta) ---------- */

function radialTex(stops, size = 128) {
  const cv = mkCanvas(size, size);
  const x = cv.getContext('2d'), gr = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  x.fillStyle = gr; x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shadowPlane(tex, w, d, opacity, y) {
  const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const s = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  s.rotation.x = -Math.PI / 2; s.scale.set(w, d, 1); s.position.y = y; s.renderOrder = 1;
  s.userData = { base: opacity, w, d };
  return s;
}

// unisce geometrie indicizzate (posizione, normale, uv) in una sola: meno chiamate di disegno a ogni fotogramma
function mergeGeos(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); uv.set(g.attributes.uv.array, vo * 2);
    const ia = g.index.array; for (let i = 0; i < ia.length; i++) idx[io + i] = ia[i] + vo;
    vo += g.attributes.position.count; io += ia.length;
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  m.setIndex(new THREE.BufferAttribute(idx, 1));
  return m;
}

/* ---------- studio fotografico virtuale: dà i riflessi (luci a striscia, controluce) e poca luce d'ambiente ---------- */

function studio() {
  const s = new THREE.Scene();
  s.add(new THREE.Mesh(new THREE.SphereGeometry(30, 32, 16), new THREE.MeshBasicMaterial({ color: 0x050C22, side: THREE.BackSide })));
  const panel = (w, h, color, k, pos) => {
    const m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }); m.color.multiplyScalar(k);
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m); p.position.set(...pos); p.lookAt(0, 0.6, 0); s.add(p);
  };
  panel(3.2, 11, 0xFFFFFF, 6.5, [-7.5, 2.5, 5.5]);   // striscia principale, davanti a sinistra
  panel(2.2, 11, 0xE4EEFF, 8, [7.2, 2.5, -5]);       // controluce, dietro a destra: disegna i bordi
  panel(2.2, 11, 0xBCD3F7, 5.5, [-7, 2.5, -5.5]);    // controluce azzurro, dietro a sinistra
  panel(12, 12, 0xFFFFFF, 1.1, [0, 12, 0]);          // softbox dall'alto
  panel(3.5, 6, 0xF6D3DA, 0.9, [7, 1.2, 6]);         // riempimento caldo, appena rosato
  panel(16, 3, 0x284891, 0.9, [0, -6, 6]);           // rimbalzo blu dal basso
  return s;
}

/* ---------- caduta iniziale: caduta libera, un piccolo rimbalzo e si posa ---------- */
function drop(p) {
  if (p <= 0) return 0;
  if (p < 0.58) { const q = p / 0.58; return q * q; }
  if (p < 0.8) return 1 - 0.07 * Math.sin(Math.PI * (p - 0.58) / 0.22);
  if (p < 0.92) return 1 - 0.014 * Math.sin(Math.PI * (p - 0.8) / 0.12);
  return 1;
}

/* ---------- scena ---------- */

// una tela 2D per le texture: OffscreenCanvas se c'è (anche dentro il worker), altrimenti un <canvas>
function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// Disegna la scena su una tela (un <canvas> oppure un OffscreenCanvas dentro un worker). Non tocca il DOM della pagina.
function createScene(canvas, o) {
  const reduce = !!o.reduce, look = o.look || 'sospeso', floating = look !== 'base';
  const raf = o.raf, caf = o.caf;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  let maxDpr = Math.min(o.dpr || 1, 2), dpr = maxDpr;   // può essere < 1 se la pagina ha uno zoom CSS
  renderer.setPixelRatio(dpr);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = studio();
  const env = pmrem.fromScene(envScene, 0.025).texture;
  scene.environment = env;
  scene.environmentIntensity = 1;

  // luce principale con le ombre: i prodotti si fanno ombra tra loro e sul piano mentre girano
  const key = new THREE.DirectionalLight(0xFFF3EA, 1.7);
  key.position.set(-3.2, 7, 4.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -1.9, right: 1.9, top: 1.9, bottom: -1.9, near: 2, far: 16 });
  key.shadow.radius = 5; key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
  scene.add(key);

  const M = materials();
  const camera = new THREE.PerspectiveCamera(24, 1.2, 0.1, 80);

  // fondale visto solo attraverso il vetro: i flaconi rifrangono il blu dell'hero invece del vuoto.
  // Disegna soltanto nel passaggio della trasmissione (render target), non sulla tela trasparente.
  const bdCv = mkCanvas(64, 256);
  { const x = bdCv.getContext('2d'), gr = x.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#12296C'); gr.addColorStop(0.45, '#112865'); gr.addColorStop(1, '#0B1A47'); x.fillStyle = gr; x.fillRect(0, 0, 64, 256); }
  const bdTex = new THREE.CanvasTexture(bdCv); bdTex.colorSpace = THREE.SRGBColorSpace;
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: bdTex, toneMapped: false }));
  backdrop.onBeforeRender = (r) => { const inT = r.getRenderTarget() !== null; backdrop.material.colorWrite = inT; backdrop.material.depthWrite = inT; };
  camera.add(backdrop); scene.add(camera);

  const sh = radialTex([[0, 'rgba(3,7,26,0.92)'], [0.42, 'rgba(3,7,26,0.62)'], [0.72, 'rgba(3,7,26,0.18)'], [1, 'rgba(3,7,26,0)']]);

  // piedistallo. 'sospeso': un piatto sottile che fluttua sopra la sua ombra. 'base': basso e pieno, tono su tono
  const PR = floating ? 1.56 : 1.48, PH = floating ? 0.12 : 0.5, TR = PR - 0.09;
  const base = new THREE.Group(); scene.add(base);
  const lift = new THREE.Group(); scene.add(lift);      // ciò che fluttua (nel modo 'sospeso')
  const pedestal = floating ? lift : base;
  pedestal.add(mesh(lathe(rcyl(PR, PH, floating ? 0.05 : 0.03, 0.06, -PH - 0.02), 128), M.side, floating));
  const floorY = floating ? -0.78 : -PH - 0.019;
  const floor = shadowPlane(sh, floating ? 4.3 : 4.5, floating ? 4.3 : 4.5, 0.72, floorY);
  base.add(floor);

  // piano girevole con i prodotti; il filo d'argento sul bordo
  const turn = new THREE.Group(); lift.add(turn);
  turn.add(mesh(lathe(rcyl(TR, 0.03, 0, 0.012, -0.03), 128), M.top, false));
  const ring = mesh(new THREE.TorusGeometry(TR + 0.004, 0.0065, 6, 128), M.inlay, false); ring.rotation.x = Math.PI / 2; ring.position.y = -0.006; turn.add(ring);
  const layout = [
    // [costruttore, x, z, rotazione]  — dal fondo al davanti, così cadono in quest'ordine
    [pumpBottle, -0.08, -0.52, 0.4],
    [tube, 0.6, -0.2, 0.55],
    [perfume, -0.68, -0.02, -0.4],
    [dropper, 0.04, 0.32, 0],
    [jar, 0.8, 0.46, 0],
    [lipstick, -0.38, 0.64, 0.2],
    [lipstickCap, -0.02, 0.96, -0.5],
  ];
  const items = layout.map(([fn, x, z, ry], i) => {
    const it = fn(M);
    const holder = new THREE.Group(); holder.position.set(x, 0, z); holder.rotation.y = ry; turn.add(holder);
    holder.add(it.group);
    const s1 = shadowPlane(sh, it.rx * 2.6, it.rz * 2.6, 0.8, 0.002);
    const s2 = shadowPlane(sh, it.rx * 4.4 + 0.2, it.rz * 4.4 + 0.2, 0.28, 0.001);
    holder.add(s1, s2);
    return { it, holder, s: [s1, s2], t0: 0.25 + i * 0.12 };
  });

  // inquadratura: la cima dei prodotti e il fondo della scena a quote fisse dell'altezza della tela
  const target = new THREE.Vector3(0, 0.5, 0), FT = floating ? 0.15 : 0.18, FB = floating ? 0.9 : 0.86;
  let dist = 11;
  const elev = THREE.MathUtils.degToRad(9.5);
  const pTop = new THREE.Vector3(0, 1.98, -0.52), pBot = new THREE.Vector3(0, floating ? floorY : -PH - 0.02, PR), v = new THREE.Vector3();
  const place = (yaw = 0, pitch = 0) => {
    const e = elev + pitch;
    camera.position.set(target.x + dist * Math.cos(e) * Math.sin(yaw), target.y + dist * Math.sin(e), target.z + dist * Math.cos(e) * Math.cos(yaw));
    camera.lookAt(target); camera.updateMatrixWorld();
  };
  const sy = (p) => (1 - v.copy(p).project(camera).y) / 2;
  function frame() {
    for (let k = 0; k < 12; k++) {
      place();
      dist *= (sy(pBot) - sy(pTop)) / (FB - FT);
      place();
      // alzare il punto di mira fa scendere la scena sullo schermo, e viceversa
      const mid = (sy(pTop) + sy(pBot)) / 2;
      target.y += ((FT + FB) / 2 - mid) * 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;
    }
    // il fondale copre tutto il campo visivo, dietro alla scena
    const far = dist + 6, hh = 2 * far * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.3;
    backdrop.position.set(0, 0, -far); backdrop.scale.set(hh * camera.aspect, hh, 1);
  }

  // stato dell'animazione
  const SPEED = TAU / 34;              // un giro ogni 34 secondi
  let angle = -0.35, yaw = 0, pitch = 0, yawT = 0, pitchT = 0;
  let start = 0, last = 0, rafId = 0, running = false, alive = true, shown = false, compiled = false, wantPlay = false;
  let slow = 0, frames = 0, minDt = 1, drawn = 0, merged = null;
  const settled = items[items.length - 1].t0 + 1.1;

  function pose(t, dt) {
    if (!merged && t >= settled) mergeStatic();
    if (!merged) for (const o of items) {
      const p = reduce ? 1 : clamp((t - o.t0) / 1.0, 0, 1), f = drop(p);
      o.holder.visible = p > 0;
      o.it.group.position.y = (1 - f) * 2.7;
      // l'ombra nasce larga e chiara mentre il prodotto è in aria, si stringe e si scurisce quando si posa
      const k = clamp(f, 0, 1), sc = 1 + (1 - k) * 0.9;
      for (const s of o.s) { s.material.opacity = s.userData.base * k * k; s.scale.set(s.userData.w * sc, s.userData.d * sc, 1); }
    }
    const spin = reduce ? 0 : smooth(1.4, 3.4, t);
    angle += dt * SPEED * spin;
    turn.rotation.y = angle;
    if (floating) {
      // il piatto sale e scende di poco; l'ombra a terra respira al contrario
      const b = reduce ? 0 : Math.sin(t * TAU / 6.5) * 0.045;
      lift.position.y = b;
      const k = 1 - b * 2.2;
      floor.scale.set(floor.userData.w * k, floor.userData.d * k, 1);
      floor.material.opacity = floor.userData.base * (1 - b * 3);
    }
    const a = 1 - Math.exp(-dt * 2.6);
    yaw += (yawT - yaw) * a; pitch += (pitchT - pitch) * a;
    place(yaw, pitch);
  }

  // finita la caduta i prodotti sono fermi rispetto al piatto: li unisco in un solo oggetto per materiale
  // (da ~70 a ~35 chiamate di disegno per fotogramma, sommando ombre, vetro e immagine)
  function mergeStatic() {
    turn.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(turn.matrixWorld).invert(), mtx = new THREE.Matrix4();
    const byMat = new Map(), shA = [], shB = [];
    for (const o of items) {
      o.it.group.position.y = 0;
      o.holder.updateMatrixWorld(true);
      o.it.group.traverse((m) => {
        if (!m.isMesh) return;
        const e = byMat.get(m.material) || { list: [], cast: false };
        e.list.push(m.geometry.clone().applyMatrix4(mtx.multiplyMatrices(inv, m.matrixWorld)));
        e.cast = e.cast || m.castShadow; byMat.set(m.material, e);
      });
      const [s1, s2] = o.s;
      s1.scale.set(s1.userData.w, s1.userData.d, 1); s2.scale.set(s2.userData.w, s2.userData.d, 1);
      s1.updateMatrixWorld(true); s2.updateMatrixWorld(true);
      shA.push(s1.geometry.clone().applyMatrix4(mtx.multiplyMatrices(inv, s1.matrixWorld)));
      shB.push(s2.geometry.clone().applyMatrix4(mtx.multiplyMatrices(inv, s2.matrixWorld)));
    }
    merged = new THREE.Group();
    for (const [mat, e] of byMat) merged.add(mesh(mergeGeos(e.list), mat, e.cast));
    for (const [list, op] of [[shA, 0.8], [shB, 0.28]]) {
      const m = new THREE.Mesh(mergeGeos(list), new THREE.MeshBasicMaterial({ map: sh, transparent: true, depthWrite: false, opacity: op, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.renderOrder = 1; merged.add(m);
    }
    turn.add(merged);
    for (const o of items) o.holder.visible = false;
  }

  function render() {
    // le ombre seguono la rotazione: durante la caduta a ogni fotogramma, poi a fotogrammi alterni (non si nota)
    if (!merged || (drawn & 1) === 0) renderer.shadowMap.needsUpdate = true;
    drawn++;
    renderer.render(scene, camera);
  }

  let W = 0, H = 0;
  function resize(w, h, d) {
    if (d && Math.min(d, 2) !== maxDpr) { maxDpr = Math.min(d, 2); dpr = maxDpr; renderer.setPixelRatio(dpr); W = 0; }
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w === W && h === H) return;
    W = w; H = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    // il vetro rifrange un'immagine della scena: a metà risoluzione costa un quarto e non si nota
    // (three.js r170 dimensiona quel render target su camera.viewport, se è impostato)
    camera.viewport = new THREE.Vector4(0, 0, Math.max(1, Math.round(w * dpr * 0.5)), Math.max(1, Math.round(h * dpr * 0.5)));
    frame();
    if (!running && shown) { pose(reduce ? 99 : (performance.now() - start) / 1000, 0); render(); }
  }
  resize(o.w, o.h);

  function loop(now) {
    if (!running) return;
    rafId = raf(loop);
    // tetto a ~60 fotogrammi al secondo: a 120 Hz disegna un aggiornamento sì e uno no (cadenza regolare);
    // per una rotazione lenta è già fluidissimo e la GPU lavora la metà
    if (now - last < 12) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    pose((now - start) / 1000, dt);
    render();
    if (!shown) { shown = true; o.onShown(); }
    // se la scena non sta al passo (metà dei fotogrammi in ritardo per 2 s), abbassa la risoluzione
    if (dt > 0.004) minDt = Math.min(minDt, dt);
    frames++; if (dt > minDt * 1.7) slow++;
    if (frames >= 120) { if (slow > 60 && dpr > 1) { dpr = Math.max(1, dpr - 0.5); renderer.setPixelRatio(dpr); const w = W, h = H; W = 0; resize(w, h); } frames = 0; slow = 0; }
  }
  function go() {
    if (!wantPlay || !compiled || running || !alive || reduce) return;
    running = true; last = performance.now(); if (!start) start = last;
    rafId = raf(loop);
  }

  // compila gli shader prima di partire, così la caduta iniziale non scatta
  const ready = (renderer.compileAsync ? renderer.compileAsync(scene, camera) : Promise.resolve()).catch(() => {});
  ready.then(() => {
    compiled = true;
    if (!alive) return;
    if (reduce) { pose(99, 0); render(); shown = true; o.onShown(); return; }
    go();
  });

  return {
    play() { wantPlay = true; go(); },
    pause() { wantPlay = false; running = false; caf(rafId); },
    resize,
    pointer(x, y) { yawT = x * 0.16; pitchT = y * 0.06; },      // x, y tra -0.5 e 0.5
    leave() { yawT = 0; pitchT = 0; },
    destroy() {
      alive = false; running = false; caf(rafId);
      const seen = new Set();
      const free = (x) => { if (x && !seen.has(x)) { seen.add(x); x.dispose(); } };
      for (const sc of [scene, envScene]) sc.traverse((x) => { if (x.geometry) free(x.geometry); if (x.material) { free(x.material.map); free(x.material); } });
      free(env); pmrem.dispose(); renderer.dispose();
    },
    // immagine della composizione ferma (per l'immagine di riserva senza WebGL)
    snapshot(t = 99) {
      pose(t, 0); render();
      return canvas.convertToBlob ? canvas.convertToBlob({ type: 'image/png' }) : canvas.toDataURL('image/png');
    },
    info() { return { dpr, size: [W, H], calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, look, worker: typeof document === 'undefined', drawn, t: +((performance.now() - start) / 1000).toFixed(2) }; },
  };
}

/* ---------- nella pagina ----------
   La scena gira in un worker (OffscreenCanvas): il thread principale della pagina, quello di scroll, clic e
   animazioni CSS, non fa nessun lavoro per il 3D. Se il browser non lo permette, gira sul thread principale. */
export function mount(host, opts = {}) {
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const look = opts.look || new URLSearchParams(location.search).get('h3d') || 'sospeso';
  const onFail = opts.onFail || (() => { if (host.parentNode && host.parentNode.classList) host.parentNode.classList.add('no3d'); });
  let canvas = null, ctl = null, worker = null, alive = true, inView = true;
  const size = () => [Math.max(1, host.clientWidth), Math.max(1, host.clientHeight)];
  // densità della tela = pixel del dispositivo × zoom CSS della pagina (la tavola desktop ha zoom:.8):
  // così la tela ha esattamente i pixel che si vedono, né di più né di meno
  const ratio = () => {
    const w = host.getBoundingClientRect().width, z = host.clientWidth > 0 ? w / host.clientWidth : 1;
    return (window.devicePixelRatio || 1) * (z > 0 && isFinite(z) ? z : 1);
  };
  const shown = () => host.classList.add('is-on');
  const sync = () => { if (!ctl) return; if (inView && !document.hidden) ctl.play(); else ctl.pause(); };
  const newCanvas = () => { const c = document.createElement('canvas'); c.className = 'h-3d-cv'; c.setAttribute('aria-hidden', 'true'); host.appendChild(c); return c; };

  function inline() {
    if (!alive) return;
    if (canvas) canvas.remove();
    canvas = newCanvas();
    const [w, h] = size();
    try {
      ctl = createScene(canvas, { look, reduce, dpr: ratio(), w, h, raf: (f) => requestAnimationFrame(f), caf: (id) => cancelAnimationFrame(id), onShown: shown });
    } catch (e) { ctl = null; canvas.remove(); canvas = null; onFail(e); return; }
    sync();
  }

  function viaWorker() {
    canvas = newCanvas();
    const off = canvas.transferControlToOffscreen();
    const w0 = new Worker(import.meta.url, { type: 'module' });
    worker = w0;
    const waiting = new Map(); let seq = 0;
    const ask = (type) => new Promise((res) => { const id = ++seq; waiting.set(id, res); w0.postMessage({ type, id }); });
    const post = (m) => { if (worker === w0) w0.postMessage(m); };
    const fallback = () => { if (worker !== w0) return; worker = null; w0.terminate(); ctl = null; inline(); };
    w0.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'shown') shown();
      else if (m.type === 'fail') fallback();
      else if (m.type === 'reply') { const r = waiting.get(m.id); waiting.delete(m.id); if (r) r(m.value); }
    };
    w0.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); fallback(); };
    const [w, h] = size();
    w0.postMessage({ type: 'init', canvas: off, look, reduce, dpr: ratio(), w, h }, [off]);
    ctl = {
      play: () => post({ type: 'play' }), pause: () => post({ type: 'pause' }),
      resize: (w, h, d) => post({ type: 'resize', w, h, dpr: d }),
      pointer: (x, y) => post({ type: 'pointer', x, y }), leave: () => post({ type: 'leave' }),
      destroy: () => { post({ type: 'destroy' }); setTimeout(() => w0.terminate(), 200); },
      snapshot: () => ask('snapshot'), info: () => ask('info'),
    };
    sync();
  }

  const canWorker = opts.worker !== false && new URLSearchParams(location.search).get('h3dw') !== '0' && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' && 'transferControlToOffscreen' in HTMLCanvasElement.prototype;
  if (canWorker) { try { viaWorker(); } catch (e) { worker = null; inline(); } } else inline();

  // la scena gira solo quando l'hero è sullo schermo e la scheda è in primo piano
  const io = new IntersectionObserver((es) => { inView = es[es.length - 1].isIntersecting; sync(); });
  io.observe(host);
  const onVis = () => sync();
  document.addEventListener('visibilitychange', onVis);
  const ro = new ResizeObserver(() => { const [w, h] = size(); if (ctl) ctl.resize(w, h, ratio()); });
  ro.observe(host);
  // cambio di densità dei pixel (finestra spostata tra schermo retina e monitor esterno)
  let mq = null;
  const onDpr = () => { const [w, h] = size(); if (ctl) ctl.resize(w, h, ratio()); watchDpr(); };
  const watchDpr = () => { if (!window.matchMedia) return; mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`); mq.addEventListener('change', onDpr, { once: true }); };
  watchDpr();

  // lieve parallasse col puntatore, solo con il mouse
  const zone = host.closest('.hero') || window;
  const onMove = (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    const r = zone === window ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : zone.getBoundingClientRect();
    if (ctl) ctl.pointer((e.clientX - r.left) / r.width - 0.5, (e.clientY - r.top) / r.height - 0.5);
  };
  const onLeave = () => { if (ctl) ctl.leave(); };
  if (!reduce) { zone.addEventListener('pointermove', onMove, { passive: true }); zone.addEventListener('pointerleave', onLeave); }

  const api = {
    destroy() {
      alive = false;
      io.disconnect(); ro.disconnect();
      if (mq) mq.removeEventListener('change', onDpr);
      document.removeEventListener('visibilitychange', onVis);
      zone.removeEventListener('pointermove', onMove); zone.removeEventListener('pointerleave', onLeave);
      if (ctl) ctl.destroy(); ctl = null;
      if (canvas) canvas.remove();
    },
    // immagine ferma della scena come data URL PNG (serve a preparare l'immagine di riserva)
    async snapshot() {
      const v = await (ctl && ctl.snapshot());
      if (!v || typeof v === 'string') return v;
      return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(v); });
    },
    async info() { return ctl ? await ctl.info() : null; },
  };
  host.__h3d = api;
  return api;
}

/* ---------- dentro il worker ---------- */
if (typeof document === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  let ctl = null;
  self.onmessage = async (e) => {
    const m = e.data || {};
    if (m.type === 'init') {
      try {
        if (typeof self.requestAnimationFrame !== 'function') throw new Error('requestAnimationFrame non disponibile nel worker');
        ctl = createScene(m.canvas, {
          look: m.look, reduce: m.reduce, dpr: m.dpr, w: m.w, h: m.h,
          raf: (f) => self.requestAnimationFrame(f), caf: (id) => self.cancelAnimationFrame(id),
          onShown: () => self.postMessage({ type: 'shown' }),
        });
      } catch (err) { self.postMessage({ type: 'fail', error: String((err && err.message) || err) }); }
      return;
    }
    if (!ctl) return;
    if (m.type === 'play') ctl.play();
    else if (m.type === 'pause') ctl.pause();
    else if (m.type === 'resize') ctl.resize(m.w, m.h, m.dpr);
    else if (m.type === 'pointer') ctl.pointer(m.x, m.y);
    else if (m.type === 'leave') ctl.leave();
    else if (m.type === 'snapshot') self.postMessage({ type: 'reply', id: m.id, value: await ctl.snapshot() });
    else if (m.type === 'info') self.postMessage({ type: 'reply', id: m.id, value: ctl.info() });
    else if (m.type === 'destroy') { ctl.destroy(); ctl = null; self.close(); }
  };
}
