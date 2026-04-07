const express = require('express');
const { Pool } = require('pg');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL_FAST  = 'claude-haiku-4-5-20251001';
const MODEL_SMART = 'claude-sonnet-4-20250514';

const DRIVE_ORDINI_TESSUTI_ID  = process.env.DRIVE_ORDINI_TESSUTI_ID  || '1pX-Qbam8QzQpZJgLecr4cfy4Uvy6r95L';
const DRIVE_ORDINI_CLIENTE_ID  = process.env.DRIVE_ORDINI_CLIENTE_ID  || '1V1npKBBZEQLPuKa01T8nWjsA4yEdoNNo';

// Cache immagini in attesa — keyed by userId, auto-pulita dopo il messaggio
const pendingImages = new Map();

function getGoogleAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  return new google.auth.JWT(
    credentials.client_email, null, credentials.private_key,
    ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/drive']
  );
}

function getGmailAuth() {
  const oauth2Client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oauth2Client;
}

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS memories (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, object_name TEXT NOT NULL,
    location TEXT NOT NULL, updated_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reminders (
    id SERIAL PRIMARY KEY, user_id TEXT, conversation_id TEXT, message TEXT,
    remind_at TIMESTAMP, channel TEXT DEFAULT 'whatsapp', recurrence TEXT DEFAULT 'none',
    done BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_profile (
    id SERIAL PRIMARY KEY, user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id, key)
  )`);

  // Tabella ordini tessuti (da email fornitori)
  await pool.query(`CREATE TABLE IF NOT EXISTS ordini_tessuti (
    id SERIAL PRIMARY KEY,
    gmail_message_id TEXT UNIQUE,
    tipo_documento TEXT,
    fornitore TEXT,
    cliente TEXT,
    numero_ordine TEXT,
    riferimenti TEXT,
    note TEXT,
    stato TEXT DEFAULT 'atteso',
    email_subject TEXT,
    email_from TEXT,
    email_date TEXT,
    drive_file_id TEXT,
    processed_at TIMESTAMP DEFAULT NOW()
  )`);

  // Tabella righe tessuto per ogni ordine (un record per ogni tessuto/metraggio)
  await pool.query(`CREATE TABLE IF NOT EXISTS tessuti_righe (
    id SERIAL PRIMARY KEY,
    ordine_id INTEGER REFERENCES ordini_tessuti(id) ON DELETE CASCADE,
    codice_articolo TEXT,
    descrizione TEXT,
    metraggio NUMERIC,
    unita TEXT DEFAULT 'mt',
    arrivato BOOLEAN DEFAULT FALSE,
    arrivato_at TIMESTAMP,
    foto_etichetta_drive_id TEXT
  )`);

  // Tabella ordini clienti (da foto documenti produzione)
  await pool.query(`CREATE TABLE IF NOT EXISTS ordini_clienti (
    id SERIAL PRIMARY KEY,
    numero_ov TEXT,
    riga_ordine TEXT,
    codice_modello TEXT,
    descrizione_prodotto TEXT,
    cliente TEXT,
    rif_cliente TEXT,
    doc_esterno TEXT,
    commerciale TEXT,
    data_scadenza TEXT,
    piano_produzione TEXT,
    seriali TEXT,
    tessuto_principale TEXT,
    codice_tessuto TEXT,
    fornitore_tessuto TEXT,
    metraggio_tessuto NUMERIC,
    quantita INTEGER DEFAULT 1,
    stato TEXT DEFAULT 'in_lavorazione',
    note TEXT,
    drive_file_id TEXT,
    processed_at TIMESTAMP DEFAULT NOW()
  )`);
  // Aggiungi colonne mancanti se la tabella esiste già (migrazione)
  const colonne = ['numero_ov','riga_ordine','codice_modello','descrizione_prodotto','rif_cliente','doc_esterno','commerciale','data_scadenza','piano_produzione','seriali','tessuto_principale','codice_tessuto','fornitore_tessuto','metraggio_tessuto','quantita'];
  for (const col of colonne) {
    await pool.query(`ALTER TABLE ordini_clienti ADD COLUMN IF NOT EXISTS ${col} TEXT`).catch(()=>{});
  }
  await pool.query(`ALTER TABLE ordini_clienti ADD COLUMN IF NOT EXISTS metraggio_tessuto NUMERIC`).catch(()=>{});
  await pool.query(`ALTER TABLE ordini_clienti ADD COLUMN IF NOT EXISTS quantita INTEGER DEFAULT 1`).catch(()=>{});

  // Colonna per tracciare ultima email processata
  await pool.query(`CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
  )`);

  console.log('Database pronto.');
}

initDB().catch(console.error);

// ─── TELEGRAM ───────────────────────────────────────────────

async function setupTelegramWebhook() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const backendUrl = process.env.BACKEND_URL || 'https://whatsapp-assistant-backend-production.up.railway.app';
  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${backendUrl}/telegram` })
    });
    const data = await response.json();
    console.log('Telegram webhook:', data.ok ? 'configurato' : data.description);
  } catch (err) { console.error('Errore webhook:', err.message); }
}

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function getTelegramPhotoBase64(fileId) {
  const fileResp = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const fileData = await fileResp.json();
  const filePath = fileData.result.file_path;
  const imgResp = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  const buffer = await imgResp.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ─── TOOLS ──────────────────────────────────────────────────

const tools = [
  {
    name: 'save_object',
    description: 'Salva la posizione di un oggetto nella memoria persistente',
    input_schema: { type: 'object', properties: { object_name: { type: 'string' }, location: { type: 'string' } }, required: ['object_name', 'location'] }
  },
  {
    name: 'find_object',
    description: 'Cerca la posizione di un oggetto nella memoria',
    input_schema: { type: 'object', properties: { object_name: { type: 'string' } }, required: ['object_name'] }
  },
  {
    name: 'save_profile',
    description: 'Salva una regola o preferenza permanente su Simona',
    input_schema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] }
  },
  {
    name: 'create_calendar_event',
    description: 'Crea un evento su Google Calendar',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, date_time: { type: 'string', description: 'ISO 8601 SENZA fuso orario es: 2026-04-05T15:30:00' }, duration_minutes: { type: 'number' }, description: { type: 'string' } }, required: ['title', 'date_time'] }
  },
  {
    name: 'delete_calendar_event',
    description: 'Elimina un evento da Google Calendar',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, date: { type: 'string' } }, required: ['title'] }
  },
  {
    name: 'list_calendar_events',
    description: 'Mostra gli eventi del calendario',
    input_schema: { type: 'object', properties: { days: { type: 'number' } } }
  },
  {
    name: 'search_drive',
    description: 'Cerca file su Google Drive',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'search_gmail_orders',
    description: 'Cerca email ordini tessuti in Gmail (ricerca live su Gmail, per email non ancora nel DB)',
    input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] }
  },
  {
    name: 'cerca_ordini',
    description: 'Cerca nel database locale degli ordini tessuti già processati. Usa questo per ricerche per fornitore, cliente, tessuto, numero ordine, data. Molto più veloce e flessibile di search_gmail_orders.',
    input_schema: {
      type: 'object',
      properties: {
        testo: { type: 'string', description: 'Testo libero da cercare (nome fornitore, cliente, tessuto, numero ordine, ecc.)' },
        stato: { type: 'string', description: 'Filtra per stato: atteso, parziale, completo' },
        solo_incompleti: { type: 'boolean', description: 'Se true mostra solo ordini con tessuti non ancora arrivati' }
      }
    }
  },
  {
    name: 'registra_arrivo_tessuto',
    description: 'Segna un tessuto come arrivato. Usare quando Simona fotografa un\'etichetta o conferma un arrivo.',
    input_schema: {
      type: 'object',
      properties: {
        ordine_id: { type: 'number', description: 'ID dell\'ordine nel database' },
        tessuto_id: { type: 'number', description: 'ID della riga tessuto (opzionale se c\'è solo uno)' },
        codice_articolo: { type: 'string', description: 'Codice articolo del tessuto arrivato' },
        foto_drive_id: { type: 'string', description: 'ID file Drive della foto etichetta (opzionale)' }
      },
      required: ['ordine_id']
    }
  },
  {
    name: 'forza_sync_gmail',
    description: 'Forza la sincronizzazione manuale delle email Gmail nuove nella cartella Ordini Tessuti',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'gestisci_sync_automatica',
    description: 'Attiva o disattiva la sincronizzazione automatica Gmail. Usa anche per vedere lo stato attuale.',
    input_schema: {
      type: 'object',
      properties: {
        azione: { type: 'string', description: 'accendi | spegni | stato' }
      },
      required: ['azione']
    }
  },
  {
    name: 'registra_ordine_cliente',
    description: 'Registra un ordine cliente nel database e carica la foto su Drive (cartella Ordini Cliente). Usare quando Simona fotografa un documento di produzione con OV, cliente, tessuto.',
    input_schema: {
      type: 'object',
      properties: {
        numero_ov: { type: 'string', description: 'Numero ordine di vendita es. OV25_00480' },
        riga_ordine: { type: 'string', description: 'Riga ordine es. 10000' },
        codice_modello: { type: 'string', description: 'Codice modello prodotto es. BLLD1PTXT' },
        descrizione_prodotto: { type: 'string', description: 'Descrizione es. Boll Poltrona Tessuto cat. Extreme' },
        cliente: { type: 'string', description: 'Nome cliente es. RH INTERIEURS B.V.' },
        rif_cliente: { type: 'string', description: 'Riferimento cliente es. SHOWROOM/ROTTERDAM' },
        doc_esterno: { type: 'string', description: 'Documento esterno es. A648.24' },
        commerciale: { type: 'string', description: 'Commerciale di riferimento' },
        data_scadenza: { type: 'string', description: 'Data scadenza es. 06/05/25' },
        piano_produzione: { type: 'string', description: 'Nr. piano di produzione es. 25PP000533' },
        seriali: { type: 'string', description: 'Seriali SN es. SN2509249-SN2509250' },
        tessuto_principale: { type: 'string', description: 'Nome tessuto principale es. DOMINO colore 2 Jacquard FR' },
        codice_tessuto: { type: 'string', description: 'Codice articolo tessuto es. SDMNO0002' },
        fornitore_tessuto: { type: 'string', description: 'Fornitore del tessuto es. KVADRAT S.P.A.' },
        metraggio_tessuto: { type: 'number', description: 'Metraggio previsto del tessuto' },
        quantita: { type: 'number', description: 'Quantità pezzi' },
        note: { type: 'string', description: 'Note aggiuntive' }
      },
      required: []
    }
  },
  {
    name: 'cerca_abbinamento_tessuto',
    description: 'Cerca quali ordini clienti usano un determinato tessuto. Fondamentale quando arriva un tessuto: cerca sia negli ordini fornitore che negli ordini cliente per capire a quale lavorazione serve.',
    input_schema: {
      type: 'object',
      properties: {
        nome_tessuto: { type: 'string', description: 'Nome tessuto es. DOMINO colore 2, HERO 2, ecc.' },
        codice_tessuto: { type: 'string', description: 'Codice articolo tessuto es. SDMNO0002' }
      }
    }
  }
];

