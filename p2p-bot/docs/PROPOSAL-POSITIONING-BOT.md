# Propuesta: Bot de Posicionamiento Inteligente P2P

## Resumen

Mejorar el motor de precios existente para ofrecer dos modos de operación:

1. **Modo Inteligente**: Analiza competidores con filtros configurables (volumen, historial, tasa de completado, etc.)
2. **Modo Seguimiento**: Sigue a un vendedor específico ignorando otras variables

---

## Datos Disponibles de la API de Binance

### Por cada anuncio de competidor (`AdData`):

| Campo | Descripción | Uso |
|-------|-------------|-----|
| `price` | Precio del anuncio | Base para posicionamiento |
| `surplusAmount` | Cantidad disponible | Filtrar por volumen mínimo |
| `minSingleTransAmount` | Monto mínimo por transacción | Filtrar por rango de operación |
| `maxSingleTransAmount` | Monto máximo por transacción | Filtrar por rango de operación |

### Por cada anunciante (`Advertiser`):

| Campo | Descripción | Uso |
|-------|-------------|-----|
| `nickName` | Nombre del vendedor | Modo seguimiento |
| `userNo` | ID único del vendedor | Identificación estable |
| `userGrade` | Nivel del usuario (1-5) | Filtrar vendedores serios |
| `monthFinishRate` | Tasa de completado mensual (0-1) | Filtrar vendedores confiables |
| `monthOrderCount` | Órdenes del mes | Filtrar por actividad |
| `positiveRate` | Feedback positivo (0-1) | Filtrar por reputación |
| `isOnline` | Estado online | Solo competir con activos |
| `proMerchant` | Es merchant verificado | Filtrar profesionales |

---

## Modo 1: Posicionamiento Inteligente

### Concepto

El bot analiza TODOS los competidores y aplica filtros configurables para determinar cuáles son "competidores reales" vs "anuncios basura". Solo se posiciona contra los competidores que pasan los filtros.

### Filtros Configurables

```typescript
interface SmartPositioningConfig {
  // === FILTROS DE VENDEDOR ===
  minUserGrade: number;          // Nivel mínimo (1-5), default: 2
  minMonthFinishRate: number;    // Tasa completado mínima (0-1), default: 0.90
  minMonthOrderCount: number;    // Órdenes mínimas del mes, default: 10
  minPositiveRate: number;       // Feedback positivo mínimo (0-1), default: 0.95
  requireOnline: boolean;        // Solo vendedores online, default: true
  requireProMerchant: boolean;   // Solo merchants verificados, default: false

  // === FILTROS DE ANUNCIO ===
  minSurplusAmount: number;      // Volumen mínimo disponible (USDT), default: 100
  minMaxTransAmount: number;     // Monto máximo mínimo (MXN), default: 5000

  // === ESTRATEGIA DE PRECIO ===
  undercutAmount: number;        // Monto a bajar (centavos), default: 1
  undercutPercent: number;       // O porcentaje a bajar, default: 0
  minMargin: number;             // Margen mínimo sobre referencia (%), default: 0.5
  maxMargin: number;             // Margen máximo sobre referencia (%), default: 2.0

  // === COMPORTAMIENTO ===
  updateIntervalMs: number;      // Intervalo de actualización, default: 30000
  maxCompetitorsToAnalyze: number; // Cuántos analizar, default: 20
}
```

### Flujo de Operación

```
1. Obtener top 20 anuncios de Binance P2P API
2. Aplicar filtros de vendedor:
   - ¿userGrade >= minUserGrade?
   - ¿monthFinishRate >= minMonthFinishRate?
   - ¿monthOrderCount >= minMonthOrderCount?
   - ¿positiveRate >= minPositiveRate?
   - ¿isOnline == true? (si requireOnline)
   - ¿proMerchant == true? (si requireProMerchant)
3. Aplicar filtros de anuncio:
   - ¿surplusAmount >= minSurplusAmount?
   - ¿maxSingleTransAmount >= minMaxTransAmount?
4. De los que pasan filtros, obtener el mejor precio
5. Calcular precio target:
   - Si undercutAmount > 0: targetPrice = bestPrice - undercutAmount/100
   - Si undercutPercent > 0: targetPrice = bestPrice * (1 - undercutPercent/100)
6. Aplicar límites de margen:
   - targetPrice = max(minPrice, min(maxPrice, targetPrice))
7. Actualizar anuncio si cambió > threshold
```

### Ejemplo de Configuración

