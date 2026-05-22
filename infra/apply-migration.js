#!/usr/bin/env node
// Quick script to apply a migration SQL file via the pg module.
// Usage: AGENTSMCP_DB=postgresql://... node infra/apply-migration.js infra/migrations/003_github_oauth.sql
const { readFileSync } = require('fs');
const { Pool } = require('pg');

const dbUrl = process.env.AGENTSMCP_DB;
if (!dbUrl) { console.error('AGENTSMCP_DB env var required'); process.exit(1); }

const sqlFile = process.argv[2];
if (!sqlFile) { console.error('Usage: node apply-migration.js <file.sql>'); process.exit(1); }

const sql = readFileSync(sqlFile, 'utf8');
const pool = new Pool({ 
  connectionString: dbUrl, 
  ssl: { rejectUnauthorized: false } 
});

(async () => {
  try {
    console.log(`Applying ${sqlFile}...`);
    await pool.query(sql);
    console.log('Migration applied successfully.');
    
    // Verify
    const res = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name IN ('github_id','github_login','avatar_url') ORDER BY column_name`);
    console.log('Verified columns:', res.rows.map(r => r.column_name).join(', '));
    
    const mig = await pool.query(`SELECT version, description FROM schema_migrations ORDER BY version`);
    console.log('Migrations:', mig.rows.map(r => `${r.version}: ${r.description}`).join('\n  '));
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
