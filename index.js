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

function getGmailAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });
  return oauth2Client;
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_profile (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, key)
    )
  `);
  console.log('Database pronto.');
}

initDB().catch(console.error);

async function setupTelegramWebhook() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const backendUrl = process.env.BACKEND_URL || 'https://whatsapp-assistant-backend-production.up.railway.app';
  const webhookUrl = `${backendUrl}/telegram`;
  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl })
    });
    const data = await response.json();
    console.log('Telegram webhook:', data.ok ? 'configurato' : data.description);
  } catch (err) {
    console.error('Errore setup webhook Telegram:', err.message);
  }
}

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}

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
    name: 'save_profile',
    description: 'Salva una regola, preferenza o informazione importante su Simona nella memoria permanente.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Nome breve della regola es: orario_calendario' },
        value: { type: 'string', description: 'Valore o descrizione della regola' }
      },
      required: ['key', 'value']
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
    name: 'list_calendar_events',
    description: 'Mostra gli eventi del calendario per un periodo',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Numero di giorni da oggi, default 14' }
      }
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
    description: 'Cerca email di ordini tessuti nella casella Gmail, legge anche i PDF allegati',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Termine di ricerca es: numero ordine, riferimento, nome tessuto' },
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

  if (toolName === 'save_profile') {
    await pool.query(
      `INSERT INTO user_profile (user_id, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [userId, toolInput.key, toolInput.value]
    );
    return { success: true, key: toolInput.key, value: toolInput.value };
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

  if (toolName === 'list_calendar_events') {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + (toolInput.days || 14) * 24 * 60 * 60 * 1000).toISOString();
    const events = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20
    });
    return {
      events: events.data.items.map(e => ({
        title: e.summary,
        start: e.start.dateTime || e.start.date,
        end: e.end.dateTime || e.end.date,
        id: e.id
      }))
    };
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
    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });
    const maxResults = toolInput.max_results || 5;

    console.log('Gmail API search:', toolInput.query);

    const searchResult = await gmail.users.messages.list({
      userId: 'me',
      q: `label:"Ordini Tessuti" ${toolInput.query}`,
      maxResults
    });

    if (!searchResult.data.messages || searchResult.data.messages.length === 0) {
      console.log('Gmail API: nessuna email trovata');
      return { emails: [] };
    }

    console.log('Gmail API: trovate', searchResult.data.messages.length, 'email');
    const results = [];

    for (const msgRef of searchResult.data.messages) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: msgRef.id,
        format: 'full'
      });

      const headers = msg.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const from = headers.find(h => h.name === 'From')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      const emailData = {
        subject,
        from,
        date,
        text: '',
        attachments: []
      };

      function extractParts(parts) {
        if (!parts) return;
        for (const part of parts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            emailData.text = Buffer.from(part.body.data, 'base64').toString('utf-8').substring(0, 500);
          }
          if (part.mimeType === 'application/pdf' && part.body?.attachmentId) {
            emailData.attachments.push({
              filename: part.filename,
              attachmentId: part.body.attachmentId,
              messageId: msgRef.id
            });
          }
          if (part.parts) extractParts(part.parts);
        }
      }

      extractParts(msg.data.payload.parts);
      if (msg.data.payload.mimeType === 'text/plain' && msg.data.payload.body?.data) {
        emailData.text = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf-8').substring(0, 500);
      }

      
      for (const att of emailData.attachments) {
        try {
          const attachment = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: att.messageId,
            id: att.attachmentId
          });

          const pdfBase64 = attachment.data.data.replace(/-/g, '+').replace(/_/g, '/');

          const pdfResponse = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: pdfBase64
                  }
                },
                {
                  type: 'text',
                  text: 'Analizza questo documento di ordine tessuti ed estrai: 1) Cliente (chi ha FATTO l\'ordine, non il fornitore), 2) Numero ordine/riferimento, 3) Modello/nome tessuto, 4) Quantità, 5) Note importanti. Rispondi in italiano in modo strutturato.'
                }
              ]
            }]
          });

          att.content = pdfResponse.content[0].text;
          delete att.attachmentId;
          delete att.messageId;
        } catch (err) {
          console.error('Errore lettura PDF:', err.message);
        }
      }

      results.push(emailData);
    }

    return { emails: results };
  }

  return { error: 'Tool non trovato' };
}

