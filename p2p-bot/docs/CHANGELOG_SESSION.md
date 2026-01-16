# Binance P2P Bot - Session Changelog

**Última actualización:** 2026-01-16 UTC

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

### 8. Corrección de Errores TypeScript para Deploy en Railway (2025-01-15 03:40 UTC)

**Problema:** El deploy en Railway fallaba con errores de TypeScript durante `npm run build`.

**Errores corregidos:**

1. **`src/services/binance-client.ts:193`** - Error de tipo `Advertiser`
   - El tipo `Advertiser` requería propiedades que la API pública no proporciona
   - **Solución:** Agregamos valores por defecto para las propiedades faltantes:
   ```typescript
   advertiser: {
     userNo: item.advertiser.userNo,
     nickName: item.advertiser.nickName,
     realName: item.advertiser.realName,
     userType: item.advertiser.userType,
     // Default values for properties not available from public API
     userGrade: 0,
     monthFinishRate: 0,
     monthOrderCount: 0,
     positiveRate: 0,
     isOnline: false,
   }
   ```

2. **`src/test-real-client.ts:47,71,83`** - Error de tipo `TradeType`
   - El string `'SELL'` no era compatible con el enum `TradeType`
   - **Solución:** Importamos el enum y usamos `TradeType.SELL`:
   ```typescript
   import { TradeType } from './types/binance.js';
   // Cambiado de 'SELL' a TradeType.SELL
   ```

3. **`src/test-update-price.ts:315`** - Error de indexación implícita
   - El spread operator copiaba propiedades `undefined`
   - **Solución:** Usamos `Object.entries()` con filtro:
   ```typescript
   const safeParams: Record<string, any> = {};
   Object.entries(params).forEach(([k, v]) => {
     if (v !== undefined) {
       safeParams[k] = 'FAKE_' + v;
     }
   });
   ```

**Commit:** `a617274 fix: Resolve TypeScript build errors for Railway deploy`

**Resultado:** Deploy exitoso en Railway. Bot operacional.

**Logs confirman funcionamiento:**
```
Bot fully operational!
listPendingOrders: GET success
Got pending orders from Binance
Got recent orders from Binance
💰 Bank payment received via webhook
Payment saved to DB for matching
```

### 9. Sincronización de Órdenes al Iniciar Bot (2025-01-15 04:00 UTC)

**Problema:** El dashboard mostraba "No orders yet" aunque Binance tenía órdenes activas con status "Payment received" (BUYER_PAYED). El bot solo guardaba órdenes cuando las detectaba como "nuevas", pero al reiniciarse perdía el tracking.

**Archivos modificados:**

1. **`src/services/order-manager.ts`**:
   - Cambiado `start()` a `async start()`
   - Agregada función `syncAllOrders()` que:
     - Obtiene órdenes pendientes via `listPendingOrders()`
     - Obtiene órdenes activas via `listOrders()` (incluye BUYER_PAYED)
     - Obtiene historial via `listOrderHistory()`
     - Combina y deduplica todas las órdenes
     - Guarda TODAS en la base de datos al iniciar
     - Muestra breakdown de estados para debugging

2. **`src/index.ts`**:
   - Cambiado `orderManager.start()` a `await orderManager.start()`

**Comportamiento nuevo:**
```
Syncing all orders from Binance to database...
Found pending orders to sync { count: X }
Found active orders via listOrders { count: Y }
Found recent orders to sync { count: Z }
Total unique orders to sync { total: N }
Order status breakdown { statusCounts: { TRADING: 1, BUYER_PAYED: 5, COMPLETED: 20 } }
Order sync complete { savedCount: N, activeTracking: M }
```

**Nota:** Ahora al reiniciar el bot, TODAS las órdenes existentes en Binance se guardarán en la DB y aparecerán en el dashboard.

### 10. Configuración de Variables en Vercel (2025-01-15 04:10 UTC)

**Problema:** El dashboard en Vercel mostraba "Error al cargar anuncios" porque faltaban las credenciales de Binance.

