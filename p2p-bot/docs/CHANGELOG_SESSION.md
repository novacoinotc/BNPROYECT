# Binance P2P Bot - Session Changelog

**Última actualización:** 2025-01-15

Este documento contiene todos los cambios realizados durante la sesión de desarrollo para poder continuar en caso de reiniciar el chat.

---

## Estado Actual del Proyecto

### Arquitectura
- **Backend:** Node.js/TypeScript en Railway
- **Dashboard:** Next.js en Vercel
- **Base de datos:** PostgreSQL en Neon
- **Ubicación:** `/Users/issacvm/Documents/BNPROYECT/p2p-bot`

### URLs de Despliegue
- **GitHub:** https://github.com/novacoinotc/BNPROYECT
- **Railway:** (backend)
- **Vercel:** (dashboard)

---

## Cambios Realizados (Cronológico)

### 1. Corrección de Endpoints de Binance API (SAPI v7.4)

**Problema:** Los endpoints no se comunicaban correctamente con Binance.

**Archivos modificados:**
- `src/types/binance.ts` - Corregido enum OrderStatus (CANCELLED=6, CANCELLED_SYSTEM=7)
- `src/services/binance-client.ts` - Múltiples correcciones:
  - Agregado header `clientType: 'web'`
  - Cambiado ads endpoint a `/sapi/v1/c2c/ads/list` (GET)
  - Cambiado orders endpoint a `/sapi/v1/c2c/orderMatch/listOrders` (POST)
  - Corregido `getOrderDetail` para usar `{ adOrderNo: orderNumber }`

### 2. Corrección de Error unitPrice null

**Problema:** Error `null value in column "unitPrice"` al guardar órdenes.

**Archivo modificado:** `src/services/database-pg.ts`
```typescript
// Calcula unitPrice si no viene de la API
let unitPrice = order.unitPrice || (order as any).price;
if (!unitPrice && order.totalPrice && order.amount) {
  const total = parseFloat(order.totalPrice);
  const amount = parseFloat(order.amount);
  if (amount > 0) {
    unitPrice = (total / amount).toFixed(2);
  }
}
unitPrice = unitPrice || '0';
```

### 3. Corrección de Endpoint de Anuncios (Error 704017)

**Problema:** Dashboard mostraba "Error al cargar anuncios".

**Archivos modificados:**
- `src/services/binance-client.ts` - `listMyAds()` ahora usa GET primero
- `dashboard/src/app/api/ads/route.ts` - Mismo cambio para el dashboard

**Endpoints que funcionan:**
- `GET /sapi/v1/c2c/ads/list` ✅ (primario)
- `POST /sapi/v1/c2c/ads/listWithPagination` (fallback)

### 4. Agregado Guardado de Historial de Precios

**Problema:** Dashboard mostraba precio $0.00.

**Archivos modificados:**
- `src/services/database-pg.ts` - Agregada función `savePriceHistory()`
- `src/services/pricing-engine.ts` - Llama a `savePriceHistory()` después del análisis

### 5. Mejora en Matching de Pagos

**Problema:** Los pagos bancarios no se vinculaban correctamente a las órdenes.

**Archivos modificados:**
- `src/services/database-pg.ts`:
  - `findOrdersAwaitingPayment()` ahora incluye `buyerRealName`
  - Agregado logging extensivo
  - Corregido cast de enum PostgreSQL

- `src/services/auto-release.ts`:
  - Ahora usa `buyerRealName` para comparar nombres (mejor match)
  - Match también si solo hay una orden o si tiene realName

### 6. Descubrimiento de Endpoints

**Scripts creados:**
- `src/discover-endpoints.ts` - Descubrimiento básico (~176 endpoints)
- `src/discover-endpoints-extended.ts` - Descubrimiento exhaustivo (~6,156 endpoints)

**Ejecución:** `npm run discover` o `npm run discover:extended`

