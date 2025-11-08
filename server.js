const express = require('express');
const cors = require('cors');
const path = require('path');
const api = require('./routes/api');
const { get, initDb, ready } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/', express.static(path.join(__dirname, 'public')));

initDb().then(()=>{
  app.use('/api', api);

  app.get('/health', async (req, res) => {
    try { await ready; await get('SELECT 1'); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`MediStock running on http://localhost:${PORT}`));
}).catch(err => {
  console.error('Fatal DB init error:', err);
  process.exit(1);
});