**Solución:** Se agregaron las siguientes variables de entorno en Vercel:
- `BINANCE_API_KEY` - API key de Binance
- `BINANCE_API_SECRET` - API secret de Binance
- `DATABASE_URL` - Ya estaba configurada

**Mejora en componente AdInfo:**
- Ahora muestra el mensaje de error real
- Muestra sugerencia si el error es por variables faltantes

**IMPORTANTE:** Después de agregar variables en Vercel, hay que hacer **Redeploy** para que tomen efecto.

### 11. Proxy de Ads en Railway para evitar geo-restricción (2025-01-14 UTC)

**Problema:** Después de agregar las credenciales de Binance en Vercel, los anuncios seguían sin cargar. El error era: `"Service unavailable from a restricted location"`. Binance bloquea llamadas API desde servidores en USA (Vercel está en Cleveland, Ohio).

**Diagnóstico:**
- Railway está en EU West (Amsterdam) → SIN restricción
- Vercel está en USA → CON restricción de Binance

**Solución:** Crear un proxy en el backend de Railway que el dashboard de Vercel pueda llamar.

**Archivos modificados:**

1. **`src/services/webhook-receiver.ts`**:
   - Agregado import de `getBinanceClient`
   - Agregado middleware CORS para `/api/*`
   - Agregado endpoint `GET /api/ads` que llama a `listMyAds()` y devuelve los datos
   ```typescript
   // CORS para endpoints API
   this.app.use('/api', (req, res, next) => {
     res.header('Access-Control-Allow-Origin', '*');
     ...
   });

   // Proxy de ads
   this.app.get('/api/ads', this.handleAdsProxy.bind(this));
   ```

2. **`dashboard/src/app/api/ads/route.ts`**:
   - Agregada función `tryRailwayProxy()` que intenta el proxy primero
   - Fallback a llamada directa a Binance si el proxy falla
   - Nueva variable de entorno: `RAILWAY_API_URL`

**Configuración necesaria en Vercel:**
```
RAILWAY_API_URL=https://tu-app.up.railway.app
```

**Flujo:**
1. Dashboard llama a `/api/ads` (ruta interna de Next.js)
2. La ruta intenta `RAILWAY_API_URL/api/ads` (proxy en Railway EU)
3. Railway llama a Binance API (sin restricción desde EU)
4. Si el proxy falla, intenta llamada directa (fallback)

**Puerto del proxy:** El endpoint `/api/ads` corre en el mismo puerto que el webhook (WEBHOOK_PORT=3001)

### 12. Fix: Transformación de respuesta de API de anuncios (2025-01-14 UTC)

**Problema:** Después de configurar el proxy, los anuncios seguían mostrando vacío aunque había anuncios activos en Binance.

**Causa raíz:** El endpoint POST `/sapi/v1/c2c/ads/listWithPagination` retorna los datos en formato diferente al esperado:
- **Formato recibido:** `{ code: "000000", data: [{ advNo, tradeType, ... }] }`
- **Formato esperado:** `{ sellList: [...], buyList: [...], merchant: {...} }`

**Solución en `src/services/binance-client.ts`:**
- Agregada función `transformResponse()` dentro de `listMyAds()`
- Detecta si la respuesta es un array (formato `data`) o ya tiene `sellList/buyList`
- Transforma automáticamente filtrando por `tradeType === 'SELL'` o `'BUY'`

```typescript
const transformResponse = (response: any): MerchantAdsDetail | null => {
  // Si ya tiene sellList/buyList, usar directamente
  if (response?.sellList || response?.buyList) {
    return response as MerchantAdsDetail;
  }
  // Si es array (formato data), transformar
  if (Array.isArray(response)) {
    return {
      sellList: response.filter((ad: any) => ad.tradeType === 'SELL'),
      buyList: response.filter((ad: any) => ad.tradeType === 'BUY'),
      merchant: {} as any,
    };
  }
  return null;
};
```

