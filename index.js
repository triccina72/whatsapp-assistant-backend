const express = require('express');
const { Pool } = require('pg');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  return new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive'
    ]
  );
}

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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database pronto.');
}

initDB().catch(console.error);

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Backend Simona AI attivo' });
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
    return res.status(400).json({ error: 'Parametri mancanti' });
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

app.post('/calendar/create', async (req, res) => {
  const { title, date_time, duration_minutes, description } = req.body;
  if (!title || !date_time) {
    return res.status(400).json({ error: 'Parametri mancanti: title, date_time' });
  }
  try {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const startTime = new Date(date_time);
    const endTime = new Date(startTime.getTime() + (duration_minutes || 60) * 60000);
    const event = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: title,
        description: description || '',
        start: { dateTime: startTime.toISOString(), timeZone: 'Europe/Rome' },
        end: { dateTime: endTime.toISOString(), timeZone: 'Europe/Rome' }
      }
    });
    return res.json({ success: true, event_id: event.data.id, link: event.data.htmlLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore Calendar: ' + err.message });
  }
});

app.post('/drive/search', async (req, res) => {
  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ error: 'Parametro mancante: query' });
  }
  try {
    const auth = getGoogleAuth();
    const drive = google.drive({ version: 'v3', auth });
    const result = await drive.files.list({
      q: `name contains '${query}' and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
      pageSize: 10
    });
    return res.json({ files: result.data.files });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore Drive: ' + err.message });
  }
});

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

    const history = await pool.query(
      'SELECT role, content FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [user_id]
    );
    const conversationHistory = history.rows.reverse().map(r => ({
      role: r.role,
      content: r.content
    }));

    conversationHistory.push({ role: 'user', content: message });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: `Sei Simona AI, assistente personale di Simona Tricci.
Parli sempre in italiano, sei amichevole, diretta e pratica.
Data e ora attuale: ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}

COSA SAI FARE:
- Ricordare dove sono gli oggetti (memoria persistente)
- Creare eventi su Google Calendar chiamando: POST https://whatsapp-assistant-backend-production.up.railway.app/calendar/create con { title, date_time (ISO 8601), duration_minutes, description }
- Cercare documenti su Google Drive chiamando: POST https://whatsapp-assistant-backend-production.up.railway.app/drive/search con { query }
- Rispondere a domande generali

OGGETTI IN MEMORIA:
${memoryText}

REGOLE:
- Rispondi sempre in italiano
- Sii concisa e diretta
- Se l'utente conferma un evento, crealo SUBITO su Calendar
- Se l'utente dice dove mette qualcosa, confermalo`,
      messages: conversationHistory
    });

    const reply = response.content[0].text;

    await pool.query(
      'INSERT INTO conversations (user_id, role, content) VALUES ($1, $2, $3)',
      [user_id, 'user', message]
    );
    await pool.query(
      'INSERT INTO conversations (user_id, role, content) VALUES ($1, $2, $3)',
      [user_id, 'assistant', reply]
    );

    return res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Errore Claude API' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Simona AI avviato sulla porta ${PORT}`);
});