// ─── EXECUTE TOOL ────────────────────────────────────────────

async function executeTool(toolName, toolInput, userId) {

  if (toolName === 'save_object') {
    const existing = await pool.query('SELECT id FROM memories WHERE user_id=$1 AND LOWER(object_name)=LOWER($2)', [userId, toolInput.object_name]);
    if (existing.rows.length > 0) {
      await pool.query('UPDATE memories SET location=$1, updated_at=NOW() WHERE user_id=$2 AND LOWER(object_name)=LOWER($3)', [toolInput.location, userId, toolInput.object_name]);
      return { success: true, action: 'updated', object_name: toolInput.object_name, location: toolInput.location };
    }
    await pool.query('INSERT INTO memories (user_id, object_name, location) VALUES ($1,$2,$3)', [userId, toolInput.object_name, toolInput.location]);
    return { success: true, action: 'saved', object_name: toolInput.object_name, location: toolInput.location };
  }

  if (toolName === 'find_object') {
    const result = await pool.query('SELECT object_name, location FROM memories WHERE user_id=$1 AND LOWER(object_name)=LOWER($2)', [userId, toolInput.object_name]);
    if (result.rows.length > 0) return { found: true, ...result.rows[0] };
    return { found: false, object_name: toolInput.object_name };
  }

  if (toolName === 'save_profile') {
    await pool.query(`INSERT INTO user_profile (user_id,key,value,updated_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (user_id,key) DO UPDATE SET value=$3, updated_at=NOW()`, [userId, toolInput.key, toolInput.value]);
    return { success: true, key: toolInput.key, value: toolInput.value };
  }

  if (toolName === 'create_calendar_event') {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const dt = toolInput.date_time.replace(/[+Z].*$/, '');
    const durationMs = (toolInput.duration_minutes || 60) * 60000;
    const sp = dt.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    const endDate = new Date(Date.UTC(+sp[1],+sp[2]-1,+sp[3],+sp[4],+sp[5],+sp[6]) + durationMs);
    const endDt = endDate.toISOString().replace('Z','').substring(0,19);
    const event = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      requestBody: { summary: toolInput.title, description: toolInput.description||'', start: { dateTime: dt, timeZone: 'Europe/Rome' }, end: { dateTime: endDt, timeZone: 'Europe/Rome' } }
    });
    return { success: true, event_id: event.data.id };
  }

  if (toolName === 'delete_calendar_event') {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const timeMin = toolInput.date ? new Date(toolInput.date+'T00:00:00').toISOString() : new Date().toISOString();
    const timeMax = toolInput.date ? new Date(toolInput.date+'T23:59:59').toISOString() : new Date(Date.now()+30*24*60*60*1000).toISOString();
    const events = await calendar.events.list({ calendarId: process.env.GOOGLE_CALENDAR_ID||'primary', timeMin, timeMax, q: toolInput.title, singleEvents: true });
    if (!events.data.items?.length) return { success: false, message: 'Evento non trovato' };
    const ev = events.data.items[0];
    await calendar.events.delete({ calendarId: process.env.GOOGLE_CALENDAR_ID||'primary', eventId: ev.id });
    return { success: true, message: `Evento "${ev.summary}" eliminato` };
  }

  if (toolName === 'list_calendar_events') {
    const auth = getGoogleAuth();
    const calendar = google.calendar({ version: 'v3', auth });
    const events = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID||'primary',
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now()+(toolInput.days||14)*24*60*60*1000).toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 20
    });
    return { events: events.data.items.map(e => ({ title: e.summary, start: e.start.dateTime||e.start.date, end: e.end.dateTime||e.end.date, id: e.id })) };
  }

  if (toolName === 'search_drive') {
    const auth = getGoogleAuth();
    const drive = google.drive({ version: 'v3', auth });
    const result = await drive.files.list({ q: `name contains '${toolInput.query}' and trashed=false`, fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', pageSize: 10 });
    return { files: result.data.files };
  }

  if (toolName === 'search_gmail_orders') {
    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });
    const maxResults = toolInput.max_results || 5;
    const searchResult = await gmail.users.messages.list({ userId: 'me', q: `label:"Ordini Tessuti" ${toolInput.query}`, maxResults });
    if (!searchResult.data.messages?.length) return { emails: [] };
    const results = [];
    for (const msgRef of searchResult.data.messages) {
      const msg = await gmail.users.messages.get({ userId: 'me', id: msgRef.id, format: 'full' });
      const headers = msg.data.payload.headers;
      const emailData = {
        subject: headers.find(h=>h.name==='Subject')?.value||'',
        from: headers.find(h=>h.name==='From')?.value||'',
        date: headers.find(h=>h.name==='Date')?.value||'',
        text: '', attachments: []
      };
      function extractParts(parts) {
        if (!parts) return;
        for (const part of parts) {
          if (part.mimeType==='text/plain' && part.body?.data) emailData.text = Buffer.from(part.body.data,'base64').toString('utf-8').substring(0,500);
          if (part.mimeType==='application/pdf' && part.body?.attachmentId) emailData.attachments.push({ filename: part.filename, attachmentId: part.body.attachmentId, messageId: msgRef.id });
          if (part.parts) extractParts(part.parts);
        }
      }
      extractParts(msg.data.payload.parts);
      for (const att of emailData.attachments) {
        try {
          const attachment = await gmail.users.messages.attachments.get({ userId: 'me', messageId: att.messageId, id: att.attachmentId });
          const pdfBase64 = attachment.data.data.replace(/-/g,'+').replace(/_/g,'/');
          const pdfResponse = await anthropic.messages.create({
            model: MODEL_SMART, max_tokens: 1024,
            messages: [{ role: 'user', content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: 'Sei esperto in documenti tessili. Questi documenti vengono sempre da fornitori che vendono tessuti a Domingo Salotti S.r.l. Estrai:\nTIPO DOCUMENTO: (ordine_a_fornitore|bolla_consegna|fattura|conferma_ordine|altro — MAI ordine_cliente)\nFORNITORE: (chi VENDE/SPEDISCE il tessuto, es. NOVATEX, KVADRAT)\nCLIENTE: (chi ACQUISTA, di solito Domingo Salotti)\nNUMERO ORDINE:\nRIFERIMENTI: (tutti i codici presenti)\nTESSUTI: (lista con codice articolo, nome tessuto+colore e metraggio per ognuno)\nNOTE: (date consegna, condizioni)\nSe non presente scrivi non trovato.' }
            ]}]
          });
          att.content = pdfResponse.content[0].text;
          delete att.attachmentId; delete att.messageId;
        } catch(err) { console.error('Errore PDF:', err.message); }
      }
      results.push(emailData);
    }
    return { emails: results };
  }

  if (toolName === 'cerca_ordini') {
    const { testo, stato, solo_incompleti } = toolInput;
    let query = `
      SELECT o.*,
        COUNT(t.id) as tot_tessuti,
        COUNT(CASE WHEN t.arrivato THEN 1 END) as tessuti_arrivati,
        json_agg(json_build_object('id',t.id,'codice',t.codice_articolo,'desc',t.descrizione,'mt',t.metraggio,'arrivato',t.arrivato)) as tessuti
      FROM ordini_tessuti o
      LEFT JOIN tessuti_righe t ON t.ordine_id = o.id
      WHERE 1=1
    `;
    const params = [];
    if (testo) {
      params.push(`%${testo.toLowerCase()}%`);
      query += ` AND (LOWER(o.fornitore) LIKE $${params.length} OR LOWER(o.cliente) LIKE $${params.length} OR LOWER(o.numero_ordine) LIKE $${params.length} OR LOWER(o.riferimenti) LIKE $${params.length} OR LOWER(o.note) LIKE $${params.length} OR LOWER(o.email_from) LIKE $${params.length} OR EXISTS (SELECT 1 FROM tessuti_righe t2 WHERE t2.ordine_id=o.id AND (LOWER(t2.codice_articolo) LIKE $${params.length} OR LOWER(t2.descrizione) LIKE $${params.length})))`;
    }
    if (stato) { params.push(stato); query += ` AND o.stato=$${params.length}`; }
    if (solo_incompleti) query += ` AND o.stato != 'completo'`;
    query += ` GROUP BY o.id ORDER BY o.processed_at DESC LIMIT 10`;
    const result = await pool.query(query, params);
    return { ordini: result.rows, totale: result.rows.length };
  }

  if (toolName === 'registra_arrivo_tessuto') {
    const { ordine_id, tessuto_id, codice_articolo, foto_drive_id } = toolInput;
    // Segna il tessuto specifico come arrivato
    if (tessuto_id) {
      await pool.query('UPDATE tessuti_righe SET arrivato=TRUE, arrivato_at=NOW(), foto_etichetta_drive_id=$1 WHERE id=$2', [foto_drive_id||null, tessuto_id]);
    } else if (codice_articolo) {
      await pool.query('UPDATE tessuti_righe SET arrivato=TRUE, arrivato_at=NOW(), foto_etichetta_drive_id=$1 WHERE ordine_id=$2 AND LOWER(codice_articolo)=LOWER($3)', [foto_drive_id||null, ordine_id, codice_articolo]);
    } else {
      // Segna tutti i tessuti dell'ordine come arrivati
      await pool.query('UPDATE tessuti_righe SET arrivato=TRUE, arrivato_at=NOW() WHERE ordine_id=$1', [ordine_id]);
    }
    // Controlla se l'ordine è completato
    const check = await pool.query('SELECT COUNT(*) as tot, COUNT(CASE WHEN arrivato THEN 1 END) as arr FROM tessuti_righe WHERE ordine_id=$1', [ordine_id]);
    const { tot, arr } = check.rows[0];
    const nuovoStato = +arr === 0 ? 'atteso' : +arr >= +tot ? 'completo' : 'parziale';
    await pool.query('UPDATE ordini_tessuti SET stato=$1 WHERE id=$2', [nuovoStato, ordine_id]);
    // Recupera i dati dell'ordine per la notifica
    const ordine = await pool.query('SELECT * FROM ordini_tessuti WHERE id=$1', [ordine_id]);
    return {
      success: true,
      stato: nuovoStato,
      completo: nuovoStato === 'completo',
      tessuti_arrivati: +arr,
      tessuti_totali: +tot,
      ordine: ordine.rows[0]
    };
  }

  if (toolName === 'forza_sync_gmail') {
    await syncGmailOrders();
    return { success: true, message: 'Sincronizzazione completata' };
  }

  if (toolName === 'gestisci_sync_automatica') {
    const azione = toolInput.azione?.toLowerCase();
    if (azione === 'accendi') {
      syncAutomaticaAttiva = true;
      return { success: true, stato: 'attiva', message: 'Sync automatica attivata (lun-ven 7-19)' };
    } else if (azione === 'spegni') {
      syncAutomaticaAttiva = false;
      return { success: true, stato: 'disattiva', message: 'Sync automatica disattivata' };
    } else {
      return { stato: syncAutomaticaAttiva ? 'attiva' : 'disattiva' };
    }
  }

  if (toolName === 'registra_ordine_cliente') {
    const {
      numero_ov, riga_ordine, codice_modello, descrizione_prodotto,
      cliente, rif_cliente, doc_esterno, commerciale,
      data_scadenza, piano_produzione, seriali,
      tessuto_principale, codice_tessuto, fornitore_tessuto, metraggio_tessuto,
      quantita, note
    } = toolInput;

    // Blocca se non c'è nemmeno un dato minimo
    if (!numero_ov && !codice_modello && !cliente && !tessuto_principale) {
      return { success: false, message: 'Dati insufficienti — estrai almeno numero_ov o tessuto dalla foto prima di chiamare questo tool' };
    }

    // Controlla se esiste già (stesso OV + riga)
    if (numero_ov) {
      const exists = await pool.query(
        'SELECT id FROM ordini_clienti WHERE numero_ov=$1 AND (riga_ordine=$2 OR $2 IS NULL)',
        [numero_ov, riga_ordine||null]
      );
      if (exists.rows.length > 0) {
        return { success: false, message: `Ordine ${numero_ov} già presente nel DB (id: ${exists.rows[0].id})`, id: exists.rows[0].id };
      }
    }

    // Carica foto su Drive dalla cache (l'immagine arriva dal Telegram handler)
    let driveFileId = null;
    const cached = pendingImages.get(userId);
    if (cached?.base64) {
      try {
        const auth = getGoogleAuth();
        const drive = google.drive({ version: 'v3', auth });
        const buf = Buffer.from(cached.base64, 'base64');
        const { Readable } = require('stream');
        const stream = new Readable();
        stream.push(buf);
        stream.push(null);
        const nomeFile = `${numero_ov || 'ordine'}_${riga_ordine || ''}_${codice_modello || Date.now()}.jpg`;
        const driveResp = await drive.files.create({
          requestBody: { name: nomeFile, parents: [DRIVE_ORDINI_CLIENTE_ID] },
          media: { mimeType: 'image/jpeg', body: stream },
          fields: 'id'
        });
        driveFileId = driveResp.data.id;
      } catch(driveErr) { console.error('Errore Drive ordine cliente:', driveErr.message); }
    }

    const res = await pool.query(`
      INSERT INTO ordini_clienti
        (numero_ov, riga_ordine, codice_modello, descrizione_prodotto, cliente, rif_cliente,
         doc_esterno, commerciale, data_scadenza, piano_produzione, seriali,
         tessuto_principale, codice_tessuto, fornitore_tessuto, metraggio_tessuto,
         quantita, note, drive_file_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id`,
      [numero_ov, riga_ordine||null, codice_modello||null, descrizione_prodotto||null,
       cliente||null, rif_cliente||null, doc_esterno||null, commerciale||null,
       data_scadenza||null, piano_produzione||null, seriali||null,
       tessuto_principale||null, codice_tessuto||null, fornitore_tessuto||null,
       metraggio_tessuto||null, quantita||1, note||null, driveFileId]
    );

    return {
      success: true,
      id: res.rows[0].id,
      drive_file_id: driveFileId,
      numero_ov,
      tessuto_principale,
      message: `Ordine cliente ${numero_ov} registrato${driveFileId ? ' e foto caricata su Drive' : ''}`
    };
  }

  if (toolName === 'cerca_abbinamento_tessuto') {
    const { nome_tessuto, codice_tessuto } = toolInput;
    const results = { ordini_clienti: [], ordini_tessuti: [] };

    if (nome_tessuto || codice_tessuto) {
      const paramVal = `%${(nome_tessuto || codice_tessuto).toLowerCase()}%`;

      // Cerca negli ordini clienti
      const clienti = await pool.query(`
        SELECT id, numero_ov, riga_ordine, codice_modello, descrizione_prodotto,
               cliente, tessuto_principale, codice_tessuto, data_scadenza, stato
        FROM ordini_clienti
        WHERE LOWER(tessuto_principale) LIKE $1 OR LOWER(codice_tessuto) LIKE $1
        ORDER BY processed_at DESC LIMIT 10`,
        [paramVal]
      );
      results.ordini_clienti = clienti.rows;

      // Cerca negli ordini tessuti fornitore
      const fornitori = await pool.query(`
        SELECT o.id, o.fornitore, o.numero_ordine, o.stato,
               t.codice_articolo, t.descrizione, t.metraggio, t.arrivato
        FROM tessuti_righe t JOIN ordini_tessuti o ON t.ordine_id=o.id
        WHERE LOWER(t.codice_articolo) LIKE $1 OR LOWER(t.descrizione) LIKE $1
        ORDER BY o.processed_at DESC LIMIT 10`,
        [paramVal]
      );
      results.ordini_tessuti = fornitori.rows;
    }

    const trovati = results.ordini_clienti.length + results.ordini_tessuti.length;
    return { ...results, trovati };
  }

  return { error: 'Tool non trovato' };
}

