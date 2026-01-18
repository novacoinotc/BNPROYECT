# CHANGELOG - Binance P2P Bot

## Resumen del Proyecto
Bot automatizado para gestión de P2P en Binance con:
- **Auto-release**: Liberación automática de crypto con verificación de pagos bancarios
- **Positioning Bot**: Ajuste automático de precios siguiendo competidores o modo smart
- **Dashboard**: Panel de control Next.js para configuración y monitoreo

---

## 2026-01-18

### ✅ Envío de Mensaje al Liberar (En Progreso)
- **Objetivo**: Enviar "Gracias por tu confianza" automáticamente al liberar crypto
- **Implementado**:
  - Método `sendMessage()` en `binance-client.ts`
  - Integración en `auto-release.ts` después de release exitoso
- **Estado**: El API SAPI no acepta los parámetros probados
  - Creado script `test-chat-api.ts` para probar múltiples combinaciones
  - Pendiente: investigar API real desde browser de Binance

### ✅ Limpieza de Logs Verbose
- Reducidos logs de debugging a nivel `debug`:
  - Config por asset en buy-manager.ts y sell-manager.ts
  - SearchAds responses en binance-client.ts
- Eliminado log verbose de respuestas vacías de searchAds

### ✅ Estrategia de Precio por Moneda (Independiente)
- **Antes**: Una sola estrategia (Igualar/Bajar) para todas las monedas
- **Después**: Cada moneda tiene su propia estrategia independiente
- **Archivos modificados**:
  - `database-pg.ts`: Agregado `matchPrice` y `undercutCents` a `AssetPositioningConfig`
  - `settings/page.tsx`: Movido selector de estrategia dentro de cada `TradeConfig`
  - `buy-manager.ts` / `sell-manager.ts`: Pasan config per-asset a engines

---

## Funcionalidades Principales

### 1. Auto-Release Orchestrator (`auto-release.ts`)
Sistema completo de liberación automática:

#### Verificaciones de Seguridad
- ✅ **Verificación de monto**: ±1% tolerancia
- ✅ **Verificación de nombre**: Compara sender bancario vs buyer KYC de Binance
- ✅ **Smart Match**: Vincula pagos por monto Y nombre (no solo monto)
- ✅ **Buyer Risk Assessment**: Evalúa historial del comprador
- ✅ **Double-spend protection**: Previene uso duplicado de pagos
- ✅ **Trusted Buyers**: Lista de compradores de confianza (skip risk check)

#### Configuración (Variables de Entorno)
```env
ENABLE_AUTO_RELEASE=true
MAX_AUTO_RELEASE_AMOUNT=20000
ENABLE_BUYER_RISK_CHECK=true
SKIP_RISK_CHECK_THRESHOLD=1500
RELEASE_AUTH_TYPE=GOOGLE
```

#### Risk Assessor Criteria
- `minOrders=50` - Mínimo órdenes totales
- `min30Day=1` - Mínimo órdenes últimos 30 días
- `minDays=60` - Mínimo días registrado
- `minPositive=85%` - Mínimo tasa positiva

### 2. Positioning Bot (buy-manager.ts / sell-manager.ts)
Gestores independientes para BUY y SELL ads:

#### Modos de Operación
- **Follow Mode**: Sigue el precio de un competidor específico
- **Smart Mode**: Analiza mercado y posiciona inteligentemente

#### Configuración por Asset
Cada moneda (USDT, BTC, ETH, USDC, BNB) puede tener:
- `enabled`: Activar/desactivar bot para ese asset
- `mode`: 'follow' | 'smart'
- `followTarget`: Nickname del competidor a seguir
- `matchPrice`: true = igualar precio, false = bajar
- `undercutCents`: Centavos a bajar si matchPrice=false

### 3. Webhook Receiver (`webhook-receiver.ts`)
Recibe notificaciones bancarias:
- Endpoint: `POST /webhook/bank-payment`
- Sync endpoint: `POST /api/sync-payments`
- Procesa pagos y los vincula a órdenes

### 4. Database (PostgreSQL)
Tablas principales:
- `orders`: Órdenes sincronizadas de Binance
- `bank_payments`: Pagos bancarios recibidos
- `bot_config`: Configuración del bot
- `verification_steps`: Pasos de verificación por orden
- `trusted_buyers`: Compradores de confianza
- `alerts`: Alertas del sistema

---

## Arquitectura de Archivos