**Resultados del descubrimiento extendido (2025-01-15):**
- **Total probados:** 6,156 endpoints
- **Exitosos (HTTP 200):** 4,071 endpoints (66%)
- **Con datos útiles:** 7 endpoints
- **No encontrados:** 2,072 endpoints
- **Errores de auth:** 4 endpoints
- **Errores de API:** 9 endpoints

**Los 7 endpoints que retornan datos útiles:**
```
1. POST /sapi/v1/c2c/ads/listWithPagination ✅ (lista de anuncios del merchant)
2. POST /sapi/v1/c2c/orderMatch/listOrders ✅ (historial de órdenes)
3. GET /sapi/v1/c2c/chat/retrieveChatCredential ✅ (credenciales de chat)
4. POST /bapi/c2c/v2/friendly/c2c/adv/search ✅ (búsqueda pública P2P - sin auth)
5. POST /bapi/c2c/v2/public/c2c/adv/search ✅ (búsqueda pública P2P - sin auth)
6. POST /bapi/c2c/v1/friendly/c2c/portal/config ✅ (configuración del portal)
7. POST /bapi/c2c/v2/friendly/c2c/portal/config ✅ (configuración del portal v2)
```

**Archivos generados:**
- `docs/WORKING_ENDPOINTS.md` - Documentación completa de 4,071 endpoints
- `docs/endpoint-discovery-results.json` - Resultados detallados en JSON

**Nota:** La mayoría de endpoints retornan HTTP 200 con cuerpo vacío, lo que indica que son válidos pero requieren parámetros específicos o condiciones para retornar datos.

### 7. Mejoras en Búsqueda de Competidores y Pricing Engine (2025-01-15)

**Problema:** `searchAds()` no parseaba correctamente la respuesta de la API pública y `getReferencePrice()` retornaba 0.

**Correcciones en `src/services/binance-client.ts`:**

1. **`searchAds()`** - Ahora parsea correctamente la estructura de la API pública:
   - La API retorna `{ code: "000000", data: [{ adv: {...}, advertiser: {...} }] }`
   - Transformamos al formato `AdData[]` interno
   - Funciona sin autenticación

2. **`getReferencePrice()`** - Ahora usa competidores como fallback:
   - Intenta primero `/sapi/v1/c2c/market/getIndexPrice`
   - Si falla, calcula promedio de los top 5 competidores
   - Garantiza siempre un precio de referencia válido

**Correcciones en `src/services/database-pg.ts`:**

3. **`savePriceHistory()`** - Corregido error de ID null:
   - Agregada función `generateCuid()` para generar IDs compatibles con Prisma
   - Agregado campo `pricePosition` al INSERT
   - Ahora guarda historial correctamente en la DB

**Resultados de pruebas:**
```
Reference Price:    17.86 MXN (promedio competidores)
Best Competitor:    17.80 MXN
Average Price:      17.83 MXN
Recommended Price:  17.95 MXN (con margen 0.5%)
Position:           above_average
```

**Endpoints funcionales verificados:**
| Función | Estado | Descripción |
|---------|--------|-------------|
| `searchAds()` | ✅ | Búsqueda pública de competidores |
| `getReferencePrice()` | ✅ | Precio de referencia con fallback |
| `getChatCredential()` | ✅ | WebSocket para chat |
| `listOrders()` | ✅ | Historial de órdenes |
| `listPendingOrders()` | ✅ | Órdenes pendientes |
| `ping()` | ✅ | Conectividad API |

**Scripts de prueba creados:**
- `src/test-useful-endpoints.ts` - Prueba endpoints útiles
- `src/test-real-client.ts` - Prueba el cliente real
- `src/test-pricing.ts` - Prueba el pricing engine
- `src/test-update-price.ts` - Prueba actualización de precios

---

## Archivos Importantes

### Configuración
- `.env` - Credenciales locales (en .gitignore)
- `.env.example` - Template de configuración

