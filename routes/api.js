const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { all, get, run } = require('../db');
const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';

// Helper de autenticación
function auth(req, res, next){
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({error:'No token'});
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch(e){ return res.status(401).json({error:'Invalid token'}); }
}

// --- Autenticación ---

router.post('/login', async (req,res)=>{
  const { email, password } = req.body;
  try{
    const u = await get('SELECT * FROM users WHERE email=?', [email]);
    if(!u) return res.status(401).json({error:'Usuario no encontrado'});
    const ok = await bcrypt.compare(password, u.password_hash);
    if(!ok) return res.status(401).json({error:'Clave incorrecta'});
    const token = jwt.sign({ id: u.id, name: u.name, email: u.email }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: u.id, name: u.name, email: u.email } });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// --- Nuevo endpoint para verificar cédula y contraseña ---
router.post('/dispenser/login', async (req,res)=>{
  const { cc, password } = req.body;
  try{
    const u = await get('SELECT * FROM users WHERE cc=?', [cc]);
    if(!u) return res.status(401).json({error:'Cédula no encontrada'});
    const ok = await bcrypt.compare(password, u.password_hash);
    if(!ok) return res.status(401).json({error:'Clave incorrecta'});
    res.json({ ok: true, user: { id: u.id, name: u.name, cc: u.cc } });
  }catch(e){ res.status(500).json({error:e.message}); }
});

// --- Perfil ---

router.get('/me', auth, async (req,res)=>{
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
    if(!ok) return res.status(401).json({error:'Clave actual incorrecta'});
    const hash = await bcrypt.hash(new_password, 10);
    await run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
    res.json({ok:true});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// --- Prescripciones (Fórmulas) ---

router.get('/prescriptions', auth, async (req,res)=>{
  try{
    const rows = await all(`SELECT 
        p.rx_number, p.max_units, p.used_units, p.dosage, p.frequency,
        m.id as medicine_id, m.code as med_code, m.name, m.form, m.strength,
        (p.max_units - p.used_units) as pending
      FROM prescriptions p
      JOIN medicines m ON m.id = p.medicine_id
      WHERE p.user_id=?`, [req.user.id]);
    res.json(rows);
  }catch(e){ res.status(500).json({error:e.message}); }
});

router.post('/prescriptions/refresh', auth, async (req,res)=>{
  // Simulación: No se hace nada, solo se vuelve a cargar el estado actual.
  try{
    const rows = await all(`SELECT 
        p.rx_number, p.max_units, p.used_units, p.dosage, p.frequency,
        m.id as medicine_id, m.code as med_code, m.name, m.form, m.strength,
        (p.max_units - p.used_units) as pending
      FROM prescriptions p
      JOIN medicines m ON m.id = p.medicine_id
      WHERE p.user_id=?`, [req.user.id]);
    res.json(rows);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// --- Dispensadores e Inventario ---

router.get('/dispensers', auth, async (req,res)=>{
  try{
    const rows = await all(`SELECT 
        d.id as dispenser_id, 
        d.code as dispenser_code,
        d.name as dispenser_name, 
        d.city,
        d.location, 
        d.lat, 
        d.lng,
        m.id as medicine_id, 
        m.code as med_code, 
        m.name as med_name, 
        m.form, 
        m.strength,
        COALESCE(i.units, 0) as stock
      FROM dispensers d
      CROSS JOIN medicines m
      LEFT JOIN inventory i ON i.dispenser_id = d.id AND i.medicine_id = m.id
      WHERE COALESCE(i.units, 0) > 0
      ORDER BY d.id, m.id`);
    res.json(rows);
  }catch(e){ 
    console.error('Dispensers error:', e);
    res.status(500).json({error:e.message}); 
  }
});

// --- Sugerencias ---

router.get('/suggestions', auth, async (req,res)=>{
  try{
    const pending = await all(`
      SELECT p.medicine_id, (p.max_units - p.used_units) as pending
      FROM prescriptions p WHERE p.user_id=? AND (p.max_units - p.used_units) > 0
    `, [req.user.id]);
    
    if (pending.length === 0) return res.json([]);
    
    const meds = pending.map(p => p.medicine_id);
    const placeholders = meds.map(() => '?').join(',');
    
    const rows = await all(`
      SELECT 
        d.id as dispenser_id, 
        d.name, 
        d.lat, 
        d.lng, 
        m.id as medicine_id, 
        m.name as med, 
        COALESCE(i.units, 0) as stock
      FROM dispensers d
      JOIN medicines m ON m.id IN (${placeholders})
      LEFT JOIN inventory i ON i.dispenser_id = d.id AND i.medicine_id = m.id
      WHERE COALESCE(i.units, 0) > 0
      ORDER BY stock DESC
    `, meds);
    
    res.json(rows);
  }catch(e){ 
    console.error('Suggestions error:', e);
    res.status(500).json({error:e.message}); 
  }
});

// --- Reservas ---

router.post('/reservations', auth, async (req,res)=>{
  const { dispenser_id, items } = req.body || {};
  if(!dispenser_id || !Array.isArray(items) || items.length === 0) return res.status(400).json({error:'Datos de reserva incompletos.'});

  // Validaciones
  for(const item of items){
    if(!item.medicine_id || item.units <= 0) return res.status(400).json({error:'Unidades a reservar inválidas.'});
    // Verificar stock
    const stock = await get(`SELECT units FROM inventory WHERE dispenser_id=? AND medicine_id=?`, [dispenser_id, item.medicine_id]);
    if(!stock || stock.units < item.units) return res.status(400).json({error:`Stock insuficiente para Med ID ${item.medicine_id}.`});
    // Verificar pendientes (fórmula)
    const formula = await get(`SELECT (max_units - used_units) as pending_units 
                               FROM prescriptions 
                               WHERE user_id=? AND medicine_id=?`, [req.user.id, item.medicine_id]);
    if(!formula || formula.pending_units < item.units) return res.status(400).json({error:`Unidades solicitadas exceden tus pendientes para Med ID ${item.medicine_id}.`});
  }

  // Creación de reserva
  try{
    const reservation_id = uuidv4();
    const code = Math.random().toString(36).substring(2,8).toUpperCase();
    const expires_at = new Date(Date.now() + 24*60*60*1000).toISOString(); // 24 horas

    await run('BEGIN TRANSACTION');
    
    await run(`INSERT INTO reservations (id, user_id, dispenser_id, expires_at, code) VALUES (?, ?, ?, ?, ?)`, 
              [reservation_id, req.user.id, dispenser_id, expires_at, code]);

    for(const item of items){
      await run(`INSERT INTO reservation_items (reservation_id, medicine_id, units) VALUES (?, ?, ?)`, 
                [reservation_id, item.medicine_id, item.units]);
      
      // *** 1. DESCUENTO DE STOCK DEL DISPENSADOR (REQUERIMIENTO 4) ***
      await run(`UPDATE inventory SET units = units - ? 
                 WHERE dispenser_id = ? AND medicine_id = ?`, 
                [item.units, dispenser_id, item.medicine_id]);
    }
    
    await run('COMMIT');
    
    res.json({ id: reservation_id, code, expires: expires_at.slice(0,19).replace('T',' '), ok:true });

  }catch(e){ 
    await run('ROLLBACK');
    res.status(500).json({error:e.message}); 
  }
});

// --- Retiro (Pickup) ---

router.post('/pickup', auth, async (req,res)=>{
  const { code } = req.body || {};
  if(!code) return res.status(400).json({error:'Código de retiro requerido.'});

  try {
    await run('BEGIN TRANSACTION');
    
    // 1. Buscar la reserva con el código
    const reservation = await get(`SELECT * FROM reservations WHERE code=? AND status='PENDING'`, [code]);
    if(!reservation) {
      await run('ROLLBACK');
      return res.status(404).json({error:'Reserva no encontrada o ya fue entregada.'});
    }
    
    // 2. Verificar que no esté expirada
    const now = new Date();
    const expireDate = new Date(reservation.expires_at);
    if (now > expireDate) {
      await run('ROLLBACK');
      return res.status(400).json({error:'La reserva ha expirado.'});
    }
    
    // 3. Obtener los ítems de la reserva
    const resItems = await all(`SELECT * FROM reservation_items WHERE reservation_id=?`, [reservation.id]);
    if(resItems.length === 0) {
      await run('ROLLBACK');
      return res.status(400).json({error:'Reserva sin ítems.'});
    }

    let totalUnits = 0;
    
    // 4. Procesar cada ítem de la reserva
    for (const item of resItems) {
      // Verificar stock actual (por seguridad)
      const currentStock = await get(`SELECT units FROM inventory WHERE dispenser_id=? AND medicine_id=?`, 
                                   [reservation.dispenser_id, item.medicine_id]);
      
      if (!currentStock || currentStock.units <= 0) {
        await run('ROLLBACK');
        return res.status(400).json({error:`Stock insuficiente para uno de los medicamentos.`});
      }

      // 5. ACTUALIZAR LA PRESCRIPCIÓN (incrementar used_units) - ESTO ES CLAVE
      const updateResult = await run(`UPDATE prescriptions 
                                     SET used_units = used_units + ? 
                                     WHERE user_id=? AND medicine_id=?`, 
                                    [item.units, reservation.user_id, item.medicine_id]);
      
      console.log(`Actualizada prescripción: usuario=${reservation.user_id}, medicina=${item.medicine_id}, unidades=${item.units}`);
      
      // 6. CREAR REGISTRO DE ENTREGA en la tabla deliveries
      const deliveryId = uuidv4();
      await run(`INSERT INTO deliveries (id, reservation_id, user_id, dispenser_id, medicine_id, units, delivered_at) 
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
                [deliveryId, reservation.id, reservation.user_id, reservation.dispenser_id, item.medicine_id, item.units]);
      
      console.log(`Creada entrega: ${deliveryId} para medicina ${item.medicine_id}`);
      
      totalUnits += item.units;
    }

    // 7. MARCAR LA RESERVA COMO ENTREGADA
    await run(`UPDATE reservations SET status='DELIVERED' WHERE id=?`, [reservation.id]);
    
    await run('COMMIT');
    
    console.log(`Pickup completado: ${resItems.length} medicamentos, ${totalUnits} unidades totales`);
    
    res.json({
      ok: true, 
      delivered: resItems.length, 
      totalUnits: totalUnits,
      reservation_id: reservation.id,
      message: `Entrega confirmada: ${resItems.length} medicamento(s), ${totalUnits} unidad(es) totales`
    });
    
  } catch(e) { 
    await run('ROLLBACK');
    console.error('Pickup error completo:', e);
    res.status(500).json({error: 'Error interno durante el retiro: ' + e.message}); 
  }
});

// --- NUEVO: Endpoint para obtener detalles de reserva ---
router.get('/reservations/:code/details', auth, async (req, res) => {
  try {
    const code = req.params.code;
    
    // Obtener información de la reserva
    const reservation = await get(`
      SELECT r.*, u.name as patientName, d.name as dispenserName
      FROM reservations r
      JOIN users u ON u.id = r.user_id
      JOIN dispensers d ON d.id = r.dispenser_id
      WHERE r.code = ?
    `, [code]);
    
    if (!reservation) {
      return res.status(404).json({ error: 'Reserva no encontrada' });
    }
    
    // Obtener items de la reserva
    const items = await all(`
      SELECT ri.units, m.name, m.code, m.form, m.strength
      FROM reservation_items ri
      JOIN medicines m ON m.id = ri.medicine_id
      WHERE ri.reservation_id = ?
    `, [reservation.id]);
    
    // Calcular total de unidades
    const totalUnits = items.reduce((sum, item) => sum + item.units, 0);
    
    res.json({
      patientName: reservation.patientName,
      dispenserName: reservation.dispenserName,
      medications: items.map(item => ({
        name: `${item.name} (${item.code}) - ${item.form} ${item.strength}`,
        units: item.units
      })),
      totalUnits: totalUnits,
      createdAt: reservation.created_at,
      expiresAt: reservation.expires_at
    });
    
  } catch(e) {
    console.error('Error obteniendo detalles de reserva:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- NUEVO: Generar PDF de entrega con pendientes y alternativas ---
router.get('/deliveries/:reservation_id/pdf', async (req, res) => {
  try {
    const reservation_id = req.params.reservation_id;
    
    console.log('Generando PDF de entrega para reserva:', reservation_id);
    
    // 1. Obtener información de la entrega
    const reservation = await get(`
      SELECT r.*, u.name as patient_name, u.cc, d.name as dispenser_name, d.location
      FROM reservations r
      JOIN users u ON u.id = r.user_id
      JOIN dispensers d ON d.id = r.dispenser_id
      WHERE r.id = ?
    `, [reservation_id]);
    
    if (!reservation) {
      console.log('Reserva no encontrada:', reservation_id);
      return res.status(404).send('Reserva no encontrada');
    }
    
    // 2. Obtener medicamentos entregados
    const deliveredMeds = await all(`
      SELECT m.name, m.code, m.form, m.strength, d.units
      FROM deliveries d
      JOIN medicines m ON m.id = d.medicine_id
      WHERE d.reservation_id = ?
    `, [reservation_id]);
    
    // 3. Obtener medicamentos pendientes del usuario
    const pendingMeds = await all(`
      SELECT 
        p.rx_number,
        m.name, 
        m.code, 
        m.form, 
        m.strength,
        (p.max_units - p.used_units) as pending_units,
        p.max_units,
        p.used_units
      FROM prescriptions p
      JOIN medicines m ON m.id = p.medicine_id
      WHERE p.user_id = ? AND (p.max_units - p.used_units) > 0
    `, [reservation.user_id]);
    
    // 4. Obtener alternativas para medicamentos pendientes
    let alternatives = [];
    if (pendingMeds.length > 0) {
      const medIds = pendingMeds.map(med => med.code);
      const placeholders = medIds.map(() => '?').join(',');
      
      alternatives = await all(`
        SELECT 
          d.name as dispenser_name,
          d.location,
          d.lat,
          d.lng,
          m.name as med_name,
          m.code as med_code,
          i.units as stock
        FROM inventory i
        JOIN dispensers d ON d.id = i.dispenser_id
        JOIN medicines m ON m.id = i.medicine_id
        WHERE m.code IN (${placeholders}) AND i.units > 0
        ORDER BY m.name, i.units DESC
      `, medIds);
    }
    
    // 5. Configurar respuesta HTTP
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Comprobante_Entrega_${reservation_id.slice(0,8)}.pdf"`);

    // 6. Generar PDF
    const doc = new PDFDocument();
    doc.pipe(res);

    // Logo y título
    doc.fontSize(20).text('MEDISTOCK', { align: 'center' });
    doc.fontSize(16).text('COMPROBANTE DE ENTREGA', { align: 'center' }).moveDown();
    
    // Línea separadora
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();
    
    // Información de la entrega
    doc.fontSize(12)
       .text(`Fecha de entrega: ${new Date().toLocaleString('es-CO')}`)
       .text(`Paciente: ${reservation.patient_name}`)
       .text(`Documento: ${reservation.cc}`)
       .text(`Dispensador: ${reservation.dispenser_name}`)
       .text(`Ubicación: ${reservation.location}`)
       .moveDown();

    // Medicamentos entregados
    doc.fontSize(14).text('MEDICAMENTOS ENTREGADOS', { underline: true }).moveDown(0.3);
    doc.fontSize(12);
    
    if (deliveredMeds.length === 0) {
      doc.text('No se entregaron medicamentos en esta transacción.');
    } else {
      deliveredMeds.forEach((med, index) => {
        doc.text(`${index + 1}. ${med.name} (${med.code})`);
        doc.text(`   Presentación: ${med.form} ${med.strength}`);
        doc.text(`   Unidades entregadas: ${med.units}`);
        doc.moveDown(0.2);
      });
    }
    
    doc.moveDown();

    // Medicamentos pendientes
    doc.fontSize(14).text('MEDICAMENTOS PENDIENTES', { underline: true }).moveDown(0.3);
    doc.fontSize(12);
    
    if (pendingMeds.length === 0) {
      doc.text('No tienes medicamentos pendientes en tus fórmulas.').moveDown();
    } else {
      pendingMeds.forEach((med, index) => {
        doc.text(`${index + 1}. ${med.name} (${med.code})`);
        doc.text(`   Presentación: ${med.form} ${med.strength}`);
        doc.text(`   Fórmula: ${med.rx_number}`);
        doc.text(`   Pendientes: ${med.pending_units} de ${med.max_units} unidades`);
        doc.moveDown(0.2);
      });
    }
    
    doc.moveDown();

    // Alternativas de dispensadores
    if (alternatives.length > 0) {
      doc.fontSize(14).text('ALTERNATIVAS PARA RETIRAR PENDIENTES', { underline: true }).moveDown(0.3);
      doc.fontSize(12);
      
      // Agrupar alternativas por medicamento
      const medAlternatives = {};
      alternatives.forEach(alt => {
        if (!medAlternatives[alt.med_name]) {
          medAlternatives[alt.med_name] = [];
        }
        medAlternatives[alt.med_name].push(alt);
      });
      
      Object.keys(medAlternatives).forEach((medName, medIndex) => {
        doc.text(`${medIndex + 1}. ${medName}:`);
        medAlternatives[medName].forEach((alt, altIndex) => {
          doc.text(`   ${altIndex + 1}. ${alt.dispenser_name} - ${alt.location}`);
          doc.text(`      Stock disponible: ${alt.stock} unidades`);
        });
        doc.moveDown(0.2);
      });
    }

    // Instrucciones finales
    doc.moveDown(1);
    doc.fontSize(10)
       .text('INFORMACIÓN IMPORTANTE:', { align: 'center', underline: true })
       .moveDown(0.3)
       .text('• Este comprobante certifica la entrega de los medicamentos listados', { align: 'center' })
       .text('• Los medicamentos pendientes pueden ser reclamados en cualquier dispensador con stock disponible', { align: 'center' })
       .text('• Presente este documento si requiere soporte o aclaraciones', { align: 'center' })
       .moveDown(0.5)
       .text('¡Gracias por usar MediStock!', { align: 'center' });

    doc.end();
    
    console.log('PDF de entrega generado exitosamente para reserva:', reservation_id);

  } catch (e) {
    console.error('Error completo al generar PDF de entrega:', e);
    res.status(500).send('Error al generar el PDF: ' + e.message);
  }
});

// --- Generación de PDF de reserva ---

router.get('/reservations/:code/pdf', async (req, res) => {
    try {
        const code = req.params.code;
        
        console.log('Generando PDF para código:', code);
        
        // 1. Obtener la reserva principal (sin auth, solo por código)
        const reservation = await get(`SELECT * FROM reservations WHERE code=?`, [code]);
        if (!reservation) { 
            console.log('Reserva no encontrada para código:', code);
            return res.status(404).send('Reserva no encontrada'); 
        }
        
        console.log('Reserva encontrada:', reservation.id);
        
        // 2. Obtener los ítems de la reserva
        const resItems = await all(`
            SELECT ri.medicine_id, ri.units, m.name as med_name, m.code as med_code, m.form, m.strength 
            FROM reservation_items ri 
            JOIN medicines m ON m.id = ri.medicine_id 
            WHERE ri.reservation_id = ?
        `, [reservation.id]);
        
        console.log('Ítems de reserva encontrados:', resItems.length);
        
        if (resItems.length === 0) {
            return res.status(404).send('No se encontraron medicamentos en la reserva');
        }
        
        // 3. Obtener datos del dispensador
        const dispenser = await get(`SELECT name, location, lat, lng FROM dispensers WHERE id=?`, [reservation.dispenser_id]);
        console.log('Dispensador:', dispenser);
        
        // 4. Obtener datos del usuario
        const user = await get(`SELECT name, cc, phone, address FROM users WHERE id=?`, [reservation.user_id]);
        console.log('Usuario:', user);

        // 5. Configurar la respuesta HTTP
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Reserva_${code}.pdf"`);

        // 6. Generar el PDF
        const doc = new PDFDocument();
        doc.pipe(res);

        // Logo y título
        doc.fontSize(20).text('MEDISTOCK', { align: 'center' });
        doc.fontSize(16).text('Comprobante de Reserva', { align: 'center' }).moveDown();
        
        // Línea separadora
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke().moveDown();
        
        // Información básica
        doc.fontSize(12)
           .text(`CÓDIGO DE RETIRO: ${code}`, { align: 'center', underline: true })
           .moveDown(0.5)
           .text(`Fecha de reserva: ${reservation.created_at ? reservation.created_at.slice(0,16).replace('T',' ') : new Date().toLocaleString()}`)
           .text(`Válido hasta: ${reservation.expires_at ? reservation.expires_at.slice(0,16).replace('T',' ') : 'N/A'}`)
           .moveDown();

        // Datos del paciente
        doc.fontSize(14).text('DATOS DEL PACIENTE', { underline: true }).moveDown(0.3);
        doc.fontSize(12)
           .text(`Nombre: ${user.name || 'N/A'}`)
           .text(`Documento: ${user.cc || 'N/A'}`)
           .text(`Teléfono: ${user.phone || 'N/A'}`)
           .text(`Dirección: ${user.address || 'N/A'}`)
           .moveDown();

        // Datos del dispensador
        doc.fontSize(14).text('PUNTO DE RETIRO', { underline: true }).moveDown(0.3);
        doc.fontSize(12)
           .text(`Dispensador: ${dispenser.name || 'N/A'}`)
           .text(`Ubicación: ${dispenser.location || 'N/A'}`);
        
        if (dispenser.lat && dispenser.lng) {
            doc.text(`Coordenadas: ${dispenser.lat.toFixed(4)}, ${dispenser.lng.toFixed(4)}`);
        }
        doc.moveDown();

        // Medicamentos reservados
        doc.fontSize(14).text('MEDICAMENTOS RESERVADOS', { underline: true }).moveDown(0.3);
        doc.fontSize(12);
        
        let totalUnidades = 0;
        resItems.forEach((item, index) => {
            doc.text(`${index + 1}. ${item.med_name} (${item.med_code})`);
            doc.text(`   Presentación: ${item.form} ${item.strength}`);
            doc.text(`   Unidades: ${item.units}`);
            doc.moveDown(0.2);
            totalUnidades += item.units;
        });

        // Total
        doc.moveDown(0.5);
        doc.fontSize(12).text(`TOTAL DE UNIDADES: ${totalUnidades}`, { align: 'right' });

        // Instrucciones finales
        doc.moveDown(1);
        doc.fontSize(10)
           .text('INSTRUCCIONES:', { align: 'center', underline: true })
           .moveDown(0.3)
           .text('1. Presente este documento en el dispensador indicado', { align: 'center' })
           .text('2. Muestre el código de retiro al personal autorizado', { align: 'center' })
           .text('3. El código es válido por 24 horas desde la reserva', { align: 'center' })
           .moveDown(0.5)
           .text('¡Gracias por usar MediStock!', { align: 'center' });

        doc.end();
        
        console.log('PDF generado exitosamente para código:', code);

    } catch (e) {
        console.error('Error completo al generar PDF:', e);
        res.status(500).send('Error al generar el PDF: ' + e.message);
    }
});

// --- QR Code ---

router.get('/reservations/:code/qr', async (req,res)=>{
  try {
    const payload = { code: req.params.code };
    const content = JSON.stringify(payload);
    res.setHeader('Content-Type', 'image/png');
    QRCode.toFileStream(res, content);
  } catch(e) {
    res.status(500).json({error: e.message});
  }
});

// --- Historial ---

router.get('/deliveries', auth, async (req,res)=>{
  try{
    const rows = await all(`
      SELECT 
        d.delivered_at, 
        disp.name as dispenser, 
        m.name as med, 
        m.code as med_code, 
        d.units
      FROM deliveries d
      JOIN dispensers disp ON disp.id = d.dispenser_id
      JOIN medicines m ON m.id = d.medicine_id
      WHERE d.user_id = ?
      ORDER BY d.delivered_at DESC
    `, [req.user.id]);
    res.json(rows);
  }catch(e){ 
    console.error('Deliveries error:', e);
    res.status(500).json({error:e.message}); 
  }
});

module.exports = router;