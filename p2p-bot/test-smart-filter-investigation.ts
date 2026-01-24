/**
 * INVESTIGACIÓN: Filtro Smart de Binance P2P
 *
 * Este script investiga cómo funciona el ordenamiento del filtro "smart" de Binance
 * y qué parámetros afectan la posición de los anuncios.
 *
 * Ejecutar: npx tsx test-smart-filter-investigation.ts
 */

import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import 'dotenv/config';

const proxyUrl = process.env.PROXY_URL;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

interface Advertiser {
  userNo: string;
  nickName: string;
  userGrade: number;
  monthFinishRate: number;
  monthOrderCount: number;
  positiveRate: number;
  isOnline: boolean;
  proMerchant: boolean;
  userIdentity?: string;
}

interface Ad {
  advNo: string;
  price: string;
  surplusAmount: string;
  minSingleTransAmount: string;
  maxSingleTransAmount: string;
  tradeMethods: any[];
  advertiser: Advertiser;
  // Campos adicionales que podrían influir
  dynamicMaxSingleTransAmount?: string;
  dynamicMaxSingleTransQuantity?: string;
  fiatSymbol?: string;
  isTradable?: boolean;
  tradableQuantity?: string;
}

interface SearchResponse {
  code: string;
  data: Array<{ adv: any; advertiser: any }>;
  total?: number;
}

async function searchAds(params: Record<string, any>): Promise<Ad[]> {
  const defaultBody = {
    fiat: 'MXN',
    page: 1,
    rows: 20,
    tradeType: 'BUY', // BUY = buscamos vendedores
    asset: 'USDT',
    countries: [],
    proMerchantAds: false,
    shieldMerchantAds: false,
    filterType: 'all',
    periods: [],
    additionalKycVerifyFilter: 0,
    payTypes: [],
    publisherType: null,
    ...params,
  };

  try {
    const response = await axios.post<SearchResponse>(
      'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
      defaultBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'https://p2p.binance.com',
          'Referer': 'https://p2p.binance.com/',
        },
        timeout: 30000,
        ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
      }
    );

    if (response.data.code === '000000' && response.data.data) {
      return response.data.data.map(item => ({
        advNo: item.adv.advNo,
        price: item.adv.price,
        surplusAmount: item.adv.surplusAmount,
        minSingleTransAmount: item.adv.minSingleTransAmount,
        maxSingleTransAmount: item.adv.maxSingleTransAmount,
        dynamicMaxSingleTransAmount: item.adv.dynamicMaxSingleTransAmount,
        dynamicMaxSingleTransQuantity: item.adv.dynamicMaxSingleTransQuantity,
        tradableQuantity: item.adv.tradableQuantity,
        isTradable: item.adv.isTradable,
        tradeMethods: item.adv.tradeMethods || [],
        advertiser: {
          userNo: item.advertiser.userNo,
          nickName: item.advertiser.nickName,
          userGrade: item.advertiser.userGrade ?? 0,
          monthFinishRate: item.advertiser.monthFinishRate ?? 0,
          monthOrderCount: item.advertiser.monthOrderCount ?? 0,
          positiveRate: item.advertiser.positiveRate ?? 0,
          isOnline: item.advertiser.isOnline ?? false,
          proMerchant: item.advertiser.proMerchant ?? false,
          userIdentity: item.advertiser.userIdentity,
        },
      }));
    }
    return [];
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    return [];
  }
}