// ─── SYNC GMAIL AUTO ─────────────────────────────────────────

async function processEmailToOrder(gmail, msgRef) {
  // Controlla se già processata
  const exists = await pool.query('SELECT id FROM ordini_tessuti WHERE gmail_message_id=$1', [msgRef.id]);
  if (exists.rows.length > 0) return null;

  const msg = await gmail.users.messages.get({ userId: 'me', id: msgRef.id, format: 'full' });
  const headers = msg.data.payload.headers;
  const subject = headers.find(h=>h.name==='Subject')?.value||'';
  const from = headers.find(h=>h.name==='From')?.value||'';
  const date = headers.find(h=>h.name==='Date')?.value||'';

  const attachments = [];
  function extractParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.mimeType==='application/pdf' && part.body?.attachmentId) {
        attachments.push({ filename: part.filename, attachmentId: part.body.attachmentId });
      }
      if (part.parts) extractParts(part.parts);
    }
  }
  extractParts(msg.data.payload.parts);

  let estratto = null;
  let driveFileId = null;

  if (attachments.length > 0) {
    const att = attachments[0];
    try {
      const attachment = await gmail.users.messages.attachments.get({ userId: 'me', messageId: msgRef.id, id: att.attachmentId });
      const pdfBase64 = attachment.data.data.replace(/-/g,'+').replace(/_/g,'/');

      // Salva su Drive
      try {
        const auth = getGoogleAuth();
        const drive = google.drive({ version: 'v3', auth });
        const buf = Buffer.from(pdfBase64, 'base64');
        const { Readable } = require('stream');
        const stream = new Readable();
        stream.push(buf);
        stream.push(null);
        const driveResp = await drive.files.create({
          requestBody: { name: att.filename || `ordine_${msgRef.id}.pdf`, parents: [DRIVE_ORDINI_TESSUTI_ID] },
          media: { mimeType: 'application/pdf', body: stream },
          fields: 'id'
        });
        driveFileId = driveResp.data.id;
      } catch(driveErr) { console.error('Errore salvataggio Drive:', driveErr.message); }

      // Estrai dati con Claude
      const pdfResponse = await anthropic.messages.create({
        model: MODEL_SMART, max_tokens: 1500,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: `Analizza questo documento tessile ed estrai in formato JSON.
CONTESTO: questi documenti sono sempre inviati da fornitori di tessuti a Domingo Salotti S.r.l. (Pesaro).
Il FORNITORE è chi vende/spedisce il tessuto (es. NOVATEX, KVADRAT, ecc.).
Il CLIENTE è sempre Domingo Salotti o simile — non usare mai "ordine_cliente" come tipo.

{
  "tipo_documento": "ordine_a_fornitore|bolla_consegna|fattura|conferma_ordine|altro",
  "fornitore": "nome azienda che vende/spedisce il tessuto",
  "cliente": "nome azienda che riceve (di solito Domingo Salotti)",
  "numero_ordine": "codice ordine principale (es. OA26_01903)",
  "riferimenti": "tutti i codici, SKU, rif interni (stringa)",
  "note": "date consegna, condizioni, avvertenze",
  "tessuti": [
    {"codice_articolo": "...", "descrizione": "nome tessuto e colore", "metraggio": 0.0, "unita": "mt"}
  ]
}
Rispondi SOLO con il JSON, nessun testo aggiuntivo.` }
        ]}]
      });

      try { estratto = JSON.parse(pdfResponse.content[0].text.replace(/```json\n?|\n?```/g,'')); }
      catch(e) { console.error('JSON parse error:', pdfResponse.content[0].text.substring(0,200)); }

    } catch(err) { console.error('Errore processamento PDF:', err.message); }
  }

  // Salva ordine nel DB
  const ordineRes = await pool.query(`
    INSERT INTO ordini_tessuti (gmail_message_id, tipo_documento, fornitore, cliente, numero_ordine, riferimenti, note, email_subject, email_from, email_date, drive_file_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [msgRef.id, estratto?.tipo_documento||null, estratto?.fornitore||null, estratto?.cliente||null,
     estratto?.numero_ordine||null, estratto?.riferimenti||null, estratto?.note||null,
     subject, from, date, driveFileId]
  );
  const ordineId = ordineRes.rows[0].id;

  // Salva righe tessuti
  if (estratto?.tessuti?.length > 0) {
    for (const t of estratto.tessuti) {
      await pool.query('INSERT INTO tessuti_righe (ordine_id, codice_articolo, descrizione, metraggio, unita) VALUES ($1,$2,$3,$4,$5)',
        [ordineId, t.codice_articolo||null, t.descrizione||null, t.metraggio||null, t.unita||'mt']);
    }
  }

  console.log(`Ordine processato: ${subject} → ID ${ordineId}`);
  return ordineId;
}

async function syncGmailOrders() {
  try {
    const auth = getGmailAuth();
    const gmail = google.gmail({ version: 'v1', auth });

    // Recupera ID ultima email processata
    const lastSync = await pool.query("SELECT value FROM sync_state WHERE key='last_ordini_sync'");
    const afterQuery = lastSync.rows.length > 0 ? ` after:${lastSync.rows[0].value}` : '';

    const searchResult = await gmail.users.messages.list({
      userId: 'me', q: `label:"Ordini Tessuti"${afterQuery}`, maxResults: 20
    });

    if (!searchResult.data.messages?.length) {
      console.log('Sync Gmail: nessuna email nuova');
      return 0;
    }

    let count = 0;
    for (const msgRef of searchResult.data.messages) {
      const result = await processEmailToOrder(gmail, msgRef);
      if (result) count++;
    }

    // Aggiorna timestamp ultima sync
    const today = new Date().toISOString().split('T')[0].replace(/-/g,'/');
    await pool.query(`INSERT INTO sync_state (key,value,updated_at) VALUES ('last_ordini_sync',$1,NOW()) ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [today]);

    console.log(`Sync Gmail: ${count} nuove email processate`);
    return count;
  } catch(err) {
    console.error('Errore sync Gmail:', err.message);
    return 0;
  }
}

