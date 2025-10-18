// server.js — MediStock (Render + SQLite temporal)
const express = require('express');
const cors = require('cors');
const path = require('path');

// Al requerir './db' se inicializa la BD y tablas (singleton)
const db = require('./db');
const api = require('./routes/api');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rutas API
app.use('/api', api);

// Healthcheck simple que comprueba la BD
app.get('/health', (req, res) => {
  db.get('SELECT 1 AS ok', (err, row) => {
    if (err) return res.status(500).json({ ok: false, error: err.message });
    res.json({ ok: true, db: row?.ok === 1 });
  });
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MediStock escuchando en puerto ${PORT}`);
});