**Resultado verificado:**
- Proxy retorna correctamente 3 sell ads y 7 buy ads
- Anuncio activo: USDT/MXN a $18.25 (advStatus=1)

### 13. Mejora del componente AdInfo - Vista compacta (2025-01-14 UTC)

**Problema:** Los anuncios se mostraban muy largos y con status incorrecto (OFFLINE cuando debería ser ONLINE).

**Cambios en `dashboard/src/components/AdInfo.tsx`:**
- Vista compacta colapsable - click para expandir
- Status correcto basado en `advStatus` (1=ONLINE, 3=OFFLINE)
- Por defecto solo muestra anuncios activos
- Toggle "Ver todos" para incluir offline
- Botón "Editar en Binance" que abre la página de anuncios
- Botón para copiar ID del anuncio
- Borde verde para anuncios activos

### 14. Mostrar órdenes TRADING en el dashboard (2025-01-14 UTC)

**Problema:** El dashboard mostraba "No orders yet" aunque había órdenes nuevas en Binance. Las órdenes con status TRADING (esperando pago del comprador) no se mostraban.

**Cambios (reverted en sección 15):**
- Se intentó agregar `TRADING` a `activeStatuses` pero causó error de Prisma

---

### 15. Fix: Prisma enum validation error para TRADING (2025-01-14 UTC)

**Problema:** Error en Vercel: `PrismaClientValidationError: Invalid value for argument 'in'. Expected OrderStatus.`

El status `TRADING` no existe en el enum `OrderStatus` de Prisma. Cuando Binance envía status `TRADING`, este se mapea a `PENDING` al guardar en la base de datos (ver `mapOrderStatus()` en `src/types/binance.ts`).

**Solución:**

1. **`dashboard/src/app/api/orders/route.ts`:**
   - Removido `TRADING` del array `activeStatuses`
   - El filtro ahora usa solo valores válidos del enum: `['PENDING', 'PAID', 'APPEALING']`

2. **`dashboard/src/components/OrdersTable.tsx`:**
   - Removido `TRADING` de `statusColors` y `statusLabels`
   - `PENDING` ahora muestra "Esperando pago" (label que antes tenía TRADING)

**Mapeo de estados Binance → DB:**
```typescript
// En src/types/binance.ts
'TRADING' → 'PENDING'      // Esperando que comprador pague
'BUYER_PAYED' → 'PAID'     // Comprador marcó pagado
'APPEALING' → 'APPEALING'  // En disputa
'COMPLETED' → 'COMPLETED'  // Completado
```

---

### 16. Sync de órdenes desde Railway a Dashboard (2025-01-14 UTC)

**Problema:** El dashboard no mostraba órdenes porque:
1. Las órdenes se sincronizan desde el backend (Railway)
2. El dashboard solo lee de la base de datos
3. Si el dashboard no tiene forma de sincronizar, solo muestra lo que ya existe

**Solución:** Crear un endpoint de sync en Railway que el dashboard llama.

1. **`src/services/webhook-receiver.ts`:**
   - Nuevo endpoint `POST /api/orders/sync`
   - Llama a `listPendingOrders()` y `listOrderHistory()` de Binance
   - Guarda todas las órdenes en la base de datos
   - Retorna resumen de órdenes sincronizadas

2. **`dashboard/src/app/api/orders/route.ts`:**
   - Antes de retornar órdenes, llama a Railway `/api/orders/sync`
   - Esto asegura que las órdenes están actualizadas
   - Parámetro `skipSync=true` para saltar el sync si es necesario

**Flujo:**
```
Dashboard GET /api/orders
  → Vercel llama a Railway POST /api/orders/sync
    → Railway llama a Binance (sin geo-restricción)
    → Railway guarda órdenes en PostgreSQL
  → Vercel lee órdenes de PostgreSQL
  → Dashboard muestra órdenes
```

**Variables de entorno requeridas en Vercel:**
- `RAILWAY_API_URL` - URL del backend en Railway

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

