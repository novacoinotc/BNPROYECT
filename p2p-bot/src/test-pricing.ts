/**
 * Test the pricing engine market analysis
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { createPricingEngine } from './services/pricing-engine.js';
import { TradeType } from './types/binance.js';

async function main() {
  console.log('📊 TESTING PRICING ENGINE');
  console.log('═'.repeat(60));

  const engine = createPricingEngine({
    strategy: 'competitive',
    undercutPercentage: 0.1,
    minMargin: 0.5,
    maxMargin: 2.0,
    updateIntervalMs: 30000,
  });

  console.log('\nAnalyzing USDT/MXN SELL market...\n');

  try {
    const analysis = await engine.analyzeMarket('USDT', 'MXN', TradeType.SELL);

    console.log('📈 MARKET ANALYSIS RESULTS');
    console.log('─'.repeat(50));
    console.log(`  Reference Price:    ${analysis.referencePrice.toFixed(2)} MXN`);
    console.log(`  Best Competitor:    ${analysis.bestCompetitorPrice.toFixed(2)} MXN`);
    console.log(`  Average Price:      ${analysis.averagePrice.toFixed(2)} MXN`);
    console.log(`  Recommended Price:  ${analysis.recommendedPrice.toFixed(2)} MXN`);
    console.log(`  Position:           ${analysis.pricePosition}`);
    console.log(`  Margin:             ${analysis.margin.toFixed(2)}%`);

    console.log('\n📊 COMPETITOR PRICES (top 10):');
    analysis.competitorPrices.slice(0, 10).forEach((price, i) => {
      console.log(`  ${i + 1}. ${price.toFixed(2)} MXN`);
    });

    console.log('\n✅ Pricing engine working correctly!');
    console.log('\nNote: Price updates are controlled by ENABLE_PRICE_UPDATES env variable.');

  } catch (error: any) {
    console.log(`\n❌ Error: ${error.message}`);
  }
}

main().catch(console.error);