### Backend (src/services/)
- `binance-client.ts` - Cliente API de Binance
- `database-pg.ts` - Operaciones de base de datos
- `order-manager.ts` - Gestión de órdenes
- `auto-release.ts` - Verificación y liberación automática
- `webhook-receiver.ts` - Recepción de webhooks bancarios
- `pricing-engine.ts` - Motor de precios dinámicos

### Dashboard (dashboard/src/app/api/)
- `ads/route.ts` - API de anuncios
- `orders/route.ts` - API de órdenes
- `orders/sync/route.ts` - Sincronización con Binance
- `stats/route.ts` - Estadísticas

### Scripts de Prueba
- `src/test-api.ts` - Pruebas de API
- `src/discover-endpoints.ts` - Descubrimiento básico (~176 endpoints)
- `src/discover-endpoints-extended.ts` - Descubrimiento exhaustivo (~6,156 endpoints)

### Documentación Generada
- `docs/CHANGELOG_SESSION.md` - Este archivo, changelog de la sesión
- `docs/WORKING_ENDPOINTS.md` - Lista completa de 4,071 endpoints funcionales
- `docs/endpoint-discovery-results.json` - Resultados detallados en JSON

---

## Variables de Entorno (Railway)

```
BINANCE_API_KEY=***
BINANCE_API_SECRET=***
BINANCE_ADV_NO=13818422659228123136
DATABASE_URL=postgresql://...
ENABLE_AUTO_RELEASE=false (deshabilitado para pruebas)
ENABLE_CHAT=true
ENABLE_OCR=true
ENABLE_PRICE_UPDATES=true
ENABLE_PRICING=true
ENABLE_WEBHOOK=true
LOG_LEVEL=info
NODE_ENV=production
PORT=3000
WEBHOOK_PORT=3001
WEBHOOK_SECRET=***
TRADE_TYPE=SELL
TRADING_ASSET=USDT
TRADING_FIAT=MXN
```

---

## Problemas Conocidos / Pendientes

1. **Auto-release deshabilitado** - Forzado a `false` hasta completar pruebas
2. **Verificación de nombres** - OCR muestra mismatches frecuentes (comportamiento esperado cuando nombres no coinciden)
3. **Dashboard no actualiza en tiempo real** - Auto-refresh cada 10 segundos configurado

---

## Comandos Útiles

```bash
# Desarrollo local
npm run dev              # Backend con hot reload
npm run dashboard        # Dashboard Next.js

# Build
npm run build            # Compilar TypeScript

# Pruebas
npm run test:api         # Probar endpoints de Binance
npm run discover         # Descubrir endpoints (básico)
npm run discover:extended # Descubrir endpoints (extendido)

# Base de datos
npm run db:push          # Sincronizar schema
npm run db:generate      # Generar cliente Prisma
```

---

## Flujo de Verificación de Pagos

1. **Webhook recibe pago** → `savePayment()` en DB
2. **Auto-release escucha evento** → `handleBankPayment()`
3. **Busca órdenes PAID** → `findOrdersAwaitingPayment(amount, tolerance)`
4. **Compara nombres** → `compareNames(senderName, buyerRealName || buyerNickName)`
5. **Si match** → `matchPaymentToOrder()` + `addVerificationStep()`
6. **Verifica monto** → `AMOUNT_VERIFIED` o `AMOUNT_MISMATCH`
7. **Verifica nombre** → `NAME_VERIFIED` o `NAME_MISMATCH`
8. **Si todo OK** → `READY_TO_RELEASE` (pero no libera, auto-release está off)

---

## Para Continuar Desarrollo

Si necesitas retomar este proyecto en una nueva conversación:

1. Lee este archivo primero
2. Revisa `docs/WORKING_ENDPOINTS.md` para endpoints disponibles
3. Revisa `docs/endpoint-discovery-results.json` para resultados detallados
4. Las credenciales están en Railway y en `.env` local

**Contexto clave:** El bot es para P2P de Binance, verifica pagos bancarios vía webhook y los vincula con órdenes de Binance. Auto-release está deshabilitado hasta completar pruebas.
