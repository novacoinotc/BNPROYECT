import { NextRequest, NextResponse } from 'next/server';

const RAILWAY_API_URL = process.env.RAILWAY_API_URL;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderNumber: string }> }
) {
  try {
    const { orderNumber } = await params;

    if (!orderNumber) {
      return NextResponse.json(
        { error: 'Order number is required' },
        { status: 400 }
      );
    }

    // Fetch chat messages from Railway proxy
    if (!RAILWAY_API_URL) {
      return NextResponse.json(
        { error: 'RAILWAY_API_URL not configured' },
        { status: 500 }
      );
    }

    const response = await fetch(`${RAILWAY_API_URL}/api/chat/${orderNumber}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Chat fetch error: ${response.status} - ${errorText}`);
      return NextResponse.json(
        { error: `Failed to fetch chat: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error('Chat API error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch chat messages' },
      { status: 500 }
    );
  }
}
