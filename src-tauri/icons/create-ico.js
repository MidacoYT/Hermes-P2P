#!/usr/bin/env node
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const pngFiles = [
  join(__dirname, '32x32.png'),
  join(__dirname, '128x128.png')
];

async function createIco() {
  try {
    const buf = await pngToIco(pngFiles);
    writeFileSync(join(__dirname, 'icon.ico'), buf);
    console.log('✓ Created icon.ico from PNG files');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

createIco();
