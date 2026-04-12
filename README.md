# WhatsApp Assistant Backend


Backend per l'assistente personale su WhatsApp/Telegram. Gestisce la memoria oggetti, eventi calendario, ordini tessuti e **reminder Telegram**.

## Endpoints

### Health check
GET /

### Salva oggetto
POST /memory/save
Body: { "user_id": "tuo_id", "object_name": "chiavi", "location": "tavolo" }

### Trova oggetto
POST /memory/find
Body: { "user_id": "tuo_id", "object_name": "chiavi" }

### Lista tutti gli oggetti
GET /memory/list?user_id=tuo_id

### Salva reminder (API diretta)
POST /reminder/save
Body: { "user_id": "telegram_<chatId>", "message": "Bere acqua", "remind_at": "2026-04-09T15:30:00", "channel": "telegram", "recurrence": "none" }

## Reminder Telegram

I reminder vengono salvati nella tabella Postgres `reminders` e inviati come messaggi Telegram tramite un job che gira ogni minuto.

### Come funziona
1. L'utente scrive su Telegram: *"Ricordami tra 5 minuti di bere"* oppure *"Ricordami domani alle 9 di chiamare il medico"*
2. L'assistente chiama il tool `create_reminder` (inserisce una riga in `reminders`)
3. Il job `checkAndSendReminders` ogni 60 secondi controlla i reminder scaduti e manda il messaggio Telegram: `⏰ Reminder: Bere acqua`
4. Il reminder viene marcato `done=TRUE` (o aggiornato alla prossima scadenza se ricorrente)

### Parametri tool `create_reminder`
| Campo | Tipo | Obbligatorio | Descrizione |
|-------|------|-------------|-------------|
| `message` | string | ✅ | Testo del promemoria |
| `remind_at` | string | ✅ (o `minutes_from_now`) | Data/ora ISO: `YYYY-MM-DDTHH:MM:SS` (Europe/Rome) |
| `minutes_from_now` | number | ✅ (o `remind_at`) | Minuti da adesso (alternativa a `remind_at`) |
| `recurrence` | string | ❌ | `none` (default), `daily`, `weekly`, `monthly`, `every_Xm` |

## Goal Mode (Telegram)

Il **Goal mode** permette di creare reminder *goal-oriented* con linguaggio naturale, senza dover usare comandi precisi.

### Tipi di goal

| Tipo | Descrizione | Esempio di frase |
|------|-------------|-----------------|
| `until_done` | Ripete il reminder a intervallo fisso finché l'utente dice "fatto" | *"Ricordami di bere finché non lo faccio"* |
| `daily_habit` | Reminder giornaliero a orario fisso; "fatto" riconosce il completamento del giorno senza spegnere la ricorrenza | *"Voglio bere 2L al giorno, ricordami"* |
| `interval` | Ripete ogni X minuti/ore (senza stop automatico) | *"Ricordami ogni 30 minuti di fare stretching"* |
| `one_time` | Reminder singolo (comportamento classico) | *"Ricordami tra 10 minuti di chiamare il medico"* |

### Come funziona il Goal mode

1. L'utente scrive una frase naturale in italiano contenente parole chiave (`ricordami`, `ogni giorno`, `finché non lo faccio`, ecc.)
2. Il bot intercetta l'intento **prima** di passare al LLM principale
3. Fa **una sola chiamata LLM leggera** (haiku) per estrarre i parametri (messaggio, tipo, intervallo, orario)
4. Se un parametro è mancante (es. intervallo per `until_done`, orario per `daily_habit`), fa **una sola domanda di chiarimento**
5. Alla risposta successiva, crea il goal in DB e conferma con messaggio amichevole
6. **Mai** conferma un goal se non è stato salvato in DB (`success: true` obbligatorio)

### Comportamento "fatto"

- **`until_done`**: il reminder viene marcato `done=TRUE` → spento per sempre. Messaggio: *"Goal completato! — spengo i reminder."*
- **`daily_habit`**: il reminder NON viene spento, viene solo riconosciuto per oggi. Messaggio: *"Segnato per oggi. Ti ricordo di nuovo domani alle HH:MM 🌅"*
- **Ricorrente normale**: come before, marcato `done=TRUE` per tutte le occorrenze con quel messaggio.

### Persistenza dello stato

Lo stato di conversazione (la "domanda di chiarimento" pendente) è salvato nella tabella `goal_sessions` con TTL di 30 minuti. Sopravvive ai riavvii del server.

### Schema DB aggiuntivo

```sql
-- Colonna aggiunta a reminders:
goal_type TEXT DEFAULT NULL  -- 'until_done' | 'daily_habit' | NULL

-- Nuova tabella per sessioni goal pendenti:
CREATE TABLE goal_sessions (
  user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,        -- 'awaiting_interval' | 'awaiting_time'
  goal_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```

### Variabili d'ambiente richieste
- `DATABASE_URL` — URL Postgres (Railway lo imposta automaticamente)
- `TELEGRAM_BOT_TOKEN` — Token del bot Telegram
- `BACKEND_URL` — URL pubblico Railway (per il webhook Telegram)
- `ANTHROPIC_API_KEY` — Chiave API Anthropic Claude

## Deploy su Railway

1. Crea nuovo progetto Railway → Deploy from GitHub
2. Aggiungi servizio PostgreSQL nello stesso progetto
3. Railway imposta DATABASE_URL automaticamente
4. Nessuna variabile d'ambiente aggiuntiva necessaria

## Collegamento Botpress

Usa l'URL pubblico Railway come base per i tools dell'Autonomous Node:
- Tool save_object → POST {RAILWAY_URL}/memory/save
- Tool find_object → POST {RAILWAY_URL}/memory/find
