// Test script for Binance P2P search ads API
// Run with: npx ts-node test-search-ads.ts

async function testSearchAds() {
  console.log('Testing Binance P2P Search Ads API...\n');

  // Test different body configurations
  const testCases = [
    {
      name: 'Minimal params',
      body: {
        asset: 'USDT',
        fiat: 'MXN',
        tradeType: 'SELL',
        page: 1,
        rows: 10,
      }
    },
    {
      name: 'With empty arrays',
      body: {
        asset: 'USDT',
        fiat: 'MXN',
        tradeType: 'SELL',
        page: 1,
        rows: 10,
        payTypes: [],
        countries: [],
      }
    },
    {
      name: 'Full web format',
      body: {
        fiat: 'MXN',
        page: 1,
        rows: 20,
        tradeType: 'SELL',
        asset: 'USDT',
        countries: [],
        proMerchantAds: false,
        shieldMerchantAds: false,
        filterType: 'all',
        periods: [],
        additionalKycVerifyFilter: 0,
        payTypes: [],
      }
    },
    {
      name: 'Without filterType',
      body: {
        fiat: 'MXN',
        page: 1,
        rows: 20,
        tradeType: 'SELL',
        asset: 'USDT',
        countries: [],
        proMerchantAds: false,
        shieldMerchantAds: false,
        payTypes: [],
      }
    },
  ];

  for (const testCase of testCases) {
    console.log(`\n=== Test: ${testCase.name} ===`);
    console.log('Body:', JSON.stringify(testCase.body, null, 2));

    try {
      const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Origin': 'https://p2p.binance.com',
          'Referer': 'https://p2p.binance.com/',
        },
        body: JSON.stringify(testCase.body),
      });

      const data = await response.json() as any;
      console.log('HTTP Status:', response.status);
      console.log('Code:', data.code);
      console.log('Message:', data.message || 'none');
      console.log('Data count:', data.data?.length ?? 0);

      if (data.data && data.data.length > 0) {
        console.log('First ad price:', data.data[0].adv.price);
        console.log('First ad seller:', data.data[0].advertiser.nickName);
        console.log('\n✅ SUCCESS! This format works!');
        break;
      }
    } catch (error: any) {
      console.log('Error:', error.message);
    }
  }
}

testSearchAds();