## Variables de Entorno (Vercel Dashboard)

```
DATABASE_URL=postgresql://...
BINANCE_API_KEY=***
BINANCE_API_SECRET=***
RAILWAY_API_URL=https://tu-app.up.railway.app  # <-- NUEVO: URL del backend en Railway
```

---

## Problemas Conocidos / Pendientes

1. **Auto-release deshabilitado** - Forzado a `false` hasta completar pruebas
2. **Verificación de nombres** - OCR muestra mismatches frecuentes (comportamiento esperado cuando nombres no coinciden)
3. **Dashboard no actualiza en tiempo real** - Auto-refresh cada 10 segundos configurado
4. **Geo-restricción de Binance** - Solucionado con proxy en Railway (ver sección 11)

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

---

## Sesión 2026-01-16 - Reducción de Ruido en Logs y Fixes Críticos

### 17. Reducción de Verbose Logging (Commit: bc3ea8d)

**Problema:** Los logs en Railway tenían demasiado ruido, dificultando ver eventos importantes.

**Cambios realizados:**

1. **`src/services/binance-client.ts`:**
   - Cambiado `[API DEBUG] getOrderDetail FULL RESPONSE` de `logger.info` a `logger.debug`
   - Cambiado `[PENDING ORDERS] Fetched` de `logger.info` a `logger.debug`

2. **`src/services/auto-release.ts`:**
   - Agregado `loggedBlockedOrders: Map<string, string>` para throttle de mensajes repetidos
   - Agregada función `logBlockedOnce(reason, message)` que solo loguea una vez por razón
   - Cambiado `[AUTO-RELEASE CHECK]` de `logger.info` a `logger.debug`
   - Los mensajes `[AUTO-RELEASE BLOCKED]` ahora solo se muestran una vez por orden/razón

3. **`src/services/order-manager.ts`:**
   - Cambiado "Detected status change from recent orders" de `logger.info` a `logger.debug`

### 18. Fix Race Condition en Auto-Release (Commit: aff96d1)

**Problema:** El sistema intentaba liberar crypto ANTES de que el pago bancario fuera emparejado, causando múltiples errores "Payment not verified, refusing to release" antes de eventualmente tener éxito.

**Causa raíz en `auto-release.ts:813`:**
```typescript
const hasBankMatch = !this.config.requireBankMatch || !!pending.bankMatch;
```
Cuando `REQUIRE_BANK_MATCH=false` (default), `hasBankMatch` era siempre `true`, permitiendo que órdenes se pusieran en cola para liberar sin tener transacción bancaria real.

**Solución en `auto-release.ts:965-967`:**
```typescript
// SAFETY: Always require actual bank transaction ID before queueing for release
const hasActualBankMatch = !!pending.bankMatch?.transactionId;

if (hasActualBankMatch && hasBankMatch && hasOcrVerification && meetsConfidence) {
  // Queue for release
}
```

**Resultado:** Ahora las órdenes NO se ponen en cola para liberar hasta que haya confirmación bancaria real.

### 19. Throttling para Reducir Procesamiento Duplicado (Commit: 2aeda78)

**Problema:** La misma orden se procesaba múltiples veces por segundo, generando logs repetidos.

**Cambios en `auto-release.ts`:**
```typescript
// Throttle checkReadyForRelease to prevent duplicate processing
private lastCheckTime: Map<string, number> = new Map();
private readonly CHECK_THROTTLE_MS = 5000; // Only check once per 5 seconds per order

private async checkReadyForRelease(orderNumber: string): Promise<void> {
  // Throttle: Skip if we checked this order recently
  const now = Date.now();
  const lastCheck = this.lastCheckTime.get(orderNumber) || 0;
  if (now - lastCheck < this.CHECK_THROTTLE_MS) {
    return; // Skip - already checked recently
  }
  this.lastCheckTime.set(orderNumber, now);
  // ... rest of function
}
```

