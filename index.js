'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');
const crypto = require('crypto');

const writeFile = promisify(fs.writeFile);
const mkdir = promisify(fs.mkdir);
const stat = promisify(fs.stat);

const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 2));
const TICK_MS = Number(process.env.PROGRESS_TICK_MS || 450); // progress tick
const MIN_REPORT_BYTES = 64 * 1024; // only report if changed by >64KB
const MAX_SIMULATED_PCT = 90;

let sharp = null;
let useSharp = false;
try {
  sharp = require('sharp');
  useSharp = true;
  console.log('✅ sharp available — using sharp for image processing.');
} catch (e) {
  console.log('⚠️ sharp not available, will fallback to Jimp + jpeg-js.');
}

const app = express();
const port = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname)));

// multer memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB per file

// ensure outputs dir
const outputsDir = path.join(__dirname, 'outputs');
(async () => {
  try {
    await stat(outputsDir);
  } catch (e) {
    try { await mkdir(outputsDir); console.log('Created outputs directory.'); } catch (err) { console.error('Could not create outputs dir', err); }
  }
})();

// SSE clients
const sseClients = new Map();
function sendSse(clientId, event, data) {
  const res = sseClients.get(clientId);
  if (!res) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (e) {
    // ignore write error
  }
}

// keepalive
setInterval(() => {
  for (const [id, res] of sseClients.entries()) {
    try { res.write(`: heartbeat\n\n`); } catch (e) { try { res.end(); } catch(_){}; sseClients.delete(id); }
  }
}, 20000);

