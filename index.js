const express = require('express');
const { Pool } = require('pg');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
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

const tools = [
  {
    name: 'save_object',
    description: 'Salva la posizione di un oggetto nella memoria persistente',
    input_schema: {
      type: 'object',
      properties: {
        object_name: { type: 'string', description: 'Nome oggetto' },
        location: { type: 'string', description: 'Dove si trova' }
      },
      required: ['object_name', 'location']
    }
  },
  {
    name: 'find_object',
    description: 'Cerca la posizione di un oggetto nella memoria',
    input_schema: {
      type: 'object',
      properties: {
        object_name: { type: 'string', description: 'Nome oggetto da cercare' }
      },
      required: ['object_name']
    }
  },
  {
    name: 'create_calendar_event',
    description: 'Crea un evento su Google Calendar',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titolo evento' },
        date_time: { type: 'string', description: 'Data e ora ISO 8601 SENZA fuso orario es: 2026-04-05T15:30:00' },
        duration_minutes: { type: 'number', description: 'Durata in minuti, default 60' },
        description: { type: 'string', description: 'Descrizione evento' }
      },
      required: ['title', 'date_time']
    }
  },
  {
    name: 'delete_calendar_event',
    description: 'Elimina un evento da Google Calendar cercandolo per titolo',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titolo evento da eliminare' },
        date: { type: 'string', description: 'Data evento in formato YYYY-MM-DD' }
      },
      required: ['title']
    }
  },
  {
    name: 'search_drive',
    description: 'Cerca file e documenti su Google Drive',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Termine di ricerca' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_gmail_orders',
    description: 'Cerca email di ordini tessuti nella casella Gmail',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Termine di ricerca es: numero ordine o riferimento' },
        max_results: { type: 'number', description: 'Numero massimo di email da restituire, default 5' }
      },
      required: ['query']
    }
  }
];

