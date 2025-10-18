const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { all, get, run } = require('../db');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

function auth(req, res, next){
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({error:'No token'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e){ return res.status(401).json({error:'Invalid token'}); }
}

router.post('/login', async (req,res)=>{
  const { email, password } = req.body;
  try{
    const u = await get('SELECT * FROM users WHERE email=?', [email]);
    if(!u) return res.status(401).json({error:'Usuario no encontrado'});
    const ok = await bcrypt.compare(password, u.password_hash);
    if(!ok) return res.status(401).json({error:'Clave incorrecta'});
    const token = jwt.sign({ id: u.id, name: u.name, email: u.email }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: u.id, name: u.name, email: u.email }});
  }catch(e){ res.status(500).json({error: e.message}); }
});

router.get('/me', auth, async (req,res)=>{
  const u = await get('SELECT id, name, email, cc FROM users WHERE id=?', [req.user.id]);
  res.json(u);
});

router.get('/prescriptions', auth, async (req,res)=>{
  const rows = await all(`
    SELECT p.id, p.rx_number, m.code as med_code, m.name, m.form, m.strength,
           p.max_units, p.used_units, (p.max_units - p.used_units) as pending,
           p.dosage, p.frequency, p.valid_until
    FROM prescriptions p JOIN medicines m ON m.id=p.medicine_id
    WHERE p.user_id=?
    ORDER BY p.id DESC`, [req.user.id]);
  res.json(rows);
});

router.post('/prescriptions/refresh', auth, async (req,res)=>{
  const rows = await all(`SELECT id, medicine_id, max_units FROM prescriptions WHERE user_id=?`,[req.user.id]);
  for (const r of rows){
    const delivered = await get(`SELECT COALESCE(SUM(units),0) as u FROM deliveries WHERE user_id=? AND medicine_id=?`,[req.user.id, r.medicine_id]);
    await run(`UPDATE prescriptions SET used_units=? WHERE id=?`, [delivered.u, r.id]);
  }
  const fresh = await all(`
    SELECT p.id, p.rx_number, m.code as med_code, m.name, m.form, m.strength,
           p.max_units, p.used_units, (p.max_units - p.used_units) as pending,
           p.dosage, p.frequency, p.valid_until
    FROM prescriptions p JOIN medicines m ON m.id=p.medicine_id
    WHERE p.user_id=?`, [req.user.id]);
  res.json(fresh);
});

router.get('/dispensers', auth, async (req,res)=>{
  const meds = await all(`SELECT DISTINCT medicine_id FROM prescriptions WHERE user_id=? AND (max_units - used_units) > 0`, [req.user.id]);
  if (meds.length===0) return res.json([]);
  const medIds = meds.map(m=>m.medicine_id);
  const placeholders = medIds.map(()=>'?').join(',');
  const rows = await all(`
    SELECT d.id as dispenser_id, d.code as dispenser_code, d.name as dispenser_name, d.city, d.location, d.lat, d.lng,
           m.id as medicine_id, m.code as med_code, m.name as med_name, m.form, m.strength, 
           COALESCE(i.units,0) as stock
    FROM dispensers d
    CROSS JOIN medicines m
    LEFT JOIN inventory i ON i.dispenser_id=d.id AND i.medicine_id=m.id
    WHERE m.id IN (${placeholders})
    ORDER BY d.id, m.id
  `, medIds);
  res.json(rows);
});

router.post('/reservations', auth, async (req,res)=>{
  const { dispenser_id, items } = req.body;
  const groupId = uuidv4();
  const code = String(Math.floor(100000 + Math.random()*900000));
  const expires = new Date(Date.now()+10*60*1000).toISOString().slice(0,19).replace('T',' ');
  const created = [];
  for(const it of items){
    const p = await get(`SELECT * FROM prescriptions WHERE user_id=? AND medicine_id=?`, [req.user.id, it.medicine_id]);
    if(!p) continue;
    const inv = await get(`SELECT COALESCE(units,0) as stock FROM inventory WHERE dispenser_id=? AND medicine_id=?`, [dispenser_id, it.medicine_id]) || {stock:0};
    const pending = Math.max(p.max_units - p.used_units, 0);
    const take = Math.min(pending, inv.stock);
    if (take<=0) continue;
    const id = uuidv4();
    await run(`INSERT INTO reservations (id, group_id, user_id, dispenser_id, medicine_id, units, status, pickup_code, pickup_expires_at)
               VALUES (?,?,?,?,?,?, 'PENDING', ?, ?)`, [id, groupId, req.user.id, dispenser_id, it.medicine_id, take, code, expires]);
    created.push({ id, medicine_id: it.medicine_id, units: take });
  }
  if (created.length===0) return res.status(400).json({error:'Sin unidades reservadas'});
  res.json({ group_id: groupId, code, expires, items: created });
});

router.get('/reservations/:code/qr', auth, async (req,res)=>{
  const payload = { code: req.params.code, user: req.user.id };
  const content = JSON.stringify(payload);
  res.setHeader('Content-Type', 'image/png');
  QRCode.toFileStream(res, content);
});