// Stato sync automatica — di default SPENTA, si accende/spegne via chat
let syncAutomaticaAttiva = false;

function syncSeOrarioLavorativo() {
  if (!syncAutomaticaAttiva) {
    console.log('Sync automatica disattivata, salto.');
    return;
  }
  const ora = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour: 'numeric', hour12: false });
  const giorno = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short' });
  const h = parseInt(ora);
  const feriale = !['sab', 'dom'].includes(giorno.toLowerCase().substring(0,3));
  if (feriale && h >= 7 && h < 19) {
    console.log('Sync Gmail automatica...');
    syncGmailOrders();
  } else {
    console.log(`Sync Gmail saltata (${giorno} ${h}:xx — fuori orario lavorativo)`);
  }
}
setInterval(syncSeOrarioLavorativo, 60 * 60 * 1000);

// ─── PROCESS MESSAGE ─────────────────────────────────────────

async function processMessage(userId, message, imageBase64 = null) {
  try {
    const memories = await pool.query('SELECT object_name, location FROM memories WHERE user_id=$1', [userId]);
    const memoryText = memories.rows.length > 0 ? memories.rows.map(r=>`- ${r.object_name}: ${r.location}`).join('\n') : 'Nessun oggetto salvato.';
    const profile = await pool.query('SELECT key, value FROM user_profile WHERE user_id=$1 ORDER BY updated_at DESC', [userId]);
    const profileText = profile.rows.length > 0 ? profile.rows.map(r=>`- ${r.key}: ${r.value}`).join('\n') : 'Nessuna regola salvata.';
    const history = await pool.query('SELECT role, content FROM conversations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 6', [userId]);
    const conversationHistory = history.rows.reverse()
      .filter(r=>(r.role==='user'||r.role==='assistant') && typeof r.content==='string' && r.content.trim().length>0)
      .map(r=>({ role: r.role, content: r.content }));

    // Costruisci il messaggio utente (testo + eventuale immagine)
    let userContent;
    if (imageBase64) {
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: message || 'Analizza questa immagine' }
      ];
    } else {
      userContent = message;
    }
    conversationHistory.push({ role: 'user', content: userContent });

    const systemPrompt = `Sei Simona AI, assistente personale di Simona Tricci (operaia tessile, Domingo Salotti SRL, Pesaro).
Parli sempre in italiano, sei amichevole, diretta e pratica.
Data e ora attuale: ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}
FUSO ORARIO: Europe/Rome. Formato date: YYYY-MM-DDTHH:MM:SS SENZA offset.

OGGETTI IN MEMORIA:
${memoryText}

REGOLE PERSONALI:
${profileText}

COMPORTAMENTO:
- Rispondi SEMPRE prima di fare azioni
- Parla in italiano come amica fidata, sintetica
- Non mostrare mai JSON o dati tecnici
- Se Simona dice dove mette qualcosa → save_object subito
- Salva regole importanti → save_profile subito

GESTIONE FOTO — RICONOSCI SEMPRE IL TIPO:
Quando Simona manda una foto, prima di tutto identifica di che tipo è:

1. ORDINE CLIENTE (documento di produzione interno):
   Riconosci se vedi: "OV25_XXXXX", "Nr. Piano di Produzione", "Lista Componenti", "Riferimenti Ordine", "Ordine - Riga"
   → OBBLIGATORIO: chiama SUBITO registra_ordine_cliente PRIMA di scrivere qualsiasi risposta
   → NON dire "registro subito" senza aver chiamato il tool — le parole non bastano, serve la chiamata
   → Estrai dal documento: numero_ov (es. OV25_00480), riga_ordine, codice_modello, descrizione_prodotto, cliente, rif_cliente, doc_esterno, data_scadenza, piano_produzione, tessuto_principale (quello evidenziato in verde/giallo nella foto), codice_tessuto, fornitore_tessuto, metraggio
   → Dopo aver chiamato registra_ordine_cliente, chiama cerca_abbinamento_tessuto per vedere se il tessuto è già atteso da un fornitore
   → Solo DOPO i tool calls, rispondi a Simona con: "✅ Ordine OV25_XXXXX registrato! Cliente: ... Tessuto: ... Scadenza: ..."

2. ETICHETTA TESSUTO FORNITORE:
   Riconosci se vedi: etichetta con codice tessuto, nome tessuto, lotto, metraggio rotolo
   → Estrai: nome tessuto, codice, lotto, metraggio
   → Chiama cerca_abbinamento_tessuto per trovare ordine fornitore E ordini clienti che lo usano
   → Chiama registra_arrivo_tessuto per aggiornare lo stato
   → Conferma a Simona: tessuto arrivato, a quale ordine appartiene, a quale lavorazione serve

3. BOLLA / DDT FORNITORE (documento cartaceo):
   Riconosci se vedi: "Documento di Trasporto", "DDT", "Bolla di consegna", tabella con articoli e quantità
   → Estrai: fornitore, numero documento, tessuti e metragi
   → Cerca corrispondenza con cerca_ordini
   → Aggiorna stato con registra_arrivo_tessuto

ORDINI TESSUTI FORNITORE (da Gmail):
- Per cercare ordini già processati usa cerca_ordini (più veloce)
- Per email non ancora nel DB usa search_gmail_orders
- Quando un ordine diventa completo avvisa Simona con entusiasmo 🎉
- Tessuti nel DB vengono sincronizzati automaticamente da Gmail ogni ora

CALENDARIO:
- Formato: 2026-04-05T15:30:00 SENZA fuso orario
- NON aggiungere offset di fuso orario`;

    let response = await anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 1024, system: systemPrompt, tools, messages: conversationHistory
    });

    const toolMessages = [...conversationHistory];
    while (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b=>b.type==='tool_use');
      const toolResults = await Promise.all(toolUseBlocks.map(async block => {
        const result = await executeTool(block.name, block.input, userId);
        return { type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) };
      }));
      toolMessages.push({ role: 'assistant', content: response.content });
      toolMessages.push({ role: 'user', content: toolResults });
      response = await anthropic.messages.create({
        model: MODEL_FAST,
        max_tokens: 1024, system: systemPrompt, tools, messages: toolMessages
      });
    }

    const reply = response.content.find(b=>b.type==='text')?.text || 'Fatto!';
    await pool.query('INSERT INTO conversations (user_id, role, content) VALUES ($1,$2,$3)', [userId, 'user', typeof userContent === 'string' ? userContent : '[foto]']);
    await pool.query('INSERT INTO conversations (user_id, role, content) VALUES ($1,$2,$3)', [userId, 'assistant', reply]);
    return reply;

  } catch(err) {
    console.error('processMessage ERRORE:', err.message);
    throw err;
  }
}