**Cleanup:** Se agregó limpieza de mapas (`lastCheckTime`, `loggedBlockedOrders`) cuando órdenes se completan/cancelan para evitar memory leaks.

### 20. Debug Logging para Sync Endpoint (Commit: 2aeda78)

**Problema:** El dashboard mostraba "Sincronizado: 0 ordenes actualizadas de 19" - la sincronización no actualizaba órdenes liberadas manualmente.

**Cambios en `dashboard/src/app/api/orders/sync/route.ts`:**
```typescript
// Log raw response for debugging
console.log(`[BINANCE API] Order ${orderNumber} raw response:`, JSON.stringify(data).substring(0, 500));
console.log(`[BINANCE API] Order ${orderNumber}: status=${orderData?.orderStatus}`);

// Enhanced logging for debugging
console.log(`[SYNC] Order ${order.orderNumber}: API result = ${JSON.stringify({
  success: result.success,
  hasData: !!binanceOrder,
  binanceStatus: binanceOrder?.orderStatus,
  dbStatus: order.status,
})}`);
```

**Para diagnosticar:** Revisar logs de Vercel después de hacer clic en "Sincronizar con Binance".

### 21. Fix: Orden de Prioridad en Sync de Órdenes (Commit: 2d5c487) ⭐ CRÍTICO

**Problema:** "Order status changed" aparecía cada 5 segundos aunque el status NO había cambiado realmente.

**Causa raíz en `order-manager.ts` línea 110:**
```typescript
// ANTES (bug):
for (const order of [...pendingOrders, ...activeOrders, ...recentOrders]) {
  allOrders.set(order.orderNumber, order);
}
```

El problema: `recentOrders` (datos más viejos) sobreescribía a `pendingOrders` (status actual).

**Ejemplo del bug:**
1. `pendingOrders` tiene Order A con "BUYER_PAYED" (actual)
2. `recentOrders` tiene Order A con "TRADING" (de hace 1 hora)
3. Se guarda "TRADING" en memoria
4. El poll obtiene "BUYER_PAYED" de Binance
5. "TRADING" ≠ "BUYER_PAYED" → ¡Cambio de status detectado!
6. Se repite cada 5 segundos...

**Solución:**
```typescript
// DESPUÉS (fix):
// pendingOrders has MOST CURRENT status for active orders
// so it should be processed LAST to take priority
for (const order of [...recentOrders, ...activeOrders, ...pendingOrders]) {
  allOrders.set(order.orderNumber, order);
}
```

### 22. Debug Logging para Comparación de Status (Commit: 809a0cd)

**Cambio temporal** para diagnosticar el problema:
```typescript
} else if (existingOrder.orderStatus !== order.orderStatus) {
  // DEBUG: Log the actual comparison values
  logger.info({
    orderNumber: order.orderNumber,
    existingStatus: existingOrder.orderStatus,
    newStatus: order.orderStatus,
    existingType: typeof existingOrder.orderStatus,
    newType: typeof order.orderStatus,
  }, '[DEBUG] Status comparison - values differ');
```

---

## Resumen de Commits 2026-01-16

| Commit | Descripción | Archivos |
|--------|-------------|----------|
| `bc3ea8d` | Reduce verbose logging | binance-client.ts, auto-release.ts, order-manager.ts |
| `aff96d1` | Fix race condition - require bank match | auto-release.ts |
| `2aeda78` | Add throttling + sync debug logging | auto-release.ts, sync/route.ts |
| `809a0cd` | Add debug for status comparison | order-manager.ts |
| `2d5c487` | **Fix: Correct sync order priority** | order-manager.ts |

---

## Estado Actual del Auto-Release (2026-01-16)

**Configuración:**
```
ENABLE_AUTO_RELEASE=true
MAX_AUTO_RELEASE_AMOUNT=5000 MXN
ENABLE_BUYER_RISK_CHECK=true
SKIP_RISK_CHECK_THRESHOLD=800 MXN
REQUIRE_BANK_MATCH=false (pero ahora se requiere transacción real)
```

