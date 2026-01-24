/**
 * TEST: ¿Actualizar precio resetea la posición?
 *
 * Hipótesis: Si cambias el precio (aunque sea +1/-1 centavo y regresas),
 * podrías "resetear" tu timestamp y subir en la cola FIFO.
 *
 * Este script monitorea la posición de un usuario específico antes/después
 * de que actualice su precio.
 *
 * Ejecutar: npx tsx test-position-reset.ts
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import 'dotenv/config';

const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

// Configura aquí tu nickname para monitorear
const TARGET_NICKNAME = process.env.BINANCE_NICKNAME || 'TU_NICKNAME_AQUI';

interface AdPosition {
  position: number;
  price: string;
  nickName: string;
  advUpdateTime: string | null;
  createTime: string | null;
}

async function getPositions(): Promise<AdPosition[]> {
  const response = await axios.post(
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    {
      fiat: 'MXN',
      page: 1,
      rows: 30,
      tradeType: 'BUY', // Buscamos vendedores
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
      advUpdateTime: item.adv.advUpdateTime,
      createTime: item.adv.createTime,
    }));
  }
  return [];
}

function findUsersByPrice(ads: AdPosition[], price: string): AdPosition[] {
  return ads.filter(ad => ad.price === price);
}

async function monitorPositionChanges() {
  console.log('🔍 MONITOR DE POSICIÓN - Detectando cambios en el orden');
  console.log('=========================================================\n');
  console.log(`Buscando: ${TARGET_NICKNAME}`);
  console.log('Este script detecta cuando alguien actualiza su precio y si eso cambia su posición.\n');

  let previousState: Map<string, { position: number; price: string }> = new Map();
  let iteration = 0;

  while (true) {
    iteration++;
    const timestamp = new Date().toLocaleTimeString('es-MX');

    try {
      const ads = await getPositions();

      // Agrupar por precio
      const priceGroups = new Map<string, AdPosition[]>();
      for (const ad of ads) {
        if (!priceGroups.has(ad.price)) {
          priceGroups.set(ad.price, []);
        }
        priceGroups.get(ad.price)!.push(ad);
      }

      // Mostrar estado actual
      console.log(`\n[${timestamp}] Iteración ${iteration}`);
      console.log('-'.repeat(60));

      // Mostrar los primeros precios con sus usuarios
      const sortedPrices = Array.from(priceGroups.keys()).sort((a, b) => parseFloat(a) - parseFloat(b));

      for (const price of sortedPrices.slice(0, 3)) {
        const usersAtPrice = priceGroups.get(price)!;
        console.log(`\n💰 Precio $${price} (${usersAtPrice.length} vendedores):`);
        usersAtPrice.forEach((u, i) => {
          const marker = u.nickName === TARGET_NICKNAME ? ' ⭐ TÚ' : '';
          console.log(`   ${i + 1}. ${u.nickName}${marker}`);
        });
      }

      // Detectar cambios de posición
      for (const ad of ads) {
        const prev = previousState.get(ad.nickName);
        if (prev) {
          // Detectar cambio de precio
          if (prev.price !== ad.price) {
            console.log(`\n🔄 CAMBIO DETECTADO: ${ad.nickName}`);
            console.log(`   Precio: $${prev.price} → $${ad.price}`);
            console.log(`   Posición: ${prev.position} → ${ad.position}`);
          }
          // Detectar cambio de posición sin cambio de precio
          else if (prev.position !== ad.position) {
            console.log(`\n📊 MOVIMIENTO: ${ad.nickName}`);
            console.log(`   Precio: $${ad.price} (sin cambio)`);
            console.log(`   Posición: ${prev.position} → ${ad.position}`);
          }
        }
        previousState.set(ad.nickName, { position: ad.position, price: ad.price });
      }

      // Buscar al usuario target
      const targetAd = ads.find(a => a.nickName.toLowerCase() === TARGET_NICKNAME.toLowerCase());
      if (targetAd) {
        console.log(`\n⭐ Tu posición actual: #${targetAd.position} a $${targetAd.price}`);

        // Mostrar cuántos están en el mismo precio
        const samePrice = ads.filter(a => a.price === targetAd.price);
        const posInPrice = samePrice.findIndex(a => a.nickName === targetAd.nickName) + 1;
        console.log(`   Posición dentro del precio $${targetAd.price}: ${posInPrice}/${samePrice.length}`);
      }

    } catch (error: any) {
      console.error(`Error: ${error.message}`);
    }

    // Esperar 10 segundos
    await new Promise(r => setTimeout(r, 10000));
  }
}

// También exportar función para test manual
export async function testPriceUpdateEffect() {
  console.log('📋 TEST: Efecto de actualizar precio en la posición');
  console.log('====================================================\n');

  console.log('INSTRUCCIONES:');
  console.log('1. Este script va a monitorear la posición');
  console.log('2. Mientras corre, actualiza tu precio en Binance (+1 centavo)');
  console.log('3. Luego regresa al precio original');
  console.log('4. Observa si tu posición cambió\n');

  await monitorPositionChanges();
}

testPriceUpdateEffect().catch(console.error);
