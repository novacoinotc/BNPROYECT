/**
 * Capture Binance P2P Chat API requests
 *
 * Este script abre un browser, tú te logueas en Binance,
 * vas al chat de una orden y envías un mensaje.
 * El script captura el request y muestra los detalles.
 */

import puppeteer from 'puppeteer';

async function main() {
  console.log('🚀 Abriendo browser...\n');

  const browser = await puppeteer.launch({
    headless: false, // Visible para que puedas interactuar
    defaultViewport: null, // Tamaño completo
    args: ['--start-maximized'],
  });

  const page = await browser.newPage();

  // Capturar todos los requests
  const capturedRequests: any[] = [];

  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const url = request.url();

    // Capturar requests relacionados con chat/message
    if (url.includes('chat') || url.includes('message') || url.includes('sendMsg')) {
      const data = {
        url: url,
        method: request.method(),
        headers: request.headers(),
        postData: request.postData(),
        timestamp: new Date().toISOString(),
      };

      capturedRequests.push(data);

      console.log('\n' + '='.repeat(70));
      console.log('🎯 CAPTURED REQUEST:');
      console.log('='.repeat(70));
      console.log('URL:', url);
      console.log('Method:', request.method());
      console.log('Headers:', JSON.stringify(request.headers(), null, 2));
      if (request.postData()) {
        console.log('Body:', request.postData());
      }
      console.log('='.repeat(70) + '\n');
    }

    request.continue();
  });

  page.on('response', async (response) => {
    const url = response.url();

    if (url.includes('chat') || url.includes('message') || url.includes('sendMsg')) {
      try {
        const text = await response.text();
        console.log('\n📥 RESPONSE for:', url);
        console.log('Status:', response.status());
        console.log('Body:', text.substring(0, 500));
        console.log('');
      } catch (e) {
        // Ignore errors reading response
      }
    }
  });

  // Ir a Binance P2P
  console.log('📍 Navegando a Binance P2P...');
  console.log('   1. Inicia sesión en tu cuenta');
  console.log('   2. Ve a una orden con chat activo');
  console.log('   3. Envía un mensaje');
  console.log('   4. El script capturará el request\n');

  await page.goto('https://p2p.binance.com/en/myorders', {
    waitUntil: 'networkidle2',
  });

  console.log('✅ Browser abierto. Esperando que envíes un mensaje...');
  console.log('   (Presiona Ctrl+C en terminal cuando termines)\n');

  // Mantener el script corriendo
  await new Promise(() => {}); // Espera infinita hasta Ctrl+C
}

main().catch(console.error);
