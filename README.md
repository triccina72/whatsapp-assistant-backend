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
| `recurrence` | string | ❌ | `none` (default), `daily`, `weekly`, `monthly` |

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