```bash
# .env para posicionamiento inteligente

# Filtros de vendedor
POSITIONING_MIN_USER_GRADE=2
POSITIONING_MIN_FINISH_RATE=0.90
POSITIONING_MIN_ORDER_COUNT=10
POSITIONING_MIN_POSITIVE_RATE=0.95
POSITIONING_REQUIRE_ONLINE=true
POSITIONING_REQUIRE_PRO_MERCHANT=false

# Filtros de anuncio
POSITIONING_MIN_SURPLUS=100
POSITIONING_MIN_MAX_TRANS=5000

# Estrategia
POSITIONING_UNDERCUT_CENTS=1       # Bajar 1 centavo
POSITIONING_MIN_MARGIN=0.5
POSITIONING_MAX_MARGIN=2.0

# Comportamiento
POSITIONING_UPDATE_INTERVAL=30000
```

### Logs Esperados

```
📊 [SMART POSITION] Analyzing 20 competitor ads
🔍 [FILTER] Filtered 12 competitors passing criteria:
   - Grade >= 2: 18/20 passed
   - Finish rate >= 90%: 15/18 passed
   - Order count >= 10: 14/15 passed
   - Positive rate >= 95%: 13/14 passed
   - Online: 12/13 passed
   - Surplus >= 100: 12/12 passed
📈 [SMART POSITION] Best qualified competitor: $20.45 (User: trader_pro)
💰 [SMART POSITION] Target price: $20.44 (undercut $0.01)
✅ [SMART POSITION] Price updated: $20.45 → $20.44
```

---

## Modo 2: Seguimiento de Vendedor

### Concepto

Ignora todas las variables y simplemente sigue a un vendedor específico. Puede igualar su precio o posicionarse debajo de él.

### Configuración

```typescript
interface FollowModeConfig {
  enabled: boolean;              // Activar modo seguimiento
  targetNickName: string;        // Nickname del vendedor a seguir
  targetUserNo?: string;         // O userNo (más estable que nickname)

  // Estrategia
  followStrategy: 'match' | 'undercut';  // Igualar o bajar
  undercutAmount: number;        // Centavos a bajar (si undercut)

  // Fallback cuando el target no está activo
  fallbackEnabled: boolean;      // Usar modo inteligente como fallback
  fallbackConfig?: SmartPositioningConfig;

  // Límites de seguridad
  minMargin: number;             // No bajar de este margen
  maxMargin: number;             // No subir de este margen

  // Comportamiento
  updateIntervalMs: number;
}
```

### Flujo de Operación

```
1. Buscar anuncios del target por nickName o userNo
2. Si target encontrado y online:
   a. Si strategy == 'match': targetPrice = targetAd.price
   b. Si strategy == 'undercut': targetPrice = targetAd.price - undercutAmount/100
3. Si target NO encontrado:
   a. Si fallbackEnabled: usar modo inteligente
   b. Si no: mantener precio actual (no hacer nada)
4. Aplicar límites de margen
5. Actualizar anuncio
```

### Ejemplo de Configuración

```bash
# .env para modo seguimiento

# Activar modo seguimiento
FOLLOW_MODE_ENABLED=true
FOLLOW_TARGET_NICKNAME=trader_competidor
# FOLLOW_TARGET_USERNO=1234567890  # Alternativa más estable

# Estrategia
FOLLOW_STRATEGY=undercut          # 'match' o 'undercut'
FOLLOW_UNDERCUT_CENTS=1           # Bajar 1 centavo

# Fallback a modo inteligente si target no está activo
FOLLOW_FALLBACK_ENABLED=true

# Límites de seguridad
FOLLOW_MIN_MARGIN=0.3
FOLLOW_MAX_MARGIN=2.0

# Comportamiento
FOLLOW_UPDATE_INTERVAL=15000      # Más frecuente para seguir de cerca
```

### Logs Esperados

```
👁️ [FOLLOW MODE] Searching for target: trader_competidor
✅ [FOLLOW MODE] Target found! Price: $20.50, Online: true
📍 [FOLLOW MODE] Strategy: undercut by $0.01
💰 [FOLLOW MODE] Target price: $20.49
✅ [FOLLOW MODE] Price updated to follow target

--- Si target no está activo ---
⚠️ [FOLLOW MODE] Target not found or offline
🔄 [FOLLOW MODE] Falling back to smart positioning
📊 [SMART POSITION] Analyzing 20 competitor ads...
```

---

## Implementación Sugerida

### Estructura de Archivos

```
src/services/
├── pricing-engine.ts          # Motor actual (mantener)
├── smart-positioning.ts       # NUEVO: Modo inteligente
├── follow-positioning.ts      # NUEVO: Modo seguimiento
└── positioning-orchestrator.ts # NUEVO: Coordina ambos modos
```