// helpers
function formatBytes(n) {
  if (!n && n !== 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

app.get('/session', (req, res) => {
  res.json({ clientId: crypto.randomUUID() });
});

app.get('/sse', (req, res) => {
  const clientId = req.query.id;
  if (!clientId) return res.status(400).send('Missing id');
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ message: 'connected', clientId })}\n\n`);
  sseClients.set(clientId, res);
  console.log(`SSE client connected: ${clientId} (clients: ${sseClients.size})`);
  req.on('close', () => {
    sseClients.delete(clientId);
    try { res.end(); } catch (_) {}
    console.log(`SSE client disconnected: ${clientId} (clients: ${sseClients.size})`);
  });
});

// robust helper: convert a Jimp image instance to JPEG buffer using available APIs, fallback to jpeg-js
async function jimpToJpegBuffer(jimg, preferQuality = 80, fallbackQuality = 75) {
  // try getBufferAsync
  try {
    if (jimg && typeof jimg.getBufferAsync === 'function') {
      if (typeof jimg.quality === 'function') await jimg.quality(preferQuality);
      const mime = (jimg.constructor && jimg.constructor.MIME_JPEG) ? jimg.constructor.MIME_JPEG : 'image/jpeg';
      return await jimg.getBufferAsync(mime);
    }
    // try callback-style getBuffer
    if (jimg && typeof jimg.getBuffer === 'function') {
      if (typeof jimg.quality === 'function') await jimg.quality(preferQuality);
      return await new Promise((resolve, reject) => {
        jimg.getBuffer('image/jpeg', (err, buf) => err ? reject(err) : resolve(buf));
      });
    }
    // fallback: encode raw bitmap via jpeg-js
    if (jimg && jimg.bitmap && jimg.bitmap.data && jimg.bitmap.width && jimg.bitmap.height) {
      const { data, width, height } = jimg.bitmap;
      // convert RGBA -> RGB
      const rgb = Buffer.alloc(width * height * 3);
      let dst = 0;
      for (let i = 0; i < data.length; i += 4) {
        rgb[dst++] = data[i];
        rgb[dst++] = data[i + 1];
        rgb[dst++] = data[i + 2];
      }
      let jpeg;
      try {
        jpeg = require('jpeg-js');
      } catch (e) {
        // try dynamic import
        const mod = await import('jpeg-js');
        jpeg = mod && mod.default ? mod.default : mod;
      }
      const encoded = jpeg.encode({ data: rgb, width, height }, fallbackQuality);
      return encoded.data;
    }
    throw new Error('No supported buffer method on Jimp instance');
  } catch (err) {
    throw err;
  }
}

// process single file (compress) - returns result object
async function processFile(f, idx, clientId, quality) {
  const state = {
    index: idx,
    originalName: f.originalname || f.name || `file_${idx}`,
    originalSize: f.size || (f.file && f.file.size) || 0,
    processedBytes: 0,
    progress: 0,
    compressedSize: null,
    outPath: null,
    error: null,
    _lastReportedPct: -1,
    _lastReportedBytes: -1,
    isCompressing: false
  };

  // helper reporting with throttling
  function reportIfNeeded() {
    const pct = Math.round(state.progress || 0);
    const bytes = state.processedBytes || 0;
    const pctChanged = pct !== state._lastReportedPct;
    const bytesChanged = (bytes - state._lastReportedBytes) > MIN_REPORT_BYTES;
    if (!pctChanged && !bytesChanged) return;
    state._lastReportedPct = pct;
    state._lastReportedBytes = bytes;
    // terminal log
    console.log(`${state.originalName} — ${formatBytes(bytes)} / ${formatBytes(state.originalSize)} — ${pct}%`);
    if (clientId) {
      sendSse(clientId, 'file-progress', {
        index: state.index,
        name: state.originalName,
        processedBytes: state.processedBytes,
        originalSize: state.originalSize,
        progress: state.progress
      });
    }
  }

  // simulated progress interval (to show movement while compressing)
  let interval = null;
  try {
    state.isCompressing = true;
    interval = setInterval(() => {
      if (!state.isCompressing) return;
      const maxBeforeFinish = Math.floor(state.originalSize * 0.9);
      const inc = Math.max(8 * 1024, Math.round(state.originalSize * (Math.random() * 0.04 + 0.01)));
      state.processedBytes = Math.min(maxBeforeFinish, (state.processedBytes || 0) + inc);
      const newPct = Math.round((state.processedBytes / Math.max(1, state.originalSize)) * 100);
      state.progress = Math.min(MAX_SIMULATED_PCT, newPct);
      reportIfNeeded();
      // overall progress (pushed by caller via states array)
    }, TICK_MS);

    // actual compression
    let outBuffer;
    if (useSharp && f.buffer) {
      outBuffer = await sharp(f.buffer)
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .jpeg({ quality: Math.max(1, Math.min(100, quality)), mozjpeg: true })
        .toBuffer();
    } else {
      // dynamic import jimp
      let JimpModule;
      try {
        JimpModule = await import('jimp');
      } catch (impErr) {
        throw new Error('Failed to import jimp: ' + (impErr && impErr.message ? impErr.message : impErr));
      }

      // normalize Jimp export
      const Jimp = JimpModule && (JimpModule.default || JimpModule.Jimp) ? (JimpModule.default || JimpModule.Jimp) : JimpModule;

      let jimg;
      try {
        if (Jimp && typeof Jimp.read === 'function') {
          jimg = await Jimp.read(f.buffer || f.file);
        } else if (typeof Jimp === 'function') {
          // some builds export constructor/class directly
          jimg = await new Jimp(f.buffer || f.file);
        } else if (typeof JimpModule.read === 'function') {
          jimg = await JimpModule.read(f.buffer || f.file);
        } else {
          throw new Error('Jimp.read not available in this build');
        }
      } catch (readErr) {
        throw new Error('Jimp.read failed: ' + (readErr && readErr.message ? readErr.message : readErr));
      }

      // composite over white for alpha images if possible
      try {
        const hasAlpha = (typeof jimg.hasAlpha === 'function') ? jimg.hasAlpha() : true;
        if (hasAlpha) {
          // create white bg and composite
          const JimpClass = Jimp || JimpModule;
          let bg;
          if (typeof JimpClass === 'function') {
            bg = new JimpClass(jimg.bitmap.width, jimg.bitmap.height, 0xffffffff);
          } else {
            // fallback: clone jimg (rare)
            bg = jimg.clone ? jimg.clone() : jimg;
          }
          if (typeof bg.composite === 'function') {
            bg.composite ? bg.composite(jimg, 0, 0) : bg.blit(jimg, 0, 0);
          } else if (typeof bg.blit === 'function') {
            bg.blit(jimg, 0, 0);
          }
          if (typeof bg.quality === 'function') await bg.quality(Math.max(1, Math.min(100, quality)));
          outBuffer = await jimpToJpegBuffer(bg, Math.max(1, Math.min(100, quality)), Math.max(60, quality));
        } else {
          if (typeof jimg.quality === 'function') await jimg.quality(Math.max(1, Math.min(100, quality)));
          outBuffer = await jimpToJpegBuffer(jimg, Math.max(1, Math.min(100, quality)), Math.max(60, quality));
        }
      } catch (e) {
        // fallback: try directly
        outBuffer = await jimpToJpegBuffer(jimg, Math.max(1, Math.min(100, quality)), Math.max(60, quality));
      }
    }

    // finalize
    clearInterval(interval);
    state.compressedSize = outBuffer.length;
    state.processedBytes = state.compressedSize;
    state.progress = 100;
    state.isCompressing = false;

    // save file
    const safeName = (f.originalname || f.name || `file_${idx}`).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const outName = `${Date.now()}_${idx}_${safeName.replace(/\.[^/.]+$/, '')}.jpg`;
    const outPath = path.join(outputsDir, outName);
    await writeFile(outPath, outBuffer);
    state.outPath = `/outputs/${outName}`;

    // final report
    reportIfNeeded();
    if (clientId) sendSse(clientId, 'file-done', {
      index: state.index,
      name: state.originalName,
      originalSize: state.originalSize,
      compressedSize: state.compressedSize,
      outPath: state.outPath
    });

    return {
      index: state.index,
      name: state.originalName,
      originalSize: state.originalSize,
      compressedSize: state.compressedSize,
      outPath: state.outPath,
      error: null,
      state // return state for overall aggregation
    };
  } catch (err) {
    clearInterval(interval);
    state.error = String(err && err.message ? err.message : err);
    state.isCompressing = false;
    state.progress = 0;
    state.processedBytes = 0;
    console.error('Compression error for', state.originalName, err);
    reportIfNeeded();
    if (clientId) sendSse(clientId, 'file-done', { index: state.index, name: state.originalName, error: state.error });
    return { index: state.index, name: state.originalName, error: state.error, state };
  }
}

// POST /api/compress-multi
app.post('/api/compress-multi', upload.array('files'), async (req, res) => {
  const clientId = req.query.id || req.body?.id;
  const files = req.files || [];

  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded (use field name "files")' });
  }

  // prepare states container for overall progress aggregation
  const statesMeta = files.map((f, idx) => ({ index: idx, originalName: f.originalname || f.name || `file_${idx}`, originalSize: f.size || 0, processedBytes: 0 }));

  function reportOverall() {
    const totalOriginal = statesMeta.reduce((s, it) => s + (it.originalSize || 0), 0);
    const totalProcessed = statesMeta.reduce((s, it) => s + (it.processedBytes || 0), 0);
    const pct = totalOriginal > 0 ? Math.min(100, Math.round((totalProcessed / totalOriginal) * 100)) : 0;
    console.log(`OVERALL — ${formatBytes(totalProcessed)} / ${formatBytes(totalOriginal)} — ${pct}%`);
    if (clientId) sendSse(clientId, 'overall-progress', { processedBytes: totalProcessed, totalOriginal, progress: pct });
  }

  // process pool with concurrency
  const results = [];
  let running = 0;
  let idxPtr = 0;

  // wrapper to start next job
  await new Promise((resolveAll) => {
    const startNext = async () => {
      if (idxPtr >= files.length && running === 0) {
        return resolveAll();
      }
      while (running < CONCURRENCY && idxPtr < files.length) {
        const currentIdx = idxPtr++;
        const f = files[currentIdx];
        running++;
        // process and update shared statesMeta periodically
        (async () => {
          const quality = Math.max(1, Math.min(100, Number(req.body.quality || 80)));
          const result = await processFile(f, currentIdx, clientId, quality);
          // if result includes state object, propagate processedBytes into statesMeta for overall computation
          if (result && result.state) {
            statesMeta[currentIdx].processedBytes = result.state.processedBytes || 0;
          } else if (result && result.compressedSize) {
            statesMeta[currentIdx].processedBytes = result.compressedSize;
          }
          // update overall immediately after file done
          reportOverall();
          results.push({ index: result.index, name: result.name, originalSize: result.originalSize, compressedSize: result.compressedSize, outPath: result.outPath, error: result.error });
          running--;
          // continue
          startNext();
        })().catch(err => {
          console.error('processFile unexpected error', err);
          running--;
          startNext();
        });
      }
    };
    // Periodically aggregate per-file processed bytes from each "state" kept by processFile is tricky since we returned only final state.
    // To keep overall progress responsive while files running, we'll also poll sseClients' log frequency by scanning outputs if necessary.
    // For simplicity: start pool and resolve when done (startNext will call resolveAll).
    startNext();
  });

  // final overall report
  // compute final overall values
  const totalOriginal = results.reduce((s, r) => s + (r.originalSize || 0), 0);
  const totalProcessed = results.reduce((s, r) => s + (r.compressedSize || 0), 0);
  const finalPct = totalOriginal > 0 ? Math.min(100, Math.round((totalProcessed / totalOriginal) * 100)) : 100;
  if (clientId) sendSse(clientId, 'overall-progress', { processedBytes: totalProcessed, totalOriginal, progress: finalPct });
  if (clientId) sendSse(clientId, 'done', { results });

  console.log('All files processed. Summary:');
  results.forEach(r => {
    if (r.error) console.log(`- ${r.name} : ERROR -> ${r.error}`);
    else console.log(`- ${r.name} : ${formatBytes(r.originalSize)} -> ${formatBytes(r.compressedSize)} -> ${r.outPath}`);
  });

  return res.json({ success: true, results });
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(port, () => {
  console.log(`🚀 Compressor server running at http://localhost:${port}/`);
  console.log(`Open frontend, GET /session then connect EventSource('/sse?id=...')`);
  console.log(`CONCURRENCY=${CONCURRENCY}, PROGRESS_TICK_MS=${TICK_MS}`);
});
