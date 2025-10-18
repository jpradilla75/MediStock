const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'medistock.db');
const db = new sqlite3.Database(dbPath);

function run(sql, params=[]) { return new Promise((res, rej)=>db.run(sql, params, function(e){ e?rej(e):res(this); })); }
function get(sql, params=[]) { return new Promise((res, rej)=>db.get(sql, params, (e,row)=>{ e?rej(e):res(row); })); }
function all(sql, params=[]) { return new Promise((res, rej)=>db.all(sql, params, (e,rows)=>{ e?rej(e):res(rows); })); }
function exec(sql) { return new Promise((res, rej)=>db.exec(sql, (e)=>{ e?rej(e):res(true); })); }

const schema = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, cc TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS medicines (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, atc TEXT, name TEXT NOT NULL, form TEXT, strength TEXT);
CREATE TABLE IF NOT EXISTS dispensers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, city TEXT, location TEXT, lat REAL, lng REAL, open_days TEXT, open_hour TEXT, close_hour TEXT);
CREATE TABLE IF NOT EXISTS inventory (dispenser_id INTEGER, medicine_id INTEGER, units INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (dispenser_id, medicine_id), FOREIGN KEY (dispenser_id) REFERENCES dispensers(id) ON DELETE CASCADE, FOREIGN KEY (medicine_id) REFERENCES medicines(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS prescriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, rx_number TEXT, medicine_id INTEGER NOT NULL, max_units INTEGER NOT NULL, used_units INTEGER DEFAULT 0, valid_until TEXT, dosage TEXT, frequency TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (medicine_id) REFERENCES medicines(id));
CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, group_id TEXT, user_id INTEGER NOT NULL, dispenser_id INTEGER NOT NULL, medicine_id INTEGER NOT NULL, units INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', pickup_code TEXT, pickup_expires_at TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (dispenser_id) REFERENCES dispensers(id), FOREIGN KEY (medicine_id) REFERENCES medicines(id));
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, user_id INTEGER NOT NULL, dispenser_id INTEGER NOT NULL, medicine_id INTEGER NOT NULL, units INTEGER NOT NULL, delivered_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (reservation_id) REFERENCES reservations(id), FOREIGN KEY (user_id) REFERENCES users(id), FOREIGN KEY (dispenser_id) REFERENCES dispensers(id), FOREIGN KEY (medicine_id) REFERENCES medicines(id));
`;

let ready = null;

async function seedIfEmpty() {
  const row = await get("SELECT COUNT(1) as n FROM users").catch(()=>({n:0}));
  if (row && row.n > 0) return;
  const bcrypt = require('bcryptjs');
  const meds = [
    ['ACET500TAB','N02BE01','Acetaminofén','Tableta','500 mg'],
    ['METF850TAB','A10BA02','Metformina','Tableta','850 mg'],
    ['ENAL10TAB','C09AA05','Enalapril','Tableta','10 mg'],
    ['AMOX500CAP','J01CA04','Amoxicilina','Cápsula','500 mg'],
    ['DEXT15SIR','R05DA04','Dextrometorfano','Jarabe','15 mg/5 ml']
  ];
  for (const [code, atc, name, form, strength] of meds)
    await run('INSERT OR IGNORE INTO medicines (code, atc, name, form, strength) VALUES (?,?,?,?,?)',[code,atc,name,form,strength]);

  const dispensers = [
    ['BGA-001','Disp. Av. 27','Bucaramanga','Av. 27 #15-45',7.118,-73.122,'mon-sat','08:00','19:00'],
    ['BGA-002','Disp. Cañaveral','Floridablanca','C.C. Cañaveral',7.062,-73.086,'daily','10:00','21:00'],
    ['BGA-003','Disp. UIS','Bucaramanga','UIS Entrada Principal',7.139,-73.121,'mon-fri','07:00','18:00']
  ];
  for (const d of dispensers)
    await run('INSERT OR IGNORE INTO dispensers (code,name,city,location,lat,lng,open_days,open_hour,close_hour) VALUES (?,?,?,?,?,?,?,?,?)', d);

  const medsRows = await all('SELECT id, code FROM medicines');
  const dispRows = await all('SELECT id, code FROM dispensers');
  const medId = c => medsRows.find(m=>m.code===c).id;
  const dispId = c => dispRows.find(d=>d.code===c).id;

  const inv = [
    [dispId('BGA-001'), medId('ACET500TAB'), 10],
    [dispId('BGA-001'), medId('METF850TAB'), 5],
    [dispId('BGA-001'), medId('ENAL10TAB'), 10],
    [dispId('BGA-002'), medId('ACET500TAB'), 20],
    [dispId('BGA-002'), medId('AMOX500CAP'), 35],
    [dispId('BGA-003'), medId('METF850TAB'), 25],
    [dispId('BGA-003'), medId('ENAL10TAB'), 8],
    [dispId('BGA-003'), medId('DEXT15SIR'), 25]
  ];
  for (const row of inv)
    await run('INSERT OR REPLACE INTO inventory (dispenser_id, medicine_id, units, updated_at) VALUES (?,?,?, datetime("now"))', row);

  const u1 = ['100000001','Ana Paciente','ana@medistock.local', await bcrypt.hash('ana12345', 10)];
  const u2 = ['100000002','Carlos Paciente','carlos@medistock.local', await bcrypt.hash('carlos123', 10)];
  await run('INSERT OR IGNORE INTO users (cc,name,email,password_hash) VALUES (?,?,?,?)', u1);
  await run('INSERT OR IGNORE INTO users (cc,name,email,password_hash) VALUES (?,?,?,?)', u2);

  const ana = await get('SELECT id FROM users WHERE email=?', ['ana@medistock.local']);
  await run(`INSERT OR IGNORE INTO prescriptions (user_id, rx_number, medicine_id, max_units, valid_until, dosage, frequency)
             VALUES (?, 'RX-A001', ?, 30, '2099-12-31', '500 mg', 'cada 8 horas por 5 días')`, [ana.id, medId('ACET500TAB')]);
  await run(`INSERT OR IGNORE INTO prescriptions (user_id, rx_number, medicine_id, max_units, valid_until, dosage, frequency)
             VALUES (?, 'RX-A002', ?, 30, '2099-12-31', '850 mg', '2 veces al día')`, [ana.id, medId('METF850TAB')]);
}

async function initDb(){ await exec(schema); await seedIfEmpty(); await migrateAndSeedProfiles(); }
ready = initDb();
module.exports = { db, run, get, all, exec, initDb, ready };



async function ensureProfileColumns(){
  const cols = await all(`PRAGMA table_info('users')`);
  const have = new Set(cols.map(c => String(c.name || '').toLowerCase()));
  async function add(name, type){
    const key = String(name).toLowerCase();
    if (have.has(key)) return;
    try {
      await exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
      have.add(key);
    } catch (e) {
      const msg = String(e && e.message || '');
      if (msg.includes('duplicate column name')) {
        have.add(key);
      } else {
        throw e;
      }
    }
  }
  await add('dob', 'TEXT');
  await add('gender', 'TEXT');
  await add('eps', 'TEXT');
  await add('ips', 'TEXT');
  await add('phone', 'TEXT');
  await add('address', 'TEXT');
  await add('city', 'TEXT');
  await add('emergency_contact', 'TEXT');
  await add('emergency_phone', 'TEXT');
  await add('blood_type', 'TEXT');
}

async function migrateAndSeedProfiles(){
  await ensureProfileColumns();
  const u1 = await get("SELECT * FROM users WHERE email=?", ['ana@medistock.local']);
  if (u1 && !u1.phone){
    await run(
      "UPDATE users SET phone=?, address=?, city=?, dob=?, gender=?, eps=?, ips=?, emergency_contact=?, emergency_phone=?, blood_type=? WHERE id=?",
      ['3001112233', 'Cra 10 # 20-30', 'Bucaramanga', '1996-05-12', 'F', 'Sura', 'IPS La Merced', 'María Paciente', '3002223344', 'O+', u1.id]
    );
  }
  const u2 = await get("SELECT * FROM users WHERE email=?", ['carlos@medistock.local']);
  if (u2 && !u2.phone){
    await run(
      "UPDATE users SET phone=?, address=?, city=?, dob=?, gender=?, eps=?, ips=?, emergency_contact=?, emergency_phone=?, blood_type=? WHERE id=?",
      ['3005556677', 'Av 27 # 15-45', 'Bucaramanga', '1993-10-03', 'M', 'Nueva EPS', 'IPS UIS', 'Ana Paciente', '3001112233', 'A+', u2.id]
    );
  }
}

