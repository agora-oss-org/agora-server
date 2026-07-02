// Seed post images (Pexels, CC0) — fetched in-memory per seeder run, never persisted to disk. Keeps
// the seed flow writable-directory-free (dev host, self-host container, and the read-only-by-default
// prod image all behave the same way). Override a single image's source via `<NAME>_IMAGE_URL`.
export const SEED_IMAGE_URLS = {
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

/** Fetch a named seed image's bytes. Throws with a clear message on a missing name or failed HTTP fetch. */
export async function fetchSeedImageBytes(name) {
  const url = process.env[`${name.toUpperCase()}_IMAGE_URL`] || SEED_IMAGE_URLS[name];
  if (!url) throw new Error(`no seed image URL registered for "${name}"`);
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`downloading "${name}" image failed: HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  return { bytes: new Uint8Array(buffer), contentType: "image/jpeg" };
}
