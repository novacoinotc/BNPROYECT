/**
 * Test de parámetros ocultos que podrían afectar el orden
 */
import axios from 'axios';

async function testDifferentParams() {
  console.log('🔬 PROBANDO PARÁMETROS QUE PODRÍAN AFECTAR EL ORDEN\n');

  const baseParams = {
    fiat: 'MXN',
    page: 1,
    rows: 10,
    tradeType: 'BUY',
    asset: 'USDT',
    countries: [],
    proMerchantAds: false,
    shieldMerchantAds: false,
    filterType: 'all',
    periods: [],
    additionalKycVerifyFilter: 0,
    payTypes: [],
  };

  const tests = [
    { name: 'Base (default)', params: { ...baseParams } },
    { name: 'classifies: mass', params: { ...baseParams, classifies: ['mass'] } },
    { name: 'classifies: profession', params: { ...baseParams, classifies: ['profession'] } },
    { name: 'classifies: fiat', params: { ...baseParams, classifies: ['fiat'] } },
    { name: 'merchantCheck: true', params: { ...baseParams, merchantCheck: true } },
    { name: 'recommendedMerchant: true', params: { ...baseParams, recommendedMerchant: true } },
    { name: 'preferredMerchant: true', params: { ...baseParams, preferredMerchant: true } },
    { name: 'shieldMerchantAds: true', params: { ...baseParams, shieldMerchantAds: true } },
  ];

  for (const test of tests) {
    try {
      const response = await axios.post(
        'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
        test.params,
        {
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
          timeout: 10000,
        }
      );

      if (response.data.code === '000000' && response.data.data) {
        const results = response.data.data.slice(0, 5);
        console.log(`\n📋 ${test.name}:`);
        results.forEach((item: any, i: number) => {
          console.log(`   ${i + 1}. ${item.advertiser.nickName} @ $${item.adv.price} (${item.adv.classify || 'N/A'})`);
        });
      } else {
        console.log(`\n📋 ${test.name}: Sin resultados`);
      }
    } catch (e: any) {
      console.log(`\n📋 ${test.name}: Error - ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Test especial: ver todos los campos de classify disponibles
  console.log('\n\n🔍 ANALIZANDO CAMPO "classify" DE LOS ANUNCIOS:');
  const response = await axios.post(
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    { ...baseParams, rows: 30 },
    { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }
  );

  const classifyCount = new Map<string, number>();
  for (const item of response.data.data) {
    const classify = item.adv.classify || 'undefined';
    classifyCount.set(classify, (classifyCount.get(classify) || 0) + 1);
  }

  console.log('\nDistribución de classify:');
  for (const [classify, count] of classifyCount) {
    console.log(`   ${classify}: ${count} anuncios`);
  }
}

testDifferentParams().catch(console.error);