**Criterios de Buyer Risk Check:**
- Mínimo 100 órdenes totales
- Mínimo 15 órdenes en 30 días
- Mínimo 100 días registrado
- Mínimo 85% tasa positiva

**El sistema ES SEGURO:**
- ✅ NO libera a compradores sin historial confiable
- ✅ NO libera sin confirmación de pago bancario
- ✅ Compradores riesgosos son BLOQUEADOS para revisión manual

---

## Problemas Pendientes

1. **Dashboard sync "0 actualizadas"** - Necesita revisar logs de Vercel para diagnosticar
2. **"Order status changed" repetido** - Fix aplicado (commit 2d5c487), pendiente verificar
3. **Órdenes liberadas manualmente no actualizan** - Relacionado con el sync

---

### 23. Fix: Normalización de orderStatus numérico vs string (2026-01-16) ⭐⭐ CRÍTICO

**Problema:** Después del fix anterior (commit 2d5c487), el log "[DEBUG] Status comparison - values differ" SEGUÍA apareciendo cada 5 segundos para las mismas órdenes.

**Causa raíz descubierta:**

La API de Binance devuelve `orderStatus` en **DIFERENTES FORMATOS** según el endpoint:

1. **`listPendingOrders`** usa `orderStatusList: [1, 2, 3]` (números) → API retorna `orderStatus` como **NÚMERO** (1, 2, 3, etc.)
2. **`listOrderHistory`** no filtra por status → API retorna `orderStatus` como **STRING** ("TRADING", "BUYER_PAYED", etc.)

**El bug:**
```javascript
// En processOrder():
existingOrder.orderStatus !== order.orderStatus
// Comparaba: 2 !== "BUYER_PAYED" → TRUE (siempre diferente!)
```

**Solución en `src/services/binance-client.ts`:**

1. **Nueva función `normalizeOrderStatus()`:**
```typescript
function normalizeOrderStatus(status: number | string): OrderStatusString {
  if (typeof status === 'string') {
    return status as OrderStatusString;
  }

  const statusMap: Record<number, OrderStatusString> = {
    1: 'TRADING',
    2: 'BUYER_PAYED',
    3: 'APPEALING',
    4: 'COMPLETED',
    6: 'CANCELLED',
    7: 'CANCELLED_BY_SYSTEM',
  };

  return statusMap[status] || 'TRADING';
}
```

2. **Nueva función `normalizeOrders()`:**
```typescript
function normalizeOrders(orders: OrderData[]): OrderData[] {
  return orders.map(order => ({
    ...order,
    orderStatus: normalizeOrderStatus(order.orderStatus),
  }));
}
```

3. **Aplicado a todos los returns de API:**
   - `listOrders()` → `return normalizeOrders(orders);`
   - `listPendingOrders()` → `return normalizeOrders(orders);` (ambos paths)
   - `listOrderHistory()` → `return normalizeOrders(orders);`
   - `getOrderDetail()` → `orderStatus: normalizeOrderStatus(...)`

**También en `src/services/order-manager.ts`:**

4. **Guard contra polling concurrente:**
```typescript
private isPolling: boolean = false;

private async pollOrders(): Promise<void> {
  if (this.isPolling) {
    logger.debug('Previous poll still in progress, skipping');
    return;
  }
  this.isPolling = true;
  try {
    // ... poll logic
  } finally {
    this.isPolling = false;
  }
}
```

5. **Removido debug logging temporal** (ya no necesario).

**Resultado:** Ahora todos los `orderStatus` son strings consistentes. La comparación `"BUYER_PAYED" === "BUYER_PAYED"` funciona correctamente.

---

## Resumen de Commits 2026-01-16 (Actualizado)

