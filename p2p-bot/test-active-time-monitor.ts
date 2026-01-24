/**
 * MONITOREO: activeTimeInSecond
 *
 * Este script monitorea cómo cambia la posición de los anuncios
 * en relación al campo activeTimeInSecond del advertiser.
 *
 * Hipótesis: Binance prioriza vendedores con menor activeTimeInSecond (más activos)
 *
 * Ejecutar: npx tsx test-active-time-monitor.ts
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import 'dotenv/config';

const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

interface AdResult {
  position: number;
  nickName: string;
  price: string;
  activeTimeInSecond: number;
  monthOrderCount: number;
  monthFinishRate: number;
  userIdentity: string;
  vipLevel: number;
  proMerchant: boolean;
  classify: string;
}

async function fetchAds(): Promise<AdResult[]> {
  const response = await axios.post(
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    {
      fiat: 'MXN',
      page: 1,
      rows: 20,
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
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://p2p.binance.com',
        'Referer': 'https://p2p.binance.com/',
      },
      timeout: 30000,
      ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
    }
  );

  if (response.data.code === '000000' && response.data.data) {
    return response.data.data.map((item: any, index: number) => ({
      position: index + 1,
      nickName: item.advertiser.nickName,
      price: item.adv.price,
      activeTimeInSecond: item.advertiser.activeTimeInSecond ?? -1,
      monthOrderCount: item.advertiser.monthOrderCount ?? 0,
      monthFinishRate: item.advertiser.monthFinishRate ?? 0,
      userIdentity: item.advertiser.userIdentity ?? 'UNKNOWN',
      vipLevel: item.advertiser.vipLevel ?? 0,
      proMerchant: item.advertiser.proMerchant ?? false,
      classify: item.adv.classify ?? 'unknown',
    }));
  }
  return [];
}

function printResults(ads: AdResult[], timestamp: string) {
  console.log(`\n[$timestamp] Captura de datos`);
  console.log('='.repeat(120));
  console.log(
    'Pos'.padEnd(4) + ' | ' +
    'Precio'.padEnd(8) + ' | ' +
    'ActiveSec'.padEnd(10) + ' | ' +
    'Orders'.padEnd(8) + ' | ' +
    'Finish%'.padEnd(8) + ' | ' +
    'VIP'.padEnd(4) + ' | ' +
    'Identity'.padEnd(15) + ' | ' +
    'Nickname'
  );
  console.log('-'.repeat(120));

  ads.forEach(ad => {
    const activeStr = ad.activeTimeInSecond === -1 ? 'N/A' : ad.activeTimeInSecond.toString();
    console.log(
      ad.position.toString().padEnd(4) + ' | ' +
      parseFloat(ad.price).toFixed(2).padEnd(8) + ' | ' +
      activeStr.padEnd(10) + ' | ' +
      ad.monthOrderCount.toString().padEnd(8) + ' | ' +
      (ad.monthFinishRate * 100).toFixed(1).padEnd(8) + ' | ' +
      ad.vipLevel.toString().padEnd(4) + ' | ' +
      ad.userIdentity.slice(0, 15).padEnd(15) + ' | ' +
      ad.nickName
    );
  });
}

async function analyzeActiveTimeCorrelation(samples: AdResult[][]) {
  console.log('\n\n📊 ANÁLISIS DE CORRELACIÓN: activeTimeInSecond vs Posición');
  console.log('='.repeat(80));

  // Agregar datos de todas las muestras
  const allData: Array<{ nick: string; avgPosition: number; avgActiveTime: number; samples: number }> = [];
  const userMap = new Map<string, { positions: number[]; activeTimes: number[] }>();

  for (const sample of samples) {
    for (const ad of sample) {
      if (ad.activeTimeInSecond === -1) continue;

      if (!userMap.has(ad.nickName)) {
        userMap.set(ad.nickName, { positions: [], activeTimes: [] });
      }
      const user = userMap.get(ad.nickName)!;
      user.positions.push(ad.position);
      user.activeTimes.push(ad.activeTimeInSecond);
    }
  }

  for (const [nick, data] of userMap.entries()) {
    if (data.positions.length >= 2) {
      const avgPos = data.positions.reduce((a, b) => a + b, 0) / data.positions.length;
      const avgActive = data.activeTimes.reduce((a, b) => a + b, 0) / data.activeTimes.length;
      allData.push({
        nick,
        avgPosition: avgPos,
        avgActiveTime: avgActive,
        samples: data.positions.length,
      });
    }
  }

  // Ordenar por avgActiveTime
  allData.sort((a, b) => a.avgActiveTime - b.avgActiveTime);

  console.log('\nUsuarios ordenados por activeTimeInSecond (menor = más activo):');
  console.log('avgActive'.padEnd(12) + ' | ' + 'avgPos'.padEnd(8) + ' | ' + 'samples'.padEnd(8) + ' | ' + 'Nickname');
  console.log('-'.repeat(60));

  allData.slice(0, 15).forEach(d => {
    console.log(
      d.avgActiveTime.toFixed(0).padEnd(12) + ' | ' +
      d.avgPosition.toFixed(1).padEnd(8) + ' | ' +
      d.samples.toString().padEnd(8) + ' | ' +
      d.nick
    );
  });

  // Calcular correlación simple
  if (allData.length >= 3) {
    const n = allData.length;
    const sumX = allData.reduce((a, b) => a + b.avgActiveTime, 0);
    const sumY = allData.reduce((a, b) => a + b.avgPosition, 0);
    const sumXY = allData.reduce((a, b) => a + b.avgActiveTime * b.avgPosition, 0);
    const sumX2 = allData.reduce((a, b) => a + b.avgActiveTime ** 2, 0);
    const sumY2 = allData.reduce((a, b) => a + b.avgPosition ** 2, 0);

    const correlation = (n * sumXY - sumX * sumY) /
      Math.sqrt((n * sumX2 - sumX ** 2) * (n * sumY2 - sumY ** 2));

    console.log(`\n📈 Correlación (activeTimeInSecond vs Posición): ${correlation.toFixed(3)}`);
    console.log('   Interpretación:');
    if (correlation > 0.5) {
      console.log('   → Correlación POSITIVA fuerte: mayor activeTime = peor posición');
      console.log('   → ⚡ CONFIRMADO: Estar más activo te da mejor posición');
    } else if (correlation > 0.2) {
      console.log('   → Correlación positiva moderada');
    } else if (correlation > -0.2) {
      console.log('   → Sin correlación clara');
    } else {
      console.log('   → Correlación negativa (menor activeTime = peor posición?)');
    }
  }
}

async function monitorLoop(durationMs: number, intervalMs: number) {
  console.log('🔄 MONITOREO DE activeTimeInSecond');
  console.log(`   Duración: ${durationMs / 1000}s`);
  console.log(`   Intervalo: ${intervalMs / 1000}s`);
  console.log('   Presiona Ctrl+C para detener\n');

  const samples: AdResult[][] = [];
  const startTime = Date.now();

  while (Date.now() - startTime < durationMs) {
    try {
      const ads = await fetchAds();
      const timestamp = new Date().toLocaleTimeString('es-MX');
      printResults(ads, timestamp);
      samples.push(ads);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
    }

    await new Promise(r => setTimeout(r, intervalMs));
  }

  // Análisis final
  if (samples.length >= 3) {
    await analyzeActiveTimeCorrelation(samples);
  }

  console.log(`\n✅ Monitoreo completado. ${samples.length} muestras recolectadas.`);
}

// Ejecutar monitoreo por 2 minutos con intervalo de 15 segundos
monitorLoop(120000, 15000).catch(console.error);
