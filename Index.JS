const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Connessione PostgreSQL (Railway inietta DATABASE_URL automaticamente)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Crea tabella al primo avvio
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      object_name TEXT NOT NULL,
      location TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database pronto.');
}

initDB().catch(console.error);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Backend assistente attivo' });
});

// SALVA un oggetto (o aggiorna se esiste già)
// POST /memory/save
// Body: { user_id, object_name, location }
app.post('/memory/save', async (req, res) => {
  const { user_id, object_name, location } = req.body;

  if (!user_id || !object_name || !location) {
    return res.status(400).json({ error: 'Parametri mancanti: user_id, object_name, location' });
  }

  try {
    // Cerca se esiste già
    const existing = await pool.query(
      'SELECT id FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [user_id, object_name]
    );

    if (existing.rows.length > 0) {
      // Aggiorna
      await pool.query(
        'UPDATE memories SET location = $1, updated_at = NOW() WHERE user_id = $2 AND LOWER(object_name) = LOWER($3)',
        [location, user_id, object_name]
      );
      return res.json({ success: true, action: 'updated', object_name, location });
    } else {
      // Inserisci
      await pool.query(
        'INSERT INTO memories (user_id, object_name, location) VALUES ($1, $2, $3)',
        [user_id, object_name, location]
      );
      return res.json({ success: true, action: 'saved', object_name, location });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// TROVA un oggetto
// POST /memory/find
// Body: { user_id, object_name }
app.post('/memory/find', async (req, res) => {
  const { user_id, object_name } = req.body;

  if (!user_id || !object_name) {
    return res.status(400).json({ error: 'Parametri mancanti: user_id, object_name' });
  }

  try {
    const result = await pool.query(
      'SELECT object_name, location, updated_at FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [user_id, object_name]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return res.json({ found: true, object_name: row.object_name, location: row.location, updated_at: row.updated_at });
    } else {
      return res.json({ found: false, object_name });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

// LISTA tutti gli oggetti salvati
// GET /memory/list?user_id=xxx
app.get('/memory/list', async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res.status(400).json({ error: 'Parametro mancante: user_id' });
  }

  try {
    const result = await pool.query(
      'SELECT object_name, location, updated_at FROM memories WHERE user_id = $1 ORDER BY updated_at DESC',
      [user_id]
    );
    return res.json({ items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
