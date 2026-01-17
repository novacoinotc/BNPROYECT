# Binance P2P Trading Bot

Bot autónomo para trading P2P en Binance con verificación automática de pagos y liberación de crypto.

## Arquitectura

```
┌─────────────────────────────────────────────────────────────┐
│                        VERCEL                                │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           Dashboard Next.js                          │    │
│  │  - Monitoreo en tiempo real                         │    │
│  │  - Gestión de órdenes                               │    │
│  │  - Alertas y estadísticas                           │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         NEON                                 │
│                    PostgreSQL Database                       │
└─────────────────────────────────────────────────────────────┘
                              ▲
                              │
┌─────────────────────────────────────────────────────────────┐
│                       RAILWAY                                │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              P2P Bot Server                          │    │
│  │  - Binance API Client                               │    │
│  │  - Pricing Engine                                   │    │
│  │  - Order Manager                                    │    │
│  │  - Chat WebSocket                                   │    │
│  │  - Bank Webhook Receiver                            │    │
│  │  - OCR Service                                      │    │
│  │  - Auto-Release Orchestrator                        │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Deploy

### 1. Base de Datos (Neon) ✅

Ya configurada en: `ep-bitter-king-ah17jntp-pooler.c-3.us-east-1.aws.neon.tech`

### 2. Dashboard (Vercel)

```bash
cd dashboard
vercel --prod
```

Variables de entorno en Vercel:
- `DATABASE_URL` = tu connection string de Neon

### 3. Bot Server (Railway)

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Crear proyecto
railway init

# Deploy
railway up
```

Variables de entorno en Railway:
```
DATABASE_URL=postgresql://...
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_ADV_NO=...
TOTP_SECRET=...
WEBHOOK_SECRET=...
```

## Configuración

### Binance API Keys

1. Ve a https://www.binance.com/en/my/settings/api-management
2. Crea una nueva API Key
3. Habilita permisos de P2P/C2C
4. Agrega la IP de Railway a la whitelist

### TOTP Secret

Para obtener tu TOTP secret de Google Authenticator:
1. En Binance, ve a Seguridad > Google Authenticator
2. Al configurar, copia el código secreto (no el QR)
3. O usa una herramienta para extraerlo de un QR existente

### Webhook del Banco

Configura tu banco para enviar POSTs a:
```
https://tu-app.railway.app/webhook/payment
```

## Uso

### Modo Manual (Recomendado al inicio)

```env
ENABLE_AUTO_RELEASE=false
```

El bot:
- ✅ Monitorea órdenes nuevas
- ✅ Auto-ajusta precios
- ✅ Recibe comprobantes por chat
- ✅ Verifica con OCR
- ✅ Notifica cuando está listo para liberar
- ❌ NO libera automáticamente

### Modo Automático

```env
ENABLE_AUTO_RELEASE=true
MAX_AUTO_RELEASE_AMOUNT=10000
REQUIRE_BANK_MATCH=true
REQUIRE_OCR_VERIFICATION=true
```

El bot libera automáticamente cuando:
1. El monto es ≤ MAX_AUTO_RELEASE_AMOUNT
2. El pago coincide con webhook del banco
3. El OCR verifica el comprobante

## Estructura de Archivos

```
p2p-bot/
├── src/
│   ├── index.ts              # Entry point
│   ├── services/
│   │   ├── binance-client.ts # API Binance C2C
│   │   ├── pricing-engine.ts # Motor de precios
│   │   ├── order-manager.ts  # Gestión de órdenes
│   │   ├── chat-handler.ts   # WebSocket chat
│   │   ├── webhook-receiver.ts # Webhook banco
│   │   ├── ocr-service.ts    # Verificación OCR
│   │   ├── auto-release.ts   # Orquestador
│   │   └── database.ts       # Prisma client
│   ├── types/
│   │   └── binance.ts        # TypeScript types
│   └── utils/
│       └── logger.ts         # Pino logger
├── prisma/
│   └── schema.prisma         # DB schema
├── dashboard/                # Next.js dashboard
├── .env.example
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
└── railway.json
```

## Changelog

### 2026-01-17 - Simplified Payment Flow
- Eliminada pestaña "Pendientes" - ya no hay estado PENDING
- Logica simplificada: Pago coincide → MATCHED, No coincide → THIRD_PARTY
- Solo existe la pagina "Pagos de Terceros" para revision manual
- Navegacion actualizada: "Pagos" → "Terceros"

### 2026-01-17 - Third-Party Payment Detection
- **THIRD_PARTY status**: Nuevo estado para pagos de terceros
- Deteccion automatica: Si el nombre del ordenante NO coincide con ningun comprador conocido, el pago se marca como THIRD_PARTY
- Dashboard: Nueva pestaña "Pagos de Terceros" en la seccion de pagos pendientes
- Alerta automatica cuando se detecta un pago de tercero
- Pagos THIRD_PARTY nunca se vinculan automaticamente - requieren revision manual

### 2026-01-17 - Trusted Buyers Fix
- Corregido: Compradores confiables con nickname censurado (ej: "Use***") ya no se sobreescriben
- Ahora se permite multiples compradores con el mismo nickname pero diferente nombre real
- API actualizada para usar `findFirst` + `create` en lugar de `upsert`

### 2026-01-17 - Verification Status Improvements
- Status MANUAL_REVIEW para ordenes que exceden el limite de auto-liberacion
- Prevencion de regresion de status: El status de verificacion solo avanza, nunca retrocede
- Timeline de verificacion siempre se actualiza para debugging

### 2026-01-17 - TOTP Retry Logic
- Reintento automatico con codigo TOTP fresco si la liberacion falla
- Espera al siguiente periodo de 30 segundos antes de reintentar

## Licencia

Privado - Todos los derechos reservados