// ─── ROUTES ──────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Backend Simona AI attivo' }));

app.post('/chat', async (req, res) => {
  const { user_id, message } = req.body;
  if (!user_id || !message) return res.status(400).json({ error: 'Parametri mancanti' });
  try {
    const reply = await processMessage(user_id, message);
    return res.json({ reply });
  } catch(err) { return res.status(500).json({ error: 'Errore interno. Riprova!' }); }
});

app.post('/telegram', async (req, res) => {
  res.sendStatus(200);
  let chatId = null;
  try {
    const update = req.body;
    if (!update.message) return;
    chatId = update.message.chat.id;
    const userId = `telegram_${chatId}`;

    // Gestione FOTO
    if (update.message.photo) {
      await sendTelegramMessage(chatId, '📸 Analizzo la foto...');
      const photos = update.message.photo;
      const bestPhoto = photos[photos.length - 1];
      const imageBase64 = await getTelegramPhotoBase64(bestPhoto.file_id);
      // Metti l'immagine in cache — i tool la leggono da qui senza che Claude la ripassi
      pendingImages.set(userId, { base64: imageBase64, timestamp: Date.now() });
      const caption = update.message.caption || 'Analizza questa foto e dimmi che tipo di documento è.';
      try {
        const reply = await processMessage(userId, caption, imageBase64);
        await sendTelegramMessage(chatId, reply);
      } finally {
        pendingImages.delete(userId); // pulisci sempre dopo
      }
      return;
    }

    // Gestione TESTO
    if (update.message.text) {
      const reply = await processMessage(userId, update.message.text);
      await sendTelegramMessage(chatId, reply);
      return;
    }

  } catch(err) {
    console.error('Errore Telegram:', err.message);
    if (chatId) await sendTelegramMessage(chatId, 'Errore tecnico. Riprova!');
  }
});

