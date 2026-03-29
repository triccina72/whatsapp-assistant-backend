# WhatsApp Assistant Backend

Backend per l'assistente personale su WhatsApp. Gestisce la memoria oggetti (salva e recupera dove hai messo le cose).

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

## Deploy su Railway

1. Crea nuovo progetto Railway → Deploy from GitHub
2. Aggiungi servizio PostgreSQL nello stesso progetto
3. Railway imposta DATABASE_URL automaticamente
4. Nessuna variabile d'ambiente aggiuntiva necessaria

## Collegamento Botpress

Usa l'URL pubblico Railway come base per i tools dell'Autonomous Node:
- Tool save_object → POST {RAILWAY_URL}/memory/save
- Tool find_object → POST {RAILWAY_URL}/memory/find
