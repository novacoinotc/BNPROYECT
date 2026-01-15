# Binance P2P Bot - Session Changelog

**Última actualización:** 2025-01-14 UTC

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
