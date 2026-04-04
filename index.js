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
        date_time: { type: 'string', description: 'Data e ora ISO 8601 es: 2026-04-05T15:30:00' },
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
    const startTime = new Date(toolInput.date_time);
    const endTime = new Date(startTime.getTime() + (toolInput.duration_minutes || 60) * 60000);
    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      requestBody: {
        summary: toolInput.title,
        description: toolInput.description || '',
        start: { dateTime: startTime.toISOString(), timeZone: 'Europe/Rome' },
        end: { dateTime: endTime.toISOString(), timeZone: 'Europe/Rome' }
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

    const systemPrompt = `Sei Simona AI, assistente personale di Simona Tricci.\nParli sempre in italiano, sei amichevole, diretta e pratica.\nData e ora attuale: ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}\n\nOGGETTI IN MEMORIA:\n${memoryText}\n\nREGOLE:\n- Rispondi sempre in italiano\n- Sii concisa e diretta\n- Usa i tool quando necessario senza chiedere conferma\n- Non mostrare mai JSON o dati tecnici all'utente\n- Se l'utente dice dove mette qualcosa, salvalo subito con save_object\n- Se l'utente chiede di creare un evento o reminder, crealo subito su Calendar\n- Se non hai un tool per eseguire un'azione, dillo CHIARAMENTE: "Non posso farlo ancora, questa funzione non è disponibile"\n- NON dire mai "fatto" o "ho eseguito" se non hai usato un tool\n- Sii sempre onesta su cosa puoi e non puoi fare\nREGOLE DI COMPORTAMENTO:\n- Parla sempre in italiano, in modo caldo e diretto come un'amica fidata\n- Sii proattiva: se vedi qualcosa di utile, suggeriscilo\n- Rispetta il tempo di Simona: sii sintetica quando serve\n- Salva subito qualsiasi informazione importante che Simona ti dice\n\nREGOLE OPERATIVE:\n- NON dire mai "fatto" senza aver verificato l'esito dell'azione\n- Se qualcosa non va, dillo subito con onestà\n- Se non hai un tool per fare qualcosa, dillo CHIARAMENTE\n- Non mostrare mai JSON o dati tecnici\n\nMEMORIA OGGETTI:\n- Quando Simona dice dove mette qualcosa, salvalo SUBITO con save_object\n\nDOCUMENTI MEDICI:\n- Quando ricevi un PDF medico, analizzalo e fai un riassunto\n- Rinominalo: [Tipo documento]-Ricci Simona-DATA.pdf\n- Controlla sempre se esiste già prima di salvarlo\n- Archivia in cartella Drive dedicata\n\nPRODUZIONE E ORDINI:\n- Estrai sempre: Cliente, Ordine, Modello, Note\n- Organizza per cliente su Drive\n- Se richiesto, mostra il file direttamente in chat\n\nCALENDARIO:\n- Se Simona chiede di creare un evento, crealo subito su Calendar\n- Se Simona chiede di eliminare un evento, eliminalo e conferma l'esito reale`;\n
    let response = await anthropic.messages.create({\n      model: 'claude-sonnet-4-20250514',\n      max_tokens: 1024,\n      system: systemPrompt,\n      tools: tools,\n      messages: conversationHistory\n    });\n\n    const toolMessages = [...conversationHistory];\n\n    while (response.stop_reason === 'tool_use') {\n      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');\n\n      const toolResults = await Promise.all(\n        toolUseBlocks.map(async (block) => {\n          const result = await executeTool(block.name, block.input, user_id);\n          return {\n            type: 'tool_result',\n            tool_use_id: block.id,\n            content: JSON.stringify(result)\n          };\n        })\n      );\n\n      toolMessages.push({ role: 'assistant', content: response.content });\n      toolMessages.push({ role: 'user', content: toolResults });\n\n      response = await anthropic.messages.create({\n        model: 'claude-sonnet-4-20250514',\n        max_tokens: 1024,\n        system: systemPrompt,\n        tools: tools,\n        messages: toolMessages\n      });\n    }\n\n    const reply = response.content.find(b => b.type === 'text')?.text || 'Fatto!';\n\n    await pool.query(\n      'INSERT INTO conversations (user_id, role, content) VALUES ($1, $2, $3)',\n      [user_id, 'user', message]\n    );\n    await pool.query(\n      'INSERT INTO conversations (user_id, role, content) VALUES ($1, $2, $3)',\n      [user_id, 'assistant', reply]\n    );\n\n    return res.json({ reply });\n  } catch (err) {\n    console.error(err);\n    res.status(500).json({ error: 'Errore Claude API: ' + err.message });\n  }\n});\n\napp.post('/memory/save', async (req, res) => {\n  const { user_id, object_name, location } = req.body;\n  if (!user_id || !object_name || !location) {\n    return res.status(400).json({ error: 'Parametri mancanti' });\n  }\n  try {\n    const existing = await pool.query(\n      'SELECT id FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',\n      [user_id, object_name]\n    );\n    if (existing.rows.length > 0) {\n      await pool.query(\n        'UPDATE memories SET location = $1, updated_at = NOW() WHERE user_id = $2 AND LOWER(object_name) = LOWER($3)',\n        [location, user_id, object_name]\n      );\n      return res.json({ success: true, action: 'updated', object_name, location });\n    } else {\n      await pool.query(\n        'INSERT INTO memories (user_id, object_name, location) VALUES ($1, $2, $3)',\n        [user_id, object_name, location]\n      );\n      return res.json({ success: true, action: 'saved', object_name, location });\n    }\n  } catch (err) {\n    console.error(err);\n    res.status(500).json({ error: 'Errore database' });\n  }\n});\n\napp.post('/memory/find', async (req, res) => {\n  const { user_id, object_name } = req.body;\n  if (!user_id || !object_name) {\n    return res.status(400).json({ error: 'Parametri mancanti' });\n  }\n  try {\n    const result = await pool.query(\n      'SELECT object_name, location FROM memories WHERE user_id = $1 AND LOWER(object_name) = LOWER($2)',\n      [user_id, object_name]\n    );\n    if (result.rows.length > 0) {\n      return res.json({ found: true, object_name: result.rows[0].object_name, location: result.rows[0].location });\n    }\n    return res.json({ found: false, object_name });\n  } catch (err) {\n    console.error(err);\n    res.status(500).json({ error: 'Errore database' });\n  }\n});\n\napp.get('/memory/list', async (req, res) => {\n  const { user_id } = req.query;\n  if (!user_id) {\n    return res.status(400).json({ error: 'Parametro mancante: user_id' });\n  }\n  try {\n    const result = await pool.query(\n      'SELECT object_name, location, updated_at FROM memories WHERE user_id = $1 ORDER BY updated_at DESC',\n      [user_id]\n    );\n    return res.json({ items: result.rows });\n  } catch (err) {\n    console.error(err);\n    res.status(500).json({ error: 'Errore database' });\n  }\n});\n\napp.post('/reminder/save', async (req, res) => {\n  const { user_id, conversation_id, message, remind_at, channel, recurrence } = req.body;\n  if (!user_id || !message || !remind_at) {\n    return res.status(400).json({ error: 'Parametri mancanti' });\n  }\n  try {\n    await pool.query(\n      'INSERT INTO reminders (user_id, conversation_id, message, remind_at, channel, recurrence) VALUES ($1, $2, $3, $4, $5, $6)',\n      [user_id, conversation_id, message, remind_at, channel || 'whatsapp', recurrence || 'none']\n    );\n    return res.json({ success: true, message: 'Reminder salvato', remind_at });\n  } catch (err) {\n    console.error(err);\n    res.status(500).json({ error: 'Errore database' });\n  }\n});\n\nconst PORT = process.env.PORT || 3000;\napp.listen(PORT, () => {\n  console.log(`Server Simona AI avviato sulla porta ${PORT}`);\n});