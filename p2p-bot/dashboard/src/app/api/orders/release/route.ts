import { NextRequest, NextResponse } from 'next/server';

const RAILWAY_API_URL = process.env.RAILWAY_API_URL;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { orderNumber, authType, code } = body;

    if (!orderNumber || !authType || !code) {
      return NextResponse.json(
        { success: false, error: 'orderNumber, authType, and code are required' },
        { status: 400 }
      );
    }

    if (!RAILWAY_API_URL) {
      return NextResponse.json(
        { success: false, error: 'RAILWAY_API_URL not configured' },
        { status: 500 }
      );
    }

    const response = await fetch(`${RAILWAY_API_URL}/api/orders/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderNumber, authType, code }),
      signal: AbortSignal.timeout(30000), // 30 second timeout for release
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { success: false, error: data.error || 'Failed to release order' },
        { status: response.status }
      );
    }

    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Release API error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Failed to release order' },
      { status: 500 }
    );
  }
}
