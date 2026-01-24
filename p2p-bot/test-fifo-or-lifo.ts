/**
 * TEST: ¿Es FIFO o LIFO?
 *
 * Monitorea cuando alguien ACTUALIZA su anuncio (detectado por cambio en surplus)
 * y ve si SUBE o BAJA de posición.
 *
 * Si sube → Es LIFO (actualizar te pone arriba)
 * Si baja → Es FIFO (actualizar te pone abajo)
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import 'dotenv/config';

const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

interface UserState {
  price: string;
  position: number;
  positionInPrice: number; // Posición dentro del mismo precio
  surplus: string;
  activeTime: number;
}

async function fetchAds() {
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
        'User-Agent': 'Mozilla/5.0',
        'Origin': 'https://p2p.binance.com',
      },
      timeout: 30000,
      ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
    }
  );

  if (response.data.code === '000000' && response.data.data) {
    return response.data.data;
  }
  return [];
}

async function analyzeOrdering() {
  console.log('🔬 TEST: ¿FIFO o LIFO?');
  console.log('='.repeat(60));
  console.log('Monitoreando cambios en surplus para detectar actualizaciones...\n');

  const previousState: Map<string, UserState> = new Map();
  const events: Array<{
    time: string;
    nick: string;
    trigger: string;
    positionChange: number;
    positionInPriceChange: number;
  }> = [];

  let iteration = 0;
  const maxIterations = 60; // 5 minutos con intervalos de 5 segundos

  while (iteration < maxIterations) {
    iteration++;
    const now = new Date().toLocaleTimeString('es-MX');

    try {
      const ads = await fetchAds();

      // Calcular posición dentro de cada precio
      const byPrice: Map<string, string[]> = new Map();
      for (const item of ads) {
        const price = item.adv.price;
        if (!byPrice.has(price)) byPrice.set(price, []);
        byPrice.get(price)!.push(item.advertiser.nickName);
      }

      // Procesar cada anuncio
      for (let i = 0; i < ads.length; i++) {
        const item = ads[i];
        const nick = item.advertiser.nickName;
        const price = item.adv.price;
        const surplus = item.adv.surplusAmount;
        const activeTime = item.advertiser.activeTimeInSecond ?? -1;
        const position = i + 1;
        const positionInPrice = byPrice.get(price)!.indexOf(nick) + 1;

        const prev = previousState.get(nick);

        if (prev && prev.price === price) {
          // Mismo precio - podemos comparar posición dentro del precio
          const surplusChanged = prev.surplus !== surplus;
          const posChanged = prev.positionInPrice !== positionInPrice;

          if (surplusChanged && posChanged) {
            // ¡Detectamos actividad + cambio de posición!
            const change = prev.positionInPrice - positionInPrice; // Positivo = subió

            events.push({
              time: now,
              nick,
              trigger: `surplus ${parseFloat(prev.surplus).toFixed(0)} → ${parseFloat(surplus).toFixed(0)}`,
              positionChange: prev.position - position,
              positionInPriceChange: change,
            });

            const arrow = change > 0 ? '⬆️ SUBIÓ' : change < 0 ? '⬇️ BAJÓ' : '➡️ IGUAL';
            console.log(`\n🔔 [${now}] ACTIVIDAD DETECTADA: ${nick}`);
            console.log(`   Precio: $${price}`);
            console.log(`   Surplus: ${parseFloat(prev.surplus).toFixed(0)} → ${parseFloat(surplus).toFixed(0)}`);
            console.log(`   Posición en precio: ${prev.positionInPrice} → ${positionInPrice} ${arrow}`);
          }
        }

        // Guardar estado actual
        previousState.set(nick, { price, position, positionInPrice, surplus, activeTime });
      }

      // Mostrar estado cada 30 segundos
      if (iteration % 6 === 1) {
        console.log(`\n[${now}] Iteración ${iteration}/${maxIterations}`);
        const prices = Array.from(byPrice.keys()).sort((a, b) => parseFloat(a) - parseFloat(b));
        for (const price of prices.slice(0, 2)) {
          const users = byPrice.get(price)!;
          console.log(`  $${price}: ${users.slice(0, 4).join(', ')}${users.length > 4 ? '...' : ''}`);
        }
      }

    } catch (error: any) {
      console.error(`Error: ${error.message}`);
    }

    await new Promise(r => setTimeout(r, 5000));
  }

  // Resumen final
  console.log('\n\n' + '='.repeat(60));
  console.log('📊 RESUMEN FINAL');
  console.log('='.repeat(60));

  if (events.length === 0) {
    console.log('No se detectaron eventos de actualización + cambio de posición');
    console.log('Esto puede significar:');
    console.log('  1. Nadie actualizó durante el monitoreo');
    console.log('  2. Las actualizaciones NO afectan la posición');
  } else {
    const subio = events.filter(e => e.positionInPriceChange > 0).length;
    const bajo = events.filter(e => e.positionInPriceChange < 0).length;
    const igual = events.filter(e => e.positionInPriceChange === 0).length;

    console.log(`Total eventos detectados: ${events.length}`);
    console.log(`  ⬆️ Subieron: ${subio}`);
    console.log(`  ⬇️ Bajaron: ${bajo}`);
    console.log(`  ➡️ Igual: ${igual}`);

    if (subio > bajo) {
      console.log('\n🎯 CONCLUSIÓN: Parece ser LIFO - actualizar te pone ARRIBA');
    } else if (bajo > subio) {
      console.log('\n🎯 CONCLUSIÓN: Parece ser FIFO - actualizar te pone ABAJO');
    } else {
      console.log('\n🎯 CONCLUSIÓN: No hay patrón claro');
    }

    console.log('\nDetalle de eventos:');
    events.forEach(e => {
      console.log(`  [${e.time}] ${e.nick}: ${e.trigger} → pos ${e.positionInPriceChange > 0 ? '+' : ''}${e.positionInPriceChange}`);
    });
  }
}

analyzeOrdering().catch(console.error);
