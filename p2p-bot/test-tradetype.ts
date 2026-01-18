// Test to understand Binance P2P tradeType parameter
// Run with: npx ts-node test-tradetype.ts

async function testTradeType() {
  console.log('Testing Binance P2P tradeType parameter...\n');

  const testCases = [
    { tradeType: 'BUY', description: 'tradeType: BUY (client wants to BUY)' },
    { tradeType: 'SELL', description: 'tradeType: SELL (client wants to SELL)' },
  ];

  for (const testCase of testCases) {
    console.log(`\n=== ${testCase.description} ===`);

    const body = {
      fiat: 'MXN',
      page: 1,
      rows: 5,
      tradeType: testCase.tradeType,
      asset: 'USDT',
      countries: [],
      proMerchantAds: false,
      shieldMerchantAds: false,
      filterType: 'all',
      periods: [],
      additionalKycVerifyFilter: 0,
      payTypes: [],
    };

    try {
      const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Origin': 'https://p2p.binance.com',
          'Referer': 'https://p2p.binance.com/',
        },
        body: JSON.stringify(body),
      });

      const data = await response.json() as any;

      if (data.data && data.data.length > 0) {
        console.log('Results:');
        for (const item of data.data.slice(0, 3)) {
          console.log(`  - ${item.advertiser.nickName}: ${item.adv.price} MXN (tradeType in response: ${item.adv.tradeType})`);
        }
        console.log(`\nAPI tradeType in request: ${testCase.tradeType}`);
        console.log(`API tradeType in response: ${data.data[0].adv.tradeType}`);
        console.log(`Are they same? ${testCase.tradeType === data.data[0].adv.tradeType}`);
      }
    } catch (error: any) {
      console.log('Error:', error.message);
    }
  }

  console.log('\n\n=== CONCLUSION ===');
  console.log('If tradeType in request MATCHES tradeType in response:');
  console.log('  → BUY in request returns BUY ads (merchants who want to BUY = client sells to them)');
  console.log('  → SELL in request returns SELL ads (merchants who want to SELL = client buys from them)');
  console.log('\nSo to find SELLERS like El Conde de Monte-Cristo, use tradeType: SELL');
}

testTradeType();
