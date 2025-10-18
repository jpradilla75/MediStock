const { exec, initDb } = require('./db');
(async ()=>{
  try{
    await exec(`
      PRAGMA foreign_keys=OFF;
      DROP TABLE IF EXISTS deliveries;
      DROP TABLE IF EXISTS reservations;
      DROP TABLE IF EXISTS prescriptions;
      DROP TABLE IF EXISTS inventory;
      DROP TABLE IF EXISTS dispensers;
      DROP TABLE IF EXISTS medicines;
      DROP TABLE IF EXISTS users;
    `);
    await initDb();
    console.log('DB reset + seed OK');
    process.exit(0);
  }catch(e){ console.error('Reset error', e); process.exit(1); }
})();