| Commit | Descripción | Archivos |
|--------|-------------|----------|
| `bc3ea8d` | Reduce verbose logging | binance-client.ts, auto-release.ts, order-manager.ts |
| `aff96d1` | Fix race condition - require bank match | auto-release.ts |
| `2aeda78` | Add throttling + sync debug logging | auto-release.ts, sync/route.ts |
| `809a0cd` | Add debug for status comparison | order-manager.ts |
| `2d5c487` | Fix: Correct sync order priority | order-manager.ts |
| `51ce695` | **Fix: Normalize numeric orderStatus to string** | binance-client.ts, order-manager.ts |

---

## Para Continuar

Si reinicias la conversación:

1. **Lee este archivo primero** - Tiene todo el contexto
2. **Commits recientes importantes:**
   - `a5993e6` - **CRITICAL: Require name verification for auto-release** (previene pagos de terceros)
   - `51ce695` - Fix de normalización de orderStatus (número vs string)
   - `2d5c487` - Fix del orden de sync
   - `aff96d1` - Fix de race condition en auto-release
3. **Revisar logs de Railway** después del deploy - ya no debería mostrar "Order status changed" repetidamente
4. **El bug era:** La API de Binance devuelve status numérico (2) desde algunos endpoints y string ("BUYER_PAYED") desde otros

---

### 24. CRITICAL: Require Name Verification for Auto-Release (2026-01-16) ⭐⭐⭐

**Problema:** El sistema estaba liberando crypto automáticamente incluso cuando NO podía verificar que el nombre del pagador bancario coincidiera con el comprador de Binance. Esto es un **riesgo de seguridad grave**:

- Los pagos de terceros están **PROHIBIDOS** en Binance P2P
- Pueden indicar fraude o lavado de dinero
- Binance puede congelar tu cuenta por aceptar pagos de terceros

**Cambios en `src/services/auto-release.ts`:**

1. **Nuevo campo `nameVerified` en `PendingRelease`:**
```typescript
interface PendingRelease {
  // ...existing fields...
  nameVerified: boolean;  // CRITICAL: Must verify bank sender matches Binance buyer
}
```

2. **Inicialización con `nameVerified: false`:**
   - Todas las órdenes comienzan con `nameVerified: false`
   - Solo se establece `true` cuando el nombre del banco coincide con el comprador

3. **Verificación en `verifyPaymentMatch`:**
```typescript
const pendingRelease = this.pendingReleases.get(order.orderNumber);
if (pendingRelease) {
  pendingRelease.nameVerified = nameMatches;
  logger.info(/* ... */, nameMatches
    ? '✅ [NAME VERIFIED] Bank sender matches Binance buyer'
    : '❌ [NAME NOT VERIFIED] Bank sender does NOT match - manual release required');
}
```

4. **BLOQUEO en `checkReadyForRelease`:**
```typescript
const nameVerified = pending.nameVerified;

if (!nameVerified && hasActualBankMatch) {
  // Bank payment received but name doesn't match - BLOCK auto-release
  logBlockedOnce('name_not_verified',
    `🚫 [AUTO-RELEASE BLOCKED] Order ${orderNumber}: Name verification FAILED`);

  this.emit('release', {
    type: 'manual_required',
    orderNumber,
    reason: 'Name verification failed - bank sender does not match Binance buyer',
  });
  return; // DO NOT AUTO-RELEASE!
}
```

5. **Condición actualizada para auto-release:**
```typescript
// ANTES (inseguro):
if (hasActualBankMatch && hasBankMatch && hasOcrVerification && meetsConfidence)

// DESPUÉS (seguro):
if (hasActualBankMatch && hasBankMatch && hasOcrVerification && meetsConfidence && nameVerified)
```

**Resultado:**
- ✅ Auto-release SOLO cuando el nombre del banco coincide con el comprador de Binance
- ❌ Si el nombre NO coincide → requiere liberación manual
- ❌ Si no se puede obtener el nombre real del comprador → requiere liberación manual
- ✅ Aprobación manual (`manualApprove`) sigue funcionando y omite la verificación de nombre

---

