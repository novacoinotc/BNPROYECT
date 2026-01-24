import axios from 'axios';

async function analyzeClassify() {
  const response = await axios.post(
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    {
      fiat: 'MXN',
      page: 1,
      rows: 25,
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
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    }
  );

  if (!response.data.data) {
    console.log('No data received');
    return;
  }

  console.log('ANÁLISIS: classify vs userIdentity vs posición\n');
  console.log('Pos | Precio | classify   | userIdentity     | Nickname');
  console.log('-'.repeat(75));

  const professionCount = { count: 0, positions: [] as number[] };
  const massCount = { count: 0, positions: [] as number[] };

  response.data.data.forEach((item: any, i: number) => {
    const classify = (item.adv.classify || 'N/A').padEnd(10);
    const identity = (item.advertiser.userIdentity || 'N/A').padEnd(16);
    const pos = i + 1;

    console.log(
      pos.toString().padStart(2) +
        '  | $' +
        item.adv.price +
        ' | ' +
        classify +
        ' | ' +
        identity +
        ' | ' +
        item.advertiser.nickName
    );

    if (item.adv.classify === 'profession') {
      professionCount.count++;
      professionCount.positions.push(pos);
    } else if (item.adv.classify === 'mass') {
      massCount.count++;
      massCount.positions.push(pos);
    }
  });

  console.log('\n\n📊 RESUMEN:');
  console.log(`   profession: ${professionCount.count} anuncios, posiciones promedio: ${(professionCount.positions.reduce((a,b)=>a+b,0)/professionCount.positions.length).toFixed(1)}`);
  console.log(`   mass: ${massCount.count} anuncios, posiciones promedio: ${(massCount.positions.reduce((a,b)=>a+b,0)/massCount.positions.length).toFixed(1)}`);

  console.log('\n\n💡 CONCLUSIÓN:');
  const avgProfession = professionCount.positions.reduce((a,b)=>a+b,0)/professionCount.positions.length;
  const avgMass = massCount.positions.reduce((a,b)=>a+b,0)/massCount.positions.length;

  if (avgProfession < avgMass) {
    console.log('   ✅ Los anuncios "profession" aparecen en MEJORES posiciones que "mass"');
    console.log('   → El campo "classify" SÍ afecta el ordenamiento');
  }
}

analyzeClassify().catch(console.error);