app.post('/memory/save', async (req, res) => {
  const { user_id, object_name, location } = req.body;
  if (!user_id || !object_name || !location) return res.status(400).json({ error: 'Parametri mancanti' });
  try {
    const existing = await pool.query('SELECT id FROM memories WHERE user_id=$1 AND LOWER(object_name)=LOWER($2)', [user_id, object_name]);
    if (existing.rows.length > 0) {
      await pool.query('UPDATE memories SET location=$1, updated_at=NOW() WHERE user_id=$2 AND LOWER(object_name)=LOWER($3)', [location, user_id, object_name]);
    } else {
      await pool.query('INSERT INTO memories (user_id, object_name, location) VALUES ($1,$2,$3)', [user_id, object_name, location]);
    }
    return res.json({ success: true, object_name, location });
  } catch(err) { res.status(500).json({ error: 'Errore database' }); }
});

app.post('/memory/find', async (req, res) => {
  const { user_id, object_name } = req.body;
  if (!user_id || !object_name) return res.status(400).json({ error: 'Parametri mancanti' });
  try {
    const result = await pool.query('SELECT object_name, location FROM memories WHERE user_id=$1 AND LOWER(object_name)=LOWER($2)', [user_id, object_name]);
    if (result.rows.length > 0) return res.json({ found: true, ...result.rows[0] });
    return res.json({ found: false, object_name });
  } catch(err) { res.status(500).json({ error: 'Errore database' }); }
});

