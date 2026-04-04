const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

async function initRemindersDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reminders (
      id SERIAL PRIMARY KEY,
      user_id TEXT,
      conversation_id TEXT,
      message TEXT,
      remind_at TIMESTAMP,
      channel TEXT DEFAULT 'whatsapp',
      recurrence TEXT DEFAULT 'none',
      done BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Tabella reminders pronta.');
}

initDB().catch(console.error);
initRemindersDB().catch(console.error);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Backend assistente attivo' });
});

app.post('/memory/save', async (req, res) => {
  const { user_id, object_name, location } = req.body;
  if (!user_id || !object_name || !location) {
    return res.status(400).json({ error: 'Parametri mancanti' });
  }
  try {
    const existing = await pool.query(
      'SELECT id FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [user_id, object_name]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE memories SET location = $1, updated_at = NOW() WHERE user_id = $2 AND LOWER(object_name) = LOWER($3)',
        [location, user_id, object_name]
      );
      return res.json({ success: true, action: 'updated', object_name, location });
    } else {
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

app.post('/memory/find', async (req, res) => {
  const { user_id, object_name } = req.body;
  if (!user_id || !object_name) {
    return res.status(400).json({ error: 'Parametri mancanti' });
  }
  try {
    const result = await pool.query(
      'SELECT object_name, location, updated_at FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [user_id, object_name]
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return res.json({ found: true, object_name: row.object_name, location: row.location });
    } else {
      return res.json({ found: false, object_name });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});

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

app.post('/reminder/save', async (req, res) => {
  const { user_id, conversation_id, message, remind_at, channel, recurrence } = req.body;
  if (!user_id || !message || !remind_at) {
    return res.status(400).json({ error: 'Parametri mancanti: user_id, message, remind_at' });
  }
  try {
    await pool.query(
      'INSERT INTO reminders (user_id, conversation_id, message, remind_at, channel, recurrence) VALUES ($1, $2, $3, $4, $5, $6)',
      [user_id, conversation_id, message, remind_at, channel || 'whatsapp', recurrence || 'none']
    );
    return res.json({ success: true, message: 'Reminder salvato', remind_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore database' });
  }
});
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/chat', async (req, res) => {
  const { user_id, message } = req.body;
  if (!user_id || !message) {
    return res.status(400).json({ error: 'Parametri mancanti' });
  }
  try {
    const memories = await pool.query(
      'SELECT object_name, location FROM memories WHERE user_id = $1',
      [user_id]
    );
    const memoryText = memories.rows.length > 0
      ? memories.rows.map(r => `- ${r.object_name}: ${r.location}`).join('\n')
      : 'Nessun oggetto salvato.';

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Sei Simona AI, assistente personale di Simona. 
Parli sempre in italiano, sei amichevole e diretta.
Oggetti salvati in memoria:\n${memoryText}`,
      messages: [{ role: 'user', content: message }]
    });

    return res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore Claude API' });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
