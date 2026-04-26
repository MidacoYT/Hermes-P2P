#!/usr/bin/env node
// SVG to PNG converter using sharp
// Install dependencies first: npm install sharp

import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sizes = [
  { name: '32x32.png', width: 32, height: 32 },
  { name: '128x128.png', width: 128, height: 128 },
  { name: '128x128@2x.png', width: 256, height: 256 }
];

const svgBuffer = readFileSync(join(__dirname, 'icon.svg'));

async function convert() {
  for (const size of sizes) {
    await sharp(svgBuffer)
      .resize(size.width, size.height)
      .png()
      .toFile(join(__dirname, size.name));
    console.log(`✓ Created ${size.name} (${size.width}x${size.height})`);
  }
  console.log('\nDone! Icons ready for Tauri build.');
}

convert().catch(err => {
  console.error('Error:', err.message);
  console.log('\nMake sure sharp is installed:');
  console.log('  npm install sharp');
  process.exit(1);
});
