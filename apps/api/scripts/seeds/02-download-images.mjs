// Download seed post images from Pexels (CC0)
// Run: node scripts/seeds/download-images.mjs
// This is needed once per fresh clone to populate seeds/images/ for the seed scripts.

import fs from "fs";
import path from "path";

const images = {
  keyboard: "https://images.pexels.com/photos/3587478/pexels-photo-3587478.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  bikecommute: "https://images.pexels.com/photos/1568601/pexels-photo-1568601.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  coldbrew: "https://images.pexels.com/photos/312418/pexels-photo-312418.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  monstera: "https://images.pexels.com/photos/4503269/pexels-photo-4503269.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  tidepool: "https://images.pexels.com/photos/3422697/pexels-photo-3422697.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  sourdough: "https://images.pexels.com/photos/1092730/pexels-photo-1092730.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  stargazing: "https://images.pexels.com/photos/3876214/pexels-photo-3876214.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  ribs: "https://images.pexels.com/photos/1624487/pexels-photo-1624487.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  watercolor: "https://images.pexels.com/photos/3915857/pexels-photo-3915857.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  vinyl: "https://images.pexels.com/photos/3945683/pexels-photo-3945683.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  trailrun: "https://images.pexels.com/photos/2528118/pexels-photo-2528118.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  lasagna: "https://images.pexels.com/photos/1092730/pexels-photo-1092730.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
  miso: "https://images.pexels.com/photos/6349331/pexels-photo-6349331.jpeg?auto=compress&cs=tinysrgb&w=1200&h=800&dpr=1",
};

const imagesDir = path.join(import.meta.dirname, "images");
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log(`Created ${imagesDir}/`);
}

let downloaded = 0;
let failed = 0;

for (const [name, url] of Object.entries(images)) {
  const filepath = path.join(imagesDir, `${name}.jpg`);
  if (fs.existsSync(filepath) && fs.statSync(filepath).size > 1000) {
    console.log(`✓ ${name}.jpg (cached)`);
    continue;
  }

  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    fs.writeFileSync(filepath, Buffer.from(buffer));
    console.log(`✓ ${name}.jpg (${Math.round(buffer.byteLength / 1024)} KB)`);
    downloaded++;
  } catch (err) {
    console.error(`✗ ${name}.jpg — ${err.message}`);
    failed++;
  }
}

console.log(`\n${downloaded} downloaded, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
