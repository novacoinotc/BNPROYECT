/**
 * DETECTOR DE CAMBIOS DE POSICIÓN EN MISMO PRECIO
 *
 * Monitorea cuando dos usuarios en el mismo precio intercambian posiciones
 * y registra QUÉ CAMBIÓ en ese momento.
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import 'dotenv/config';

const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

interface AdSnapshot {
  position: number;
  price: string;
  nickName: string;
  userNo: string;
  activeTimeInSecond: number;
  isOnline: boolean;
  monthOrderCount: number;
  monthFinishRate: number;
  classify: string;
  surplusAmount: string;
  isTradable: boolean;
  advUpdateTime: any;
}

async function fetchAds(): Promise<AdSnapshot[]> {
  const response = await axios.post(
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    {
      fiat: 'MXN',
      page: 1,
      rows: 30,
      tradeType: 'BUY',
      asset: 'USDT',
      countries: [],
      proMerchantAds: false,
      shieldMerchantAds: false,
      filterType: 'all',
      periods: [],
      additionalKycVerifyFilter: 0,
      payTypes: [],
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://p2p.binance.com',
      },
      timeout: 30000,
      ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
    }
  );

  if (response.data.code === '000000' && response.data.data) {
    return response.data.data.map((item: any, index: number) => ({
      position: index + 1,
      price: item.adv.price,
      nickName: item.advertiser.nickName,
      userNo: item.advertiser.userNo,
      activeTimeInSecond: item.advertiser.activeTimeInSecond ?? -1,
      isOnline: item.advertiser.isOnline ?? false,
      monthOrderCount: item.advertiser.monthOrderCount ?? 0,
      monthFinishRate: item.advertiser.monthFinishRate ?? 0,
      classify: item.adv.classify ?? 'unknown',
      surplusAmount: item.adv.surplusAmount,
      isTradable: item.adv.isTradable ?? true,
      advUpdateTime: item.adv.advUpdateTime,
    }));
  }
  return [];
}

interface SwapEvent {
  timestamp: string;
  price: string;
  userA: { nick: string; posBefore: number; posAfter: number };
  userB: { nick: string; posBefore: number; posAfter: number };
  changes: string[];
}

async function detectSwaps() {
  console.log('🔍 DETECTOR DE INTERCAMBIOS DE POSICIÓN');
  console.log('========================================');
  console.log('Monitoreando cambios de posición entre usuarios en el MISMO precio...\n');

  let previousByPrice: Map<string, AdSnapshot[]> = new Map();
  const swapEvents: SwapEvent[] = [];
  let iteration = 0;

  while (true) {
    iteration++;
    const now = new Date().toLocaleTimeString('es-MX');

    try {
      const ads = await fetchAds();

      // Agrupar por precio
      const byPrice = new Map<string, AdSnapshot[]>();
      for (const ad of ads) {
        if (!byPrice.has(ad.price)) byPrice.set(ad.price, []);
        byPrice.get(ad.price)!.push(ad);
      }

      // Comparar con estado anterior
      if (previousByPrice.size > 0) {
        for (const [price, currentUsers] of byPrice) {
          const prevUsers = previousByPrice.get(price);
          if (!prevUsers || prevUsers.length < 2) continue;

          // Crear mapas de posición
          const prevPositions = new Map(prevUsers.map((u, i) => [u.nickName, { pos: i, data: u }]));
          const currPositions = new Map(currentUsers.map((u, i) => [u.nickName, { pos: i, data: u }]));

          // Buscar intercambios
          for (const [nick, curr] of currPositions) {
            const prev = prevPositions.get(nick);
            if (!prev) continue;

            // Si este usuario SUBIÓ de posición
            if (curr.pos < prev.pos) {
              // Encontrar quién BAJÓ
              for (const [otherNick, otherCurr] of currPositions) {
                if (otherNick === nick) continue;
                const otherPrev = prevPositions.get(otherNick);
                if (!otherPrev) continue;

                // Si el otro bajó y ahora está debajo de nosotros
                if (otherCurr.pos > otherPrev.pos && otherCurr.pos > curr.pos) {
                  // ¡INTERCAMBIO DETECTADO!
                  const changes: string[] = [];

                  // Detectar qué cambió
                  const prevData = prev.data;
                  const currData = curr.data;
                  const otherPrevData = otherPrev.data;
                  const otherCurrData = otherCurr.data;

                  // Cambios en el que SUBIÓ
                  if (prevData.activeTimeInSecond !== currData.activeTimeInSecond) {
                    changes.push(`${nick} activeTime: ${prevData.activeTimeInSecond}→${currData.activeTimeInSecond}`);
                  }
                  if (prevData.surplusAmount !== currData.surplusAmount) {
                    changes.push(`${nick} surplus: ${prevData.surplusAmount}→${currData.surplusAmount}`);
                  }
                  if (prevData.isTradable !== currData.isTradable) {
                    changes.push(`${nick} isTradable: ${prevData.isTradable}→${currData.isTradable}`);
                  }

                  // Cambios en el que BAJÓ
                  if (otherPrevData.activeTimeInSecond !== otherCurrData.activeTimeInSecond) {
                    changes.push(`${otherNick} activeTime: ${otherPrevData.activeTimeInSecond}→${otherCurrData.activeTimeInSecond}`);
                  }
                  if (otherPrevData.surplusAmount !== otherCurrData.surplusAmount) {
                    changes.push(`${otherNick} surplus: ${otherPrevData.surplusAmount}→${otherCurrData.surplusAmount}`);
                  }
                  if (otherPrevData.isTradable !== otherCurrData.isTradable) {
                    changes.push(`${otherNick} isTradable: ${otherPrevData.isTradable}→${otherCurrData.isTradable}`);
                  }

                  const event: SwapEvent = {
                    timestamp: now,
                    price,
                    userA: { nick, posBefore: prev.pos + 1, posAfter: curr.pos + 1 },
                    userB: { nick: otherNick, posBefore: otherPrev.pos + 1, posAfter: otherCurr.pos + 1 },
                    changes,
                  };

                  swapEvents.push(event);

                  console.log(`\n🔄 ¡INTERCAMBIO DETECTADO! [${now}]`);
                  console.log(`   Precio: $${price}`);
                  console.log(`   ⬆️ ${nick}: posición ${prev.pos + 1} → ${curr.pos + 1}`);
                  console.log(`   ⬇️ ${otherNick}: posición ${otherPrev.pos + 1} → ${otherCurr.pos + 1}`);
                  if (changes.length > 0) {
                    console.log(`   📊 Cambios detectados:`);
                    changes.forEach(c => console.log(`      - ${c}`));
                  } else {
                    console.log(`   ❓ Sin cambios visibles en los campos monitoreados`);
                  }
                }
              }
            }
          }
        }
      }

      // Mostrar estado actual cada 30 segundos
      if (iteration % 3 === 1) {
        console.log(`\n[${now}] Estado actual - Top precios:`);
        const prices = Array.from(byPrice.keys()).sort((a, b) => parseFloat(a) - parseFloat(b));
        for (const price of prices.slice(0, 2)) {
          const users = byPrice.get(price)!;
          console.log(`  $${price}: ${users.map(u => u.nickName).join(' → ')}`);
        }
      }

      previousByPrice = byPrice;

    } catch (error: any) {
      console.error(`Error: ${error.message}`);
    }

    await new Promise(r => setTimeout(r, 10000)); // Check cada 10 segundos
  }
}

detectSwaps().catch(console.error);
