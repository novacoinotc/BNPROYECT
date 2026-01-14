# Integración Bancaria - P2P Bot

## Configuración en tu Core Bancario

### Variables de Entorno del Bot
Agrega estas variables en Railway:

```env
WEBHOOK_SECRET=tu_secret_compartido_aqui
WEBHOOK_ALLOWED_IPS=35.171.132.81,tu_ip_core
```

### Código para tu Core (Node.js)

Agrega esto en el handler donde recibes los webhooks de OPM:

```javascript
// Configuración
const P2P_BOT_CONFIG = {
  url: 'https://tu-bot-railway.up.railway.app/webhook/bank',
  secret: 'tu_secret_compartido_aqui',  // Mismo que WEBHOOK_SECRET
  p2pClabe: '684180327002000XXX',  // CLABE específica para P2P
};

// Función para notificar al bot
async function notifyP2PBot(depositData) {
  // Solo enviar si es para la cuenta P2P
  if (depositData.beneficiaryAccount !== P2P_BOT_CONFIG.p2pClabe) {
    return; // No es depósito P2P, ignorar
  }

  try {
    const response = await fetch(P2P_BOT_CONFIG.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${P2P_BOT_CONFIG.secret}`,
      },
      body: JSON.stringify({
        // Formato OPM directo (el bot lo entiende)
        trackingKey: depositData.trackingKey,
        amount: depositData.amount,
        payerName: depositData.payerName,
        payerAccount: depositData.payerAccount,
        beneficiaryAccount: depositData.beneficiaryAccount,
        concept: depositData.concept,
        numericalReference: depositData.numericalReference,
        receivedTimestamp: depositData.receivedTimestamp,
      }),
    });

    const result = await response.json();
    console.log('[P2P Bot] Notified:', result);
    return result;
  } catch (error) {
    console.error('[P2P Bot] Failed to notify:', error);
  }
}

// En tu webhook handler de OPM, después de guardar:
// await notifyP2PBot(extractedDepositData);
```

### Ejemplo de Integración Completa

```javascript
// En tu archivo de webhook handler
app.post('/webhook/opm', async (req, res) => {
  // ... tu lógica existente de validación ...

  const depositData = {
    trackingKey: req.body.data.trackingKey,
    amount: req.body.data.amount,
    beneficiaryAccount: extractFullClabe(req.body.data.beneficiaryAccount),
    payerAccount: extractFullClabe(req.body.data.payerAccount),
    payerName: req.body.data.payerName,
    concept: req.body.data.concept,
    numericalReference: req.body.data.numericalReference,
    receivedTimestamp: Date.now(),
  };

  // Guardar en tu DB
  await saveTransaction(depositData);

  // Notificar al bot P2P (async, no bloquea respuesta)
  notifyP2PBot(depositData).catch(console.error);

  res.json({ status: 'ok' });
});
```

## Endpoints del Bot

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/webhook/bank` | POST | Recibe notificaciones de depósitos |
| `/webhook/opm` | POST | Recibe formato OPM directo |
| `/webhook/reversal` | POST | Notifica devoluciones/chargebacks |
| `/health` | GET | Health check |

## Formato de Payload

### Formato OPM (recomendado)
```json
{
  "trackingKey": "NU39CVNE9FIM8G4PLTSRV5A82UJ4",
  "amount": 3000,
  "payerName": "MARIO GERARDO BARRIOS PATINO",
  "payerAccount": "638180000188329377",
  "beneficiaryAccount": "684180327002000111",
  "concept": "Transferencia Mario Barrios",
  "numericalReference": 140126,
  "receivedTimestamp": 1768419053933
}
```

### Formato Genérico
```json
{
  "transactionId": "unique-id",
  "amount": 3000,
  "senderName": "MARIO GERARDO BARRIOS PATINO",
  "senderAccount": "638180000188329377",
  "receiverAccount": "684180327002000111",
  "concept": "Transferencia",
  "timestamp": "2026-01-14T19:30:54.189Z",
  "status": "completed"
}
```

## Autenticación

El bot acepta cualquiera de estos métodos:

1. **Bearer Token** (recomendado)
   ```
   Authorization: Bearer tu_secret_compartido
   ```

2. **API Key Header**
   ```
   X-API-Key: tu_secret_compartido
   ```

3. **IP Whitelist**
   - Configura `WEBHOOK_ALLOWED_IPS` con las IPs de tu core

## Flujo de Matching

1. Bot recibe webhook con `amount` y `payerName`
2. Busca órdenes en estado `BUYER_PAYED` con `totalPrice` similar
3. Compara nombres (fuzzy match) entre `payerName` y `counterPartNickName`
4. Si coincide: marca como verificado
5. Si no coincide: solicita intervención manual

## Testing

```bash
# Test desde tu máquina
curl -X POST https://tu-bot.up.railway.app/webhook/bank \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer tu_secret" \
  -d '{
    "trackingKey": "TEST123",
    "amount": 1500,
    "payerName": "JUAN PEREZ",
    "beneficiaryAccount": "684180327002000111"
  }'
```
