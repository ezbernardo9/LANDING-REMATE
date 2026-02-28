const express = require('express');
const multer  = require('multer');
const jwt     = require('jsonwebtoken');
const bcrypt  = require('bcryptjs');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Credenciales admin ────────────────────────────────────────────────────────
// Para cambiar la clave: reemplazá el hash generando uno nuevo con bcrypt.hashSync('nuevaClave', 10)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_HASH = process.env.ADMIN_HASH || bcrypt.hashSync(process.env.ADMIN_PASS || 'madelan2026', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'madelan-jwt-secret-2026-remate';

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const DATA_FILE   = path.join(DATA_DIR, 'lots.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Crear directorios si no existen
[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(__dirname));          // sirve remate.html, admin.html
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Multer (subida de fotos) ──────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `lot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}${ext}`;
    cb(null, name);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Solo se permiten imágenes'));
  },
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

// ── Helpers data ──────────────────────────────────────────────────────────────
function loadLots() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}

function saveLots(lots) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(lots, null, 2), 'utf8');
}

// ── Middleware de autenticación ───────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS AUTH
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/login  →  { token }
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'Faltan usuario y contraseña' });

  if (username !== ADMIN_USER || !bcrypt.compareSync(password, ADMIN_HASH))
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, username });
});

// GET /api/auth/me  →  { username }  (verificar token)
app.get('/api/auth/me', auth, (req, res) => {
  res.json({ username: req.user.username });
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS LOTES (públicas: GET)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/lots  →  [ ...lotes ]
app.get('/api/lots', (req, res) => {
  res.json(loadLots());
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS LOTES (protegidas)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/lots  →  crea un lote nuevo
app.post('/api/lots', auth, (req, res) => {
  const lots = loadLots();
  const lot  = {
    id:      Date.now().toString(),
    badge:   req.body.badge   || '',
    cat:     req.body.cat     || '',
    title:   req.body.title   || '',
    specs:   req.body.specs   || [],
    notice:  req.body.notice  || '',
    btnText: req.body.btnText || 'Consultar por WhatsApp',
    photos:  req.body.photos  || [],
    pending: req.body.pending ?? false,
  };
  lots.push(lot);
  saveLots(lots);
  res.status(201).json(lot);
});

// PUT /api/lots/:id  →  edita un lote
app.put('/api/lots/:id', auth, (req, res) => {
  const lots = loadLots();
  const idx  = lots.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Lote no encontrado' });

  // No permitir cambiar el id
  const { id: _id, ...updates } = req.body;
  lots[idx] = { ...lots[idx], ...updates };
  saveLots(lots);
  res.json(lots[idx]);
});

// DELETE /api/lots/:id  →  elimina un lote
app.delete('/api/lots/:id', auth, (req, res) => {
  const lots = loadLots();
  const idx  = lots.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Lote no encontrado' });

  // Borrar fotos locales del lote
  lots[idx].photos.forEach(url => deleteLocalPhoto(url));

  lots.splice(idx, 1);
  saveLots(lots);
  res.json({ ok: true });
});

// POST /api/lots/reorder  →  reordenar lotes { order: ['id1','id2',...] }
app.post('/api/lots/reorder', auth, (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order debe ser un array de IDs' });

  const lots      = loadLots();
  const map       = Object.fromEntries(lots.map(l => [l.id, l]));
  const reordered = order.map(id => map[id]).filter(Boolean);

  // Agregar lotes que no estén en order (por seguridad)
  lots.forEach(l => { if (!order.includes(l.id)) reordered.push(l); });

  saveLots(reordered);
  res.json(reordered);
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS FOTOS
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/lots/:id/photos  →  sube una foto y la agrega al lote
app.post('/api/lots/:id/photos', auth, upload.single('photo'), (req, res) => {
  const lots = loadLots();
  const idx  = lots.findIndex(l => l.id === req.params.id);
  if (idx === -1) {
    // Borrar el archivo subido si el lote no existe
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Lote no encontrado' });
  }

  const photoUrl = `/uploads/${req.file.filename}`;
  lots[idx].photos.push(photoUrl);
  saveLots(lots);
  res.json({ url: photoUrl, photos: lots[idx].photos });
});

// DELETE /api/lots/:id/photos/:photoIndex  →  elimina una foto del lote
app.delete('/api/lots/:id/photos/:photoIndex', auth, (req, res) => {
  const lots     = loadLots();
  const idx      = lots.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Lote no encontrado' });

  const photoIdx = parseInt(req.params.photoIndex, 10);
  if (isNaN(photoIdx) || photoIdx < 0 || photoIdx >= lots[idx].photos.length)
    return res.status(400).json({ error: 'Índice de foto inválido' });

  const photoUrl = lots[idx].photos[photoIdx];
  deleteLocalPhoto(photoUrl);

  lots[idx].photos.splice(photoIdx, 1);
  saveLots(lots);
  res.json({ photos: lots[idx].photos });
});

// ── Utilidad: borrar archivo local ────────────────────────────────────────────
function deleteLocalPhoto(url) {
  if (url && url.startsWith('/uploads/')) {
    const filePath = path.join(UPLOADS_DIR, path.basename(url));
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch { /* ignorar */ }
    }
  }
}

// ── Iniciar servidor ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Servidor corriendo → http://localhost:${PORT}`);
  console.log(`🔐  Admin panel       → http://localhost:${PORT}/admin.html`);
  console.log(`📋  Landing page      → http://localhost:${PORT}/remate.html`);
  console.log(`\nUsuario admin: ${ADMIN_USER}`);
  console.log(`Contraseña:    ${process.env.ADMIN_PASS || 'madelan2026'}\n`);
});
