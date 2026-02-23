import { NextRequest, NextResponse } from 'next/server';

interface SellerData {
  userNo: string;
  nickName: string;
  price: string;
  surplusAmount: string;
  minAmount: string;
  maxAmount: string;
  isOnline: boolean;
  userGrade: number;
  monthFinishRate: number;
  monthOrderCount: number;
  positiveRate: number;
  proMerchant: boolean;
}

// GET - Fetch current sellers from Binance P2P market
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const asset = searchParams.get('asset') || 'USDT';
  const fiat = searchParams.get('fiat') || 'MXN';
  const tradeType = searchParams.get('tradeType') || 'SELL';
  const rows = parseInt(searchParams.get('rows') || '20');

  try {
    // Binance API max is 20 per page, so paginate if more requested
    const perPage = 20;
    const pages = Math.ceil(rows / perPage);
    let allItems: Array<{
      adv: {
        advNo: string;
        tradeType: string;
        asset: string;
        fiatUnit: string;
        price: string;
        surplusAmount: string;
        minSingleTransAmount: string;
        maxSingleTransAmount: string;
      };
      advertiser: {
        userNo: string;
        nickName: string;
        userGrade?: number;
        monthFinishRate?: number;
        monthOrderCount?: number;
        positiveRate?: number;
        isOnline?: boolean;
        proMerchant?: boolean;
      };
    }> = [];

    for (let page = 1; page <= pages; page++) {
      const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          asset,
          fiat,
          tradeType,
          page,
          rows: perPage,
          payTypes: [],
          publisherType: 'merchant',
          transAmount: null,
        }),
      });

      const rawData = await response.json() as { code?: string; data?: typeof allItems };

      if (rawData.code !== '000000' || !rawData.data) {
        if (page === 1) {
          return NextResponse.json(
            { success: false, error: 'Failed to fetch sellers from Binance' },
            { status: 500 }
          );
        }
        break; // Got some data from earlier pages, use what we have
      }

      allItems.push(...rawData.data);
      if (rawData.data.length < perPage) break; // No more pages
    }

    // Transform to seller list
    const sellers: SellerData[] = allItems.slice(0, rows).map((item, index) => ({
      position: index + 1,
      userNo: item.advertiser.userNo,
      nickName: item.advertiser.nickName,
      price: item.adv.price,
      surplusAmount: item.adv.surplusAmount,
      minAmount: item.adv.minSingleTransAmount,
      maxAmount: item.adv.maxSingleTransAmount,
      isOnline: item.advertiser.isOnline ?? false,
      userGrade: item.advertiser.userGrade ?? 0,
      monthFinishRate: item.advertiser.monthFinishRate ?? 0,
      monthOrderCount: item.advertiser.monthOrderCount ?? 0,
      positiveRate: item.advertiser.positiveRate ?? 0,
      proMerchant: item.advertiser.proMerchant ?? false,
    }));

    return NextResponse.json({
      success: true,
      sellers,
      asset,
      fiat,
      tradeType,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching sellers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch sellers' },
      { status: 500 }
    );
  }
}