### 25. PROBLEMA CRÍTICO: Nombre Real del Comprador No Disponible (2026-01-16) 🔴

**Problema detectado:**
Las órdenes muestran "Listo para liberar" en el dashboard pero NO se liberan automáticamente. Revisando los logs:
- `✅ [BUYER-RISK OK]` - El comprador pasa la evaluación de riesgo
- `✅ Comprador verificado - Historial confiable`
- PERO NO aparece `✅ [NAME VERIFIED]` ni `✅ [AUTO-RELEASE READY]`

**Causa raíz:**
El campo `buyer.realName` NO está disponible desde la API de Binance:
- `getOrderDetail()` devuelve `counterPartNickName` (el nickname)
- Pero `buyer.realName`, `maker.realName`, `taker.realName` están todos `undefined`
- Sin el nombre real, `nameVerified` es siempre `false`
- Y el auto-release queda bloqueado para TODAS las órdenes

**Estado actual de la investigación:**
- Se necesita encontrar el endpoint correcto para obtener el nombre real
- La documentación de SAPI 7.4 menciona campos como `buyer.realName`
- Pero en la práctica, `getUserOrderDetail` no los devuelve

**Próximos pasos:**
1. Investigar exhaustivamente todos los endpoints de Binance P2P ✅
2. Buscar documentación actualizada de la API ✅
3. Probar diferentes endpoints y parámetros ✅
4. El nombre SIEMPRE aparece en la interfaz web de Binance, debe haber forma de obtenerlo ✅

**NOTA IMPORTANTE:** El usuario confirmó que ayer el nombre SÍ funcionaba. Algo cambió o hay un endpoint que no estamos usando correctamente.

---

### 26. SOLUCIÓN: Campo buyerName encontrado en getUserOrderDetail (2026-01-16) ✅

**Descubrimiento:**
Después de una investigación exhaustiva probando 24+ endpoints, se encontró que el nombre real del comprador SÍ está disponible, pero en un campo diferente al esperado:

**El campo correcto es `buyerName` (no `buyer.realName`):**
```json
{
  "buyerNickname": "User-42c9d",        // ← Nickname (no sirve para verificación)
  "buyerName": "MENDOZA TORRES JOSE ALEJANDRO",  // ← ¡NOMBRE REAL KYC!
  "sellerNickname": "QuantumCash",
  "sellerName": "Publicidad con Tecnologia en imagen corporativa, S.A. de C.V."
}
```

**El problema era:**
- Buscábamos `order.buyer?.realName` (objeto anidado)
- Pero el campo está en `order.buyerName` (nivel raíz)
- Además, `listPendingOrders` NO devuelve este campo
- Solo `getUserOrderDetail` devuelve el `buyerName`

**Cambios realizados:**

1. **`src/services/binance-client.ts`:**
   - `getOrderDetail()` ahora extrae `buyerName` y lo expone como `buyerRealName`
   - También extrae `sellerName` como `sellerRealName`
   - Logging mejorado para mostrar los campos correctos

2. **`src/services/auto-release.ts`:**
   - `handlePaymentMatch()` ahora llama a `getOrderDetail()` si no tiene `buyerRealName`
   - Esto asegura que SIEMPRE tenemos el nombre real del comprador para verificación
   - Logging mejorado para mostrar el proceso de verificación de nombre

**Flujo corregido:**
1. Llega pago bancario con nombre del pagador: "MENDOZA TORRES JOSE"
2. Se busca la orden correspondiente
3. Se llama a `getOrderDetail()` para obtener `buyerName`: "MENDOZA TORRES JOSE ALEJANDRO"
4. Se compara: similitud 80%+ → ✅ NAME VERIFIED
5. Auto-release procede

**Resultado:**
- ✅ Ahora se obtiene el nombre real del comprador (KYC verificado por Binance)
- ✅ Se puede comparar con el nombre del pagador bancario
- ✅ Se previenen pagos de terceros
- ✅ Auto-release funciona correctamente para compradores legítimos