async function processMessage(userId, message) {
  const memories = await pool.query(
    'SELECT object_name, location FROM memories WHERE user_id = $1',
    [userId]
  );
  const memoryText = memories.rows.length > 0
    ? memories.rows.map(r => `- ${r.object_name}: ${r.location}`).join('\n')
    : 'Nessun oggetto salvato.';

  const profile = await pool.query(
    'SELECT key, value FROM user_profile WHERE user_id = $1 ORDER BY updated_at DESC',
    [userId]
  );
  const profileText = profile.rows.length > 0
    ? profile.rows.map(r => `- ${r.key}: ${r.value}`).join('\n')
    : 'Nessuna regola salvata.';

  const history = await pool.query(
    'SELECT role, content FROM conversations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
    [userId]
  );
  const conversationHistory = history.rows.reverse()
    .filter(r => r.role === 'user' || r.role === 'assistant')
    .filter(r => typeof r.content === 'string' && r.content.trim().length > 0)
    .map(r => ({
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

REGOLE PERSONALI DI SIMONA (salvate in memoria permanente):
${profileText}

REGOLE DI COMPORTAMENTO:
- Parla sempre in italiano, in modo caldo e diretto come un'amica fidata
- Sii proattiva: se vedi qualcosa di utile, suggeriscilo
- Rispetta il tempo di Simona: sii sintetica quando serve


REGOLE OPERATIVE:
- NON dire mai "fatto" senza aver verificato l'esito dell'azione
- Se qualcosa non va, dillo subito con onestà
- Se non hai un tool per fare qualcosa, dillo CHIARAMENTE
- Non mostrare mai JSON o dati tecnici all'utente
- Sii sempre onesta su cosa puoi e non puoi fare
- Se Simona ti dice una regola da ricordare sempre, salvala SUBITO con save_profile
- Salva subito qualsiasi informazione importante con save_profile
- Se non capisci una richiesta o non hai abbastanza contesto, chiedi chiarimenti
- Se una ricerca non trova risultati utili, dillo esplicitamente
- Dopo ogni ricerca o azione completata, riferisci SEMPRE il risultato a Simona prima di fare altro
- Non salvare regole o fare altre azioni senza prima aver risposto alla richiesta principale
- Non rimanere MAI in silenzio — rispondi SEMPRE, anche solo per dire "non ho capito, puoi riformulare?" — il silenzio è VIETATO

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
- search_gmail_orders legge anche i PDF allegati alle email
- Per cercare ordini tessuti usa search_gmail_orders con parole chiave separate es: "DEAL A273" non "RIF. DEAL A273_25"
- Gmail cerca automaticamente email che contengono tutte le parole chiave
CALENDARIO:
- Se Simona chiede di creare un evento, crealo subito su Calendar
- Usa SEMPRE l'orario esatto che ti dice Simona nel formato 2026-04-05T15:30:00
- NON aggiungere mai offset di fuso orario alla data
- Se Simona chiede di eliminare un evento, eliminalo e conferma l'esito reale
- Per vedere gli eventi usa list_calendar_events`;

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
        const result = await executeTool(block.name, block.input, userId);
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
    [userId, 'user', message]
  );
  await pool.query(
    'INSERT INTO conversations (user_id, role, content) VALUES ($1, $2, $3)',
    [userId, 'assistant', reply]
  );

  return reply;
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
    const reply = await processMessage(user_id, message);
    return res.json({ reply });
  } catch (err) {
    console.error(err);
    return 'Si è verificato un errore tecnico. Riprova!';
  }
});

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);
  let chatId = null;
  try {
    const update = req.body;
    if (!update.message || !update.message.text) return;
    chatId = update.message.chat.id;
    const userId = `telegram_${chatId}`;
    const message = update.message.text;
    console.log('Telegram messaggio da:', chatId, '-', message);
    const reply = await processMessage(userId, message);
    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('Errore Telegram:', err.message);
    if (chatId) await sendTelegramMessage(chatId, 'Si è verificato un errore tecnico. Riprova tra qualche secondo!');
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
app.listen(PORT, async () => {
  console.log(`Server Simona AI avviato sulla porta ${PORT}`);
  await setupTelegramWebhook();
});
