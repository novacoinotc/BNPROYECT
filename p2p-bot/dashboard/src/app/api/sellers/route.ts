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
    // Use public Binance P2P search API (no auth required)
    const response = await fetch('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        asset,
        fiat,
        tradeType,
        page: 1,
        rows,
        payTypes: [],
        publisherType: null,
        transAmount: null,
      }),
    });

    const rawData = await response.json() as {
      code?: string;
      data?: Array<{
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
      }>;
    };

    if (rawData.code !== '000000' || !rawData.data) {
      return NextResponse.json(
        { success: false, error: 'Failed to fetch sellers from Binance' },
        { status: 500 }
      );
    }

    // Transform to seller list
    const sellers: SellerData[] = rawData.data.map((item, index) => ({
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