function printAds(ads: Ad[], label: string) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 ${label}`);
  console.log(`${'='.repeat(80)}`);
  console.log(`${'Pos'.padEnd(4)} | ${'Precio'.padEnd(10)} | ${'Nickname'.padEnd(20)} | ${'Orders'.padEnd(8)} | ${'Rate%'.padEnd(7)} | ${'Grade'.padEnd(5)} | ${'Pro'.padEnd(4)} | ${'Online'.padEnd(6)}`);
  console.log('-'.repeat(80));

  ads.slice(0, 15).forEach((ad, i) => {
    const adv = ad.advertiser;
    console.log(
      `${(i + 1).toString().padEnd(4)} | ` +
      `${parseFloat(ad.price).toFixed(2).padEnd(10)} | ` +
      `${adv.nickName.slice(0, 20).padEnd(20)} | ` +
      `${adv.monthOrderCount.toString().padEnd(8)} | ` +
      `${(adv.monthFinishRate * 100).toFixed(1).padEnd(7)} | ` +
      `${adv.userGrade.toString().padEnd(5)} | ` +
      `${(adv.proMerchant ? '✓' : '').padEnd(4)} | ` +
      `${(adv.isOnline ? '✓' : '').padEnd(6)}`
    );
  });
}

function analyzeOrderDifferences(adsA: Ad[], adsB: Ad[], labelA: string, labelB: string) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔍 COMPARACIÓN: ${labelA} vs ${labelB}`);
  console.log(`${'='.repeat(80)}`);

  // Crear mapa de posiciones
  const posA = new Map(adsA.map((ad, i) => [ad.advertiser.nickName, i + 1]));
  const posB = new Map(adsB.map((ad, i) => [ad.advertiser.nickName, i + 1]));

  // Encontrar diferencias de posición
  const differences: Array<{ nick: string; posA: number; posB: number; diff: number }> = [];

  for (const [nick, pA] of posA.entries()) {
    const pB = posB.get(nick);
    if (pB !== undefined && pA !== pB) {
      differences.push({ nick, posA: pA, posB: pB, diff: pA - pB });
    }
  }

  differences.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  if (differences.length > 0) {
    console.log('Usuarios que cambiaron de posición:');
    differences.slice(0, 10).forEach(d => {
      const arrow = d.diff > 0 ? '⬆️' : '⬇️';
      console.log(`  ${arrow} ${d.nick}: pos ${d.posA} → ${d.posB} (${d.diff > 0 ? '+' : ''}${d.diff})`);
    });
  } else {
    console.log('No hay diferencias en el orden');
  }
}