```
p2p-bot/
├── src/
│   ├── index.ts                 # Entry point
│   ├── services/
│   │   ├── auto-release.ts      # Orquestador de auto-release
│   │   ├── binance-client.ts    # Cliente API de Binance
│   │   ├── order-manager.ts     # Gestión de órdenes
│   │   ├── chat-handler.ts      # Manejo de chat/mensajes
│   │   ├── webhook-receiver.ts  # Receptor de webhooks bancarios
│   │   ├── ocr-service.ts       # OCR para comprobantes
│   │   ├── buyer-risk-assessor.ts # Evaluación de riesgo
│   │   ├── totp-service.ts      # Generación de códigos 2FA
│   │   ├── database-pg.ts       # Acceso a PostgreSQL
│   │   └── positioning/
│   │       ├── buy-manager.ts   # Gestor de ads BUY
│   │       ├── sell-manager.ts  # Gestor de ads SELL
│   │       ├── follow-engine.ts # Motor de seguimiento
│   │       └── smart-engine.ts  # Motor inteligente
│   ├── types/
│   │   └── binance.ts           # Tipos TypeScript
│   └── utils/
│       └── logger.ts            # Logger (pino)
├── dashboard/                   # Next.js dashboard
│   └── src/app/
│       ├── page.tsx             # Dashboard principal
│       └── settings/page.tsx    # Configuración
└── docs/
    └── WORKING_ENDPOINTS.md     # Endpoints probados
```

---

## API Endpoints Binance (Probados y Funcionando)

### Ads Management
- `GET /sapi/v1/c2c/ads/list` - Listar mis ads ✅
- `POST /sapi/v1/c2c/ads/update` - Actualizar precio ✅
- `POST /sapi/v1/c2c/ads/updateStatus` - Activar/desactivar ✅

### Orders
- `POST /sapi/v1/c2c/orderMatch/listOrders` - Listar órdenes ✅
- `POST /sapi/v1/c2c/orderMatch/getUserOrderDetail` - Detalle de orden ✅
- `POST /sapi/v1/c2c/orderMatch/releaseCoin` - Liberar crypto ✅
- `POST /sapi/v1/c2c/orderMatch/queryCounterPartyOrderStatistic` - Stats del buyer ✅

### Chat
- `GET /sapi/v1/c2c/chat/retrieveChatMessagesWithPagination` - Leer mensajes ✅
- `POST /sapi/v1/c2c/chat/sendMessage` - Enviar mensaje ❌ (parámetros desconocidos)

### Market
- `POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search` - Buscar ads ✅
- `GET /sapi/v1/c2c/market/getIndexPrice` - Precio de referencia ✅

---

## Pendientes / TODO

### Alta Prioridad
- [ ] Investigar API correcta para enviar mensajes de chat
  - Probar capturando requests del browser de Binance
  - Puede ser WebSocket en lugar de REST

### Media Prioridad
- [ ] Agregar más opciones de estrategia de precio
- [ ] Métricas y estadísticas en dashboard
- [ ] Notificaciones (Telegram/Discord) para eventos importantes

### Baja Prioridad
- [ ] Tests automatizados
- [ ] Documentación de API endpoints
- [ ] Multi-cuenta support

---

## Commits Recientes

```
520e6c3 fix: Try multiple parameter formats for sendMessage API
9b3eb4a feat: Enviar mensaje de agradecimiento al liberar + limpiar logs
7925b78 debug: Cambiar log de config por asset a nivel info
a31272b feat: Estrategia de precio por moneda independiente
d5c1541 feat: Add per-asset enable/disable toggle
4979a7d fix: Simplify UI and auto-load competitor list
```

---

## Notas Técnicas

### TradeType Logic (IMPORTANTE)
El API de búsqueda de Binance usa perspectiva del CLIENTE:
- `tradeType: 'BUY'` → Encuentra SELLERS (yo quiero comprar)
- `tradeType: 'SELL'` → Encuentra BUYERS (yo quiero vender)

Para el positioning bot:
- **Mi ad es SELL** → Busco otros SELLERS con `tradeType: 'SELL'`
- **Mi ad es BUY** → Busco otros BUYERS con `tradeType: 'BUY'`

### Name Comparison
El sistema normaliza nombres para comparación:
- Convierte separadores (`,`, `/`, `.`) a espacios
- Compara palabras individuales (orden puede variar)
- Score > 0.3 = match válido

Ejemplo:
- Bank: "SAIB,BRIBIESCA/LOPEZ"
- Binance: "BRIBIESCA LOPEZ SAIB"
- Score: 100% ✅