### Interface del Orquestador

```typescript
interface PositioningOrchestrator {
  // Configuración
  setMode(mode: 'smart' | 'follow' | 'off'): void;
  setSmartConfig(config: Partial<SmartPositioningConfig>): void;
  setFollowConfig(config: Partial<FollowModeConfig>): void;

  // Control
  start(advNo: string, asset: string, fiat: string, tradeType: TradeType): void;
  stop(): void;

  // Estado
  getStatus(): PositioningStatus;
  getLastAnalysis(): PositioningAnalysis;

  // Manual override
  setManualPrice(price: number): Promise<void>;
}
```

### Dashboard UI (Sugerido)

```
┌─────────────────────────────────────────────────────────────┐
│                    POSICIONAMIENTO                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  [🔘 Inteligente]  [⚪ Seguimiento]  [⚪ Manual]  [⚪ Off]   │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  MODO INTELIGENTE                                            │
│  ───────────────────────────────────────                    │
│  Filtros de Vendedor:                                        │
│    Nivel mínimo:        [2▼]                                 │
│    Tasa completado:     [90%]                                │
│    Órdenes mes mínimas: [10]                                 │
│    Feedback positivo:   [95%]                                │
│    ☑️ Solo online  ☐ Solo Pro Merchant                       │
│                                                              │
│  Filtros de Anuncio:                                         │
│    Volumen mínimo:      [100 USDT]                           │
│    Monto máx mínimo:    [$5,000 MXN]                         │
│                                                              │
│  Estrategia:                                                 │
│    Bajar:  [1] centavo(s)  -o-  [0.1]%                       │
│    Margen: [0.5]% - [2.0]%                                   │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│  ESTADO ACTUAL                                               │
│  ─────────────                                               │
│  Competidores analizados: 20                                 │
│  Competidores calificados: 12                                │
│  Mejor precio calificado: $20.45                             │
│  MI PRECIO ACTUAL: $20.44 ✅                                 │
│  Posición en mercado: #1                                     │
│  Margen sobre referencia: 0.8%                               │
│  Última actualización: hace 15s                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Endpoints de Binance Utilizados

### Obtener anuncios de competidores (Público)
```
POST https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search

Body:
{
  "asset": "USDT",
  "fiat": "MXN",
  "tradeType": "SELL",
  "page": 1,
  "rows": 20,
  "publisherType": null
}

Response incluye:
- data[].adv.price
- data[].adv.surplusAmount
- data[].adv.minSingleTransAmount
- data[].adv.maxSingleTransAmount
- data[].advertiser.nickName
- data[].advertiser.userNo
- data[].advertiser.userGrade
- data[].advertiser.monthFinishRate
- data[].advertiser.monthOrderCount
- data[].advertiser.positiveRate
- data[].advertiser.isOnline
- data[].advertiser.proMerchant
```

### Obtener precio de referencia
```
GET /sapi/v1/c2c/market/getIndexPrice?asset=USDT&fiat=MXN
```

### Actualizar mi anuncio
```
POST /sapi/v1/c2c/ads/update
Body: { advNo, price, priceType: 1 }
```

---

## Próximos Pasos

1. **Fase 1**: Implementar `SmartPositioning` clase con filtros configurables
2. **Fase 2**: Implementar `FollowPositioning` clase con modo seguimiento
3. **Fase 3**: Crear `PositioningOrchestrator` que coordine ambos
4. **Fase 4**: Agregar endpoints API para configuración desde dashboard
5. **Fase 5**: Crear UI en dashboard para configuración visual

---

## Preguntas Pendientes

1. ¿Quieres que el modo seguimiento pueda seguir a MÚLTIPLES vendedores o solo uno?
2. ¿Necesitas alertas cuando el target cambia de precio drásticamente?
3. ¿Quieres guardar historial de posicionamiento para análisis?
4. ¿El fallback del modo seguimiento debe ser configurable por separado?

---

## Riesgos y Mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| Competidor baja precio a pérdida | Límite `minMargin` impide seguirlo |
| Target en modo seguimiento manipula precio | Límites de margen + alertas |
| API rate limiting de Binance | Intervalos configurables, backoff exponencial |
| Falso positivo en filtros (excluir buenos competidores) | Configuración granular de cada filtro |
| Target cambia nickname | Opción de usar `userNo` que es estable |

---

*Propuesta creada: 2026-01-17*
*Estado: PENDIENTE DE APROBACIÓN*