router.get('/reservations/:code/pdf', auth, async (req,res)=>{
  const code = req.params.code;
  const rows = await all(`SELECT r.*, d.name as dispenser, d.location, m.name as med, m.code as med_code
                          FROM reservations r
                          JOIN dispensers d ON d.id=r.dispenser_id
                          JOIN medicines m ON m.id=r.medicine_id
                          WHERE r.user_id=? AND r.pickup_code=?`, [req.user.id, code]);
  if (rows.length===0) return res.status(404).send('No encontrado');
  const doc = new PDFDocument();
  res.setHeader('Content-Type','application/pdf');
  doc.pipe(res);
  doc.fontSize(18).text('MediStock - Comprobante de Reserva', {align:'center'});
  doc.moveDown();
  doc.text(`Código de retiro: ${code}`);
  doc.text(`Dispensador: ${rows[0].dispenser} - ${rows[0].location}`);
  doc.text(`Vence: ${rows[0].pickup_expires_at}`);
  doc.moveDown();
  doc.fontSize(14).text('Medicamentos reservados:');
  rows.forEach(r => doc.text(`- ${r.med} (${r.med_code})  Unidades: ${r.units}`));
  doc.moveDown();
  doc.fontSize(14).text('Pendientes restantes (por medicamento):');
  doc.fontSize(12);
  for(const r of rows){
    const p = await get(`SELECT max_units, used_units FROM prescriptions WHERE user_id=? AND medicine_id=?`, [req.user.id, r.medicine_id]);
    const pending = Math.max(p.max_units - p.used_units - r.units, 0);
    doc.text(`• ${r.med}: pendiente tras reserva = ${pending}`);
  }
  doc.end();
});

router.post('/pickup', auth, async (req,res)=>{
  const { code } = req.body;
  const rs = await all(`SELECT * FROM reservations WHERE user_id=? AND pickup_code=? AND status='PENDING'`, [req.user.id, code]);
  if (rs.length===0) return res.status(404).json({error:'Reserva no encontrada o ya entregada'});
  const now = new Date();
  const expire = new Date(rs[0].pickup_expires_at.replace(' ','T')+'Z');
  if (now>expire) return res.status(400).json({error:'Código vencido'});

  for(const r of rs){
    await run(`UPDATE inventory SET units = units - ? WHERE dispenser_id=? AND medicine_id=?`, [r.units, r.dispenser_id, r.medicine_id]);
    const id = require('uuid').v4();
    await run(`INSERT INTO deliveries (id, reservation_id, user_id, dispenser_id, medicine_id, units)
               VALUES (?,?,?,?,?,?)`, [id, r.id, r.user_id, r.dispenser_id, r.medicine_id, r.units]);
    await run(`UPDATE reservations SET status='DELIVERED' WHERE id=?`, [r.id]);
    await run(`UPDATE prescriptions SET used_units = used_units + ? WHERE user_id=? AND medicine_id=?`, [r.units, r.user_id, r.medicine_id]);
  }
  res.json({ ok:true, delivered: rs.length });
});

router.get('/deliveries', auth, async (req,res)=>{
  const rows = await all(`
    SELECT d.delivered_at, disp.name as dispenser, m.name as med, m.code as med_code, d.units
    FROM deliveries d
    JOIN dispensers disp ON disp.id=d.dispenser_id
    JOIN medicines m ON m.id=d.medicine_id
    WHERE d.user_id=?
    ORDER BY d.delivered_at DESC`, [req.user.id]);
  res.json(rows);
});

router.get('/suggestions', auth, async (req,res)=>{
  const pending = await all(`
    SELECT p.medicine_id, (p.max_units - p.used_units) as pending
    FROM prescriptions p WHERE p.user_id=? AND (p.max_units - p.used_units)>0`, [req.user.id]);
  if (pending.length===0) return res.json([]);
  const meds = pending.map(p=>p.medicine_id);
  const placeholders = meds.map(()=>'?').join(',');
  const rows = await all(`
    SELECT d.id as dispenser_id, d.name, d.lat, d.lng, m.id as medicine_id, m.name as med, COALESCE(i.units,0) as stock
    FROM dispensers d
    JOIN medicines m ON m.id IN (${placeholders})
    LEFT JOIN inventory i ON i.dispenser_id=d.id AND i.medicine_id=m.id
    WHERE COALESCE(i.units,0) > 0
    ORDER BY stock DESC`, meds);
  res.json(rows);
});

module.exports = router;

router.get('/profile', auth, async (req,res)=>{
  try{
    const u = await get(`SELECT id, cc, name, email, dob, gender, eps, ips, phone, address, city, emergency_contact, emergency_phone, blood_type, created_at
                          FROM users WHERE id=?`, [req.user.id]);
    res.json(u);
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/profile', auth, async (req,res)=>{
  try{
    const { name, email, cc, dob, gender, eps, ips, phone, address, city, emergency_contact, emergency_phone, blood_type } = req.body || {};
    function s(v){ return (typeof v === 'string') ? v.trim() : v; }
    await run(`UPDATE users SET
        name=?, email=?, cc=?, dob=?, gender=?, eps=?, ips=?, phone=?, address=?, city=?, emergency_contact=?, emergency_phone=?, blood_type=?
      WHERE id=?`, [s(name), s(email), s(cc), s(dob), s(gender), s(eps), s(ips), s(phone), s(address), s(city), s(emergency_contact), s(emergency_phone), s(blood_type), req.user.id]);
    const u = await get(`SELECT id, cc, name, email, dob, gender, eps, ips, phone, address, city, emergency_contact, emergency_phone, blood_type, created_at
                          FROM users WHERE id=?`, [req.user.id]);
    res.json(u);
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/profile/password', auth, async (req,res)=>{
  try{
    const { old_password, new_password } = req.body || {};
    if(!(old_password && new_password)) return res.status(400).json({error:'Datos incompletos'});
    const u = await get('SELECT * FROM users WHERE id=?', [req.user.id]);
    const ok = await require('bcryptjs').compare(old_password, u.password_hash);
    if(!ok) return res.status(401).json({error:'Contraseña actual incorrecta'});
    const hash = await require('bcryptjs').hash(new_password, 10);
    await run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});
