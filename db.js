const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'medistock.db');
const db = new sqlite3.Database(dbPath);
const fs = require('fs');
const DB_PATH = path.join(__dirname, 'data', 'medistock.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

function run(sql, params=[]) { return new Promise((res, rej)=>db.run(sql, params, function(e){ e?rej(e):res(this); })); }
function get(sql, params=[]) { return new Promise((res, rej)=>db.get(sql, params, (e,row)=>{ e?rej(e):res(row); })); }
function all(sql, params=[]) { return new Promise((res, rej)=>db.all(sql, params, (e,rows)=>{ e?rej(e):res(rows); })); }
function exec(sql) { return new Promise((res, rej)=>db.exec(sql, (e)=>{ e?rej(e):res(true); })); }

const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, cc TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), dob TEXT, gender TEXT, eps TEXT, ips TEXT, phone TEXT, address TEXT, city TEXT, emergency_contact TEXT, emergency_phone TEXT, blood_type TEXT);

CREATE TABLE IF NOT EXISTS medicines (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, atc TEXT, name TEXT NOT NULL, form TEXT, strength TEXT);
CREATE TABLE IF NOT EXISTS dispensers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, city TEXT, location TEXT, lat REAL, lng REAL, open_days TEXT, open_hour TEXT, close_hour TEXT);
CREATE TABLE IF NOT EXISTS inventory (dispenser_id INTEGER, medicine_id INTEGER, units INTEGER NOT NULL, PRIMARY KEY(dispenser_id, medicine_id), FOREIGN KEY (dispenser_id) REFERENCES dispensers(id), FOREIGN KEY (medicine_id) REFERENCES medicines(id));

CREATE TABLE IF NOT EXISTS prescriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, rx_number TEXT NOT NULL, user_id INTEGER NOT NULL, medicine_id INTEGER NOT NULL, max_units INTEGER NOT NULL, used_units INTEGER NOT NULL DEFAULT 0, dosage TEXT, frequency TEXT, start_date TEXT, end_date TEXT, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (medicine_id) REFERENCES medicines(id));

CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, dispenser_id INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'PENDING', expires_at TEXT, code TEXT UNIQUE, FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (dispenser_id) REFERENCES dispensers(id));
CREATE TABLE IF NOT EXISTS reservation_items (reservation_id TEXT NOT NULL, medicine_id INTEGER NOT NULL, units INTEGER NOT NULL, PRIMARY KEY (reservation_id, medicine_id), FOREIGN KEY (reservation_id) REFERENCES reservations(id), FOREIGN KEY (medicine_id) REFERENCES medicines(id));

CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, user_id INTEGER NOT NULL, dispenser_id INTEGER NOT NULL, medicine_id INTEGER NOT NULL, units INTEGER NOT NULL, delivered_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (reservation_id) REFERENCES reservations(id), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (dispenser_id) REFERENCES dispensers(id), FOREIGN KEY (medicine_id) REFERENCES medicines(id));
`;

async function initDb(){
  await exec(schema);
  const bcrypt = require('bcryptjs');
  
  // CORREGIR: Usar la misma contraseña que en el login
  const hashAna = await bcrypt.hash('ana12345', 10);
  const hashAdmin = await bcrypt.hash('admin123', 10);
  
  // Usuarios - ACTUALIZAR CÉDULA DE ANA A 12345678
  await run("INSERT OR IGNORE INTO users(cc, name, email, password_hash) VALUES(?,?,?,?)", 
            ['12345678', 'Ana Paciente', 'ana@medistock.local', hashAna]);
  await run("INSERT OR IGNORE INTO users(cc, name, email, password_hash) VALUES(?,?,?,?)", 
            ['2098765432', 'Admin User', 'admin@medistock.local', hashAdmin]);
  
  // Dispensadores
  await run("INSERT OR IGNORE INTO dispensers(id, code, name, city, location, lat, lng) VALUES(1, 'DISP001', 'Disp. Av. 27', 'Bucaramanga', 'Av. 27 #15-45', 7.1180, -73.1220)");
  await run("INSERT OR IGNORE INTO dispensers(id, code, name, city, location, lat, lng) VALUES(2, 'DISP002', 'Disp. Cabecera', 'Bucaramanga', 'C.C. Cabecera', 7.0700, -73.0980)");
  await run("INSERT OR IGNORE INTO dispensers(id, code, name, city, location, lat, lng) VALUES(3, 'DISP003', 'Disp. UIS', 'Bucaramanga', 'UIS Entrada Principal', 7.1390, -73.1210)");
  
  // Medicamentos
  await run(`INSERT OR IGNORE INTO medicines(id, code, atc, name, form, strength) VALUES
    (1,'ACET500TAB','N02B','Acetaminofén','Tableta','500 mg'),
    (2,'METF850TAB','A10B','Metformina','Tableta','850 mg'),
    (3,'ENAL10TAB','C09A','Enalapril','Tableta','10 mg'),
    (4,'AMOX500CAP','J01C','Amoxicilina','Cápsula','500 mg'),
    (5,'DEXT15SIR','R05D','Dextrometorfano','Jarabe','15 mg/5 ml')`);

  // Inventario inicial: 1000 unidades de todos los 5 medicamentos en los 3 dispensadores
  const dispenserIds = [1, 2, 3];
  const medicineCodes = ['ACET500TAB', 'METF850TAB', 'ENAL10TAB', 'AMOX500CAP', 'DEXT15SIR'];
  const initialStock = 1000;
  
  for (const medCode of medicineCodes) {
      for (const dispId of dispenserIds) {
          await run(`INSERT OR IGNORE INTO inventory(dispenser_id, medicine_id, units)
                     SELECT ?, id, ? FROM medicines WHERE code=?`, 
                    [dispId, initialStock, medCode]);
      }
  }

  // Prescripciones (Fórmulas) de Ana
  const ana = await get("SELECT id FROM users WHERE email='ana@medistock.local'");
  for (const p of [
    // max_units: 120, used: 0, pending: 120
    ['RX-A001','ACET500TAB',120,'500 mg','1 tableta cada 8 horas', 0], 
    // max_units: 90, used: 0, pending: 90
    ['RX-A002','METF850TAB',90,'850 mg','1 tableta 1 vez al día', 0], 
    // max_units: 30, used: 0, pending: 30
    ['RX-A003','ENAL10TAB',30,'10 mg','1 vez al día', 0],
    // max_units: 21, used: 0, pending: 21
    ['RX-A004','AMOX500CAP',21,'500 mg','3 veces al día por 7 días', 0],
    // max_units: 1, used: 0, pending: 1
    ['RX-A005','DEXT15SIR',1,'15 mg/5 ml','1 cucharada cada 6 horas', 0],
  ]){
    await run(`INSERT OR IGNORE INTO prescriptions(rx_number, user_id, medicine_id, max_units, used_units, dosage, frequency)
               SELECT ?, ?, id, ?, ?, ?, ? FROM medicines WHERE code=?`, 
               [p[0], ana.id, p[2], p[5], p[3], p[4], p[1]]);
  }
  
  // Campos de perfil extendidos para Ana
  await run(
    "UPDATE users SET phone=?, address=?, city=?, dob=?, gender=?, eps=?, ips=?, emergency_contact=?, emergency_phone=?, blood_type=? WHERE id=?",
    ['3001112233', 'Cra 10 # 20-30', 'Bucaramanga', '1996-05-12', 'F', 'Sura', 'IPS La Merced', 'María Paciente', '3002223344', 'O+', ana.id]
  );
  
  console.log('Base de datos inicializada correctamente');
  console.log('Usuario de prueba: ana@medistock.local / ana12345');
  console.log('Cédula de Ana: 12345678');
  console.log('Medicamentos creados:', medicineCodes.length);
  console.log('Dispensadores creados:', dispenserIds.length);
  console.log('Prescripciones creadas: 5');
}

module.exports = { get, run, all, exec, initDb, ready: Promise.resolve(true) };