async function investigateSmartFilter() {
  console.log('🔬 INVESTIGACIÓN DEL FILTRO SMART DE BINANCE P2P');
  console.log('================================================\n');

  // Test 1: filterType variations
  console.log('📋 TEST 1: Diferentes valores de filterType');

  const filterTypes = ['all', 'tradable', 'followingOnly'];
  const results: Record<string, Ad[]> = {};

  for (const filterType of filterTypes) {
    console.log(`\n  Probando filterType="${filterType}"...`);
    const ads = await searchAds({ filterType });
    results[filterType] = ads;
    console.log(`  → ${ads.length} resultados`);
    await new Promise(r => setTimeout(r, 500)); // Rate limit
  }

  printAds(results['all'], 'filterType="all" (default)');
  printAds(results['tradable'], 'filterType="tradable"');

  if (results['all'].length > 0 && results['tradable'].length > 0) {
    analyzeOrderDifferences(results['all'], results['tradable'], 'all', 'tradable');
  }

  // Test 2: publisherType variations
  console.log('\n\n📋 TEST 2: Diferentes valores de publisherType');

  const publisherTypes = [null, 'merchant', 'MERCHANT'];

  for (const publisherType of publisherTypes) {
    console.log(`\n  Probando publisherType=${publisherType}...`);
    const ads = await searchAds({ publisherType, filterType: 'all' });
    console.log(`  → ${ads.length} resultados`);
    if (ads.length > 0) {
      printAds(ads, `publisherType=${publisherType}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Test 3: proMerchantAds effect
  console.log('\n\n📋 TEST 3: Efecto de proMerchantAds');

  const adsNormal = await searchAds({ proMerchantAds: false });
  await new Promise(r => setTimeout(r, 500));
  const adsProOnly = await searchAds({ proMerchantAds: true });

  printAds(adsNormal, 'proMerchantAds=false');
  printAds(adsProOnly, 'proMerchantAds=true (solo Pro Merchants)');

  // Test 4: Simular búsqueda como usuario con transAmount
  console.log('\n\n📋 TEST 4: Efecto de transAmount (monto de transacción)');

  const amounts = [undefined, 1000, 5000, 10000, 50000];

  for (const amount of amounts) {
    const label = amount ? `${amount} MXN` : 'sin monto';
    console.log(`\n  Probando transAmount=${label}...`);
    const ads = await searchAds(amount ? { transAmount: amount } : {});
    console.log(`  → ${ads.length} resultados`);

    if (amount === 5000 || amount === undefined) {
      printAds(ads, `transAmount=${label}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Test 5: Análisis de factores de ordenamiento
  console.log('\n\n📋 TEST 5: Análisis de factores de ordenamiento');
  console.log('=' .repeat(80));

  const allAds = await searchAds({ rows: 50 });

  if (allAds.length > 0) {
    // Calcular un "score" hipotético basado en los factores visibles
    const analyzed = allAds.slice(0, 20).map((ad, position) => {
      const adv = ad.advertiser;
      const price = parseFloat(ad.price);

      // Factores potenciales (hipotéticos)
      return {
        position: position + 1,
        nickName: adv.nickName,
        price,
        monthOrderCount: adv.monthOrderCount,
        monthFinishRate: adv.monthFinishRate,
        positiveRate: adv.positiveRate,
        userGrade: adv.userGrade,
        isOnline: adv.isOnline,
        proMerchant: adv.proMerchant,
        surplus: parseFloat(ad.surplusAmount),
        maxTrans: parseFloat(ad.maxSingleTransAmount),
        // Score hipotético
        hypotheticalScore: (
          adv.monthOrderCount * 0.01 +
          adv.monthFinishRate * 100 +
          adv.positiveRate * 50 +
          adv.userGrade * 10 +
          (adv.proMerchant ? 50 : 0) +
          (adv.isOnline ? 20 : 0) -
          price * 0.1 // Precio afecta negativamente
        ).toFixed(2)
      };
    });

    console.log('\nAnálisis de los primeros 20 anuncios:');
    console.log(`${'Pos'.padEnd(4)} | ${'Precio'.padEnd(8)} | ${'Orders'.padEnd(8)} | ${'Finish%'.padEnd(8)} | ${'Positive%'.padEnd(10)} | ${'Score*'.padEnd(8)} | Nickname`);
    console.log('-'.repeat(90));

    analyzed.forEach(a => {
      console.log(
        `${a.position.toString().padEnd(4)} | ` +
        `${a.price.toFixed(2).padEnd(8)} | ` +
        `${a.monthOrderCount.toString().padEnd(8)} | ` +
        `${(a.monthFinishRate * 100).toFixed(1).padEnd(8)} | ` +
        `${(a.positiveRate * 100).toFixed(1).padEnd(10)} | ` +
        `${a.hypotheticalScore.padEnd(8)} | ` +
        `${a.nickName.slice(0, 20)}`
      );
    });

    console.log('\n* Score es una estimación hipotética, no el algoritmo real de Binance');

    // Identificar patrones
    console.log('\n📈 PATRONES IDENTIFICADOS:');
    console.log('-'.repeat(40));

    // Verificar si precio es el factor principal
    let priceOrdered = true;
    for (let i = 1; i < analyzed.length; i++) {
      if (analyzed[i].price < analyzed[i-1].price) {
        priceOrdered = false;
        console.log(`  ❗ Posición ${i+1} tiene MENOR precio que posición ${i}`);
        console.log(`     ${analyzed[i-1].nickName}: $${analyzed[i-1].price} vs ${analyzed[i].nickName}: $${analyzed[i].price}`);

        // ¿Qué tiene mejor el de arriba?
        const upper = analyzed[i-1];
        const lower = analyzed[i];
        if (upper.monthOrderCount > lower.monthOrderCount) {
          console.log(`     → El de arriba tiene MÁS órdenes: ${upper.monthOrderCount} vs ${lower.monthOrderCount}`);
        }
        if (upper.monthFinishRate > lower.monthFinishRate) {
          console.log(`     → El de arriba tiene MEJOR finish rate: ${(upper.monthFinishRate*100).toFixed(1)}% vs ${(lower.monthFinishRate*100).toFixed(1)}%`);
        }
        if (upper.positiveRate > lower.positiveRate) {
          console.log(`     → El de arriba tiene MEJOR positive rate: ${(upper.positiveRate*100).toFixed(1)}% vs ${(lower.positiveRate*100).toFixed(1)}%`);
        }
        if (upper.proMerchant && !lower.proMerchant) {
          console.log(`     → El de arriba es PRO MERCHANT`);
        }
      }
    }

    if (priceOrdered) {
      console.log('  ✓ Los anuncios están ordenados por precio (no se detectó reordenamiento smart)');
    }
  }

  // Test 6: Buscar parámetros adicionales en la respuesta
  console.log('\n\n📋 TEST 6: Campos adicionales en la respuesta API');
  console.log('='.repeat(80));

  const rawResponse = await axios.post(
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    {
      fiat: 'MXN',
      page: 1,
      rows: 5,
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
      },
      ...(proxyAgent && { httpsAgent: proxyAgent, proxy: false }),
    }
  );

  if (rawResponse.data.data && rawResponse.data.data[0]) {
    console.log('\nCampos del primer anuncio (adv):');
    console.log(JSON.stringify(Object.keys(rawResponse.data.data[0].adv).sort(), null, 2));

    console.log('\nCampos del advertiser:');
    console.log(JSON.stringify(Object.keys(rawResponse.data.data[0].advertiser).sort(), null, 2));

    console.log('\nValores completos del primer resultado:');
    console.log(JSON.stringify(rawResponse.data.data[0], null, 2));
  }

  console.log('\n\n🏁 Investigación completada');
}

investigateSmartFilter().catch(console.error);