app.get('/memory/list', async (req, res) => {
  const { user_id } = req.query;
  if (!user_id) return res.status(400).json({ error: 'Parametro mancante' });
  try {
    const result = await pool.query('SELECT object_name, location, updated_at FROM memories WHERE user_id=$1 ORDER BY updated_at DESC', [user_id]);
    return res.json({ items: result.rows });
  } catch(err) { res.status(500).json({ error: 'Errore database' }); }
});

app.post('/reminder/save', async (req, res) => {
  const { user_id, conversation_id, message, remind_at, channel, recurrence } = req.body;
  if (!user_id || !message || !remind_at) return res.status(400).json({ error: 'Parametri mancanti' });
  try {
    await pool.query('INSERT INTO reminders (user_id, conversation_id, message, remind_at, channel, recurrence) VALUES ($1,$2,$3,$4,$5,$6)',
      [user_id, conversation_id, message, remind_at, channel||'whatsapp', recurrence||'none']);
    return res.json({ success: true, remind_at });
  } catch(err) { res.status(500).json({ error: 'Errore database' }); }
});

// Endpoint per vedere stato ordini (debug/admin)
app.get('/ordini', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT o.*, COUNT(t.id) as tot_tessuti, COUNT(CASE WHEN t.arrivato THEN 1 END) as tessuti_arrivati
      FROM ordini_tessuti o LEFT JOIN tessuti_righe t ON t.ordine_id=o.id
      GROUP BY o.id ORDER BY o.processed_at DESC LIMIT 50
    `);
    return res.json({ ordini: result.rows });
  } catch(err) { res.status(500).json({ error: 'Errore' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server Simona AI avviato sulla porta ${PORT}`);
  await setupTelegramWebhook();
});