async function executeTool(toolName, toolInput, userId) {
  if (toolName === 'save_object') {
    const existing = await pool.query(
      'SELECT id FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [userId, toolInput.object_name]
    );
    if (existing.rows.length > 0) {
      await pool.query(
        'UPDATE memories SET location = $1, updated_at = NOW() WHERE user_id = $2 AND LOWER(object_name) = LOWER($3)',
        [toolInput.location, userId, toolInput.object_name]
      );
      return { success: true, action: 'updated', object_name: toolInput.object_name, location: toolInput.location };
    } else {
      await pool.query(
        'INSERT INTO memories (user_id, object_name, location) VALUES ($1, $2, $3)',
        [userId, toolInput.object_name, toolInput.location]
      );
      return { success: true, action: 'saved', object_name: toolInput.object_name, location: toolInput.location };
    }
  }

  if (toolName === 'find_object') {
    const result = await pool.query(
      'SELECT object_name, location FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [userId, toolInput.object_name]
    );
    if (result.rows.length > 0) {
      return { found: true, object_name: result.rows[0].object_name, location: result.rows[0].location };
    }
    return { found: false, object_name: toolInput.object_name };
  }

  if (toolName === 'create_calendar_event') {
    console.log('Creazione evento:', JSON.stringify(toolInput));
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });

    const dt = toolInput.date_time.replace(/[+Z].*$/, '');
    const durationMs = (toolInput.duration_minutes || 60) * 60000;
    const startParts = dt.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    const endDate = new Date(Date.UTC(
      parseInt(startParts[1]),
      parseInt(startParts[2]) - 1,
      parseInt(startParts[3]),
      parseInt(startParts[4]),
      parseInt(startParts[5]),
      parseInt(startParts[6])
    ) + durationMs);
    const endDt = endDate.toISOString().replace('Z', '').substring(0, 19);

    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      requestBody: {
        summary: toolInput.title,
        description: toolInput.description || '',
        start: { dateTime: dt, timeZone: 'Europe/Rome' },
        end: { dateTime: endDt, timeZone: 'Europe/Rome' }
      }
    });
    console.log('Evento creato:', event.data.id);
    return { success: true, event_id: event.data.id };
  }

  if (toolName === 'delete_calendar_event') {
    console.log('Eliminazione evento:', JSON.stringify(toolInput));
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const timeMin = toolInput.date
      ? new Date(toolInput.date + 'T00:00:00').toISOString()
      : new Date().toISOString();
    const timeMax = toolInput.date
      ? new Date(toolInput.date + 'T23:59:59').toISOString()
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const events = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin,
      timeMax,
      q: toolInput.title,
      singleEvents: true
    });
    if (!events.data.items || events.data.items.length === 0) {
      return { success: false, message: 'Evento non trovato' };
    }
    const eventToDelete = events.data.items[0];
    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      eventId: eventToDelete.id
    });
    console.log('Evento eliminato:', eventToDelete.summary);
    return { success: true, message: `Evento "${eventToDelete.summary}" eliminato` };
  }

  if (toolName === 'search_drive') {
    const auth = getGoogleAuth();
    const drive = google.drive({ version: 'v3', auth });
    const result = await drive.files.list({
      q: `name contains '${toolInput.query}' and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
      pageSize: 10
    });
    return { files: result.data.files };
  }

  if (toolName === 'search_gmail_orders') {
    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD
      },
      logger: false
    });
    await client.connect();
    const results = [];
    try {
      await client.mailboxOpen('Ordini Tessuti');
      const messages = await client.search({ text: toolInput.query });
      const limit = Math.min(messages.length, toolInput.max_results || 5);
      const toFetch = messages.slice(-limit);
      for await (const msg of client.fetch(toFetch, { source: true })) {
        const parsed = await simpleParser(msg.source);
        results.push({
          subject: parsed.subject,
          from: parsed.from?.text,
          date: parsed.date,
          text: parsed.text?.substring(0, 500)
        });
      }
    } finally {
      await client.logout();
    }
    return { emails: results };
  }

  return { error: 'Tool non trovato' };
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Backend Simona AI attivo' });
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

    const systemPrompt = `Sei Simona AI, assistente personale di Simona Tricci.
Parli sempre in italiano, sei amichevole, diretta e pratica.
Data e ora attuale: ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}
FUSO ORARIO: Europe/Rome. Usa SEMPRE l'orario esatto che ti dice Simona nel formato YYYY-MM-DDTHH:MM:SS senza aggiungere fuso orario.

OGGETTI IN MEMORIA:
${memoryText}

REGOLE DI COMPORTAMENTO:
- Parla sempre in italiano, in modo caldo e diretto come un'amica fidata
- Sii proattiva: se vedi qualcosa di utile, suggeriscilo
- Rispetta il tempo di Simona: sii sintetica quando serve
- Salva subito qualsiasi informazione importante che Simona ti dice

REGOLE OPERATIVE:
- NON dire mai "fatto" senza aver verificato l'esito dell'azione
- Se qualcosa non va, dillo subito con onestà
- Se non hai un tool per fare qualcosa, dillo CHIARAMENTE: "Non posso farlo ancora, questa funzione non è disponibile"
- Non mostrare mai JSON o dati tecnici all'utente
- Sii sempre onesta su cosa puoi e non puoi fare

MEMORIA OGGETTI:
- Quando Simona dice dove mette qualcosa, salvalo SUBITO con save_object

DOCUMENTI MEDICI:
- Quando ricevi un PDF medico, analizzalo e fai un riassunto
- Rinominalo: [Tipo documento]-Ricci Simona-DATA.pdf
- Controlla sempre se esiste già prima di salvarlo
- Archivia in cartella Drive dedicata

PRODUZIONE E ORDINI:
- Estrai sempre: Cliente, Ordine, Modello, Note
- Organizza per cliente su Drive
- Per cercare ordini tessuti usa search_gmail_orders

CALENDARIO:
- Se Simona chiede di creare un evento, crealo subito su Calendar
- Usa SEMPRE l'orario esatto che ti dice Simona nel formato 2026-04-05T15:30:00
- NON aggiungere mai offset di fuso orario alla data
- Se Simona chiede di eliminare un evento, eliminalo e conferma l'esito reale`;

    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      tools: tools,
      messages: conversationHistory
    });

    const toolMessages = [...conversationHistory];

    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const result = await executeTool(block.name, block.input, user_id);
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          };
        })
      );

      toolMessages.push({ role: 'assistant', content: response.content });
      toolMessages.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        tools: tools,
        messages: toolMessages
      });
    }

    const reply = response.content.find(b => b.type === 'text')?.text || 'Fatto!';

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
    res.status(500).json({ error: 'Errore Claude API: ' + err.message });
  }
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
      'SELECT object_name, location FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',
      [user_id, object_name]
    );
    if (result.rows.length > 0) {
      return res.json({ found: true, object_name: result.rows[0].object_name, location: result.rows[0].location });
    }
    return res.json({ found: false, object_name });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server Simona AI avviato sulla porta ${PORT}`);
});
