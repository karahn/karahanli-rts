/**
 * Karahanlı RTS — 64×32 Piksel Kesintisiz (Seamless) İzometrik Çimen Dokusu Üreticisi
 *
 * Tarihî RTS atmosferine uygun, kenarları periyodik (toroidal) gürültü ile %100 kusursuz
 * birleşen ve iç bölgeleri birbirinden farklı 16 adet 64×32 piksel izometrik çimen karosu üretir.
 */

import Phaser from 'phaser';

export const GRASS_TILE_WIDTH = 64;
export const GRASS_TILE_HEIGHT = 32;
export const GRASS_VARIANT_COUNT = 16;

export interface GrassTileAtlas {
  textureKey: string;
  tileWidth: number;
  tileHeight: number;
  variantCount: number;
  variants: Uint8ClampedArray[];
}

const atlasCache = new Map<string, GrassTileAtlas>();

/**
 * Phaser Texture Manager üzerinde 64×32 piksel boyutlarında 16 farklı çimen karosu içeren
 * doku atlasını oluşturur (veya önbellekten döndürür).
 */
export function ensureGrassTileAtlas(
  scene: Phaser.Scene,
  seed: number
): GrassTileAtlas {
  const textureKey = `karahanli-grass-64x32-s${seed}`;
  const cached = atlasCache.get(textureKey);

  if (cached && scene.textures.exists(textureKey)) {
    return cached;
  }

  const colsInSheet = 4;
  const rowsInSheet = Math.ceil(GRASS_VARIANT_COUNT / colsInSheet);
  const sheetWidth = colsInSheet * GRASS_TILE_WIDTH;
  const sheetHeight = rowsInSheet * GRASS_TILE_HEIGHT;

  if (scene.textures.exists(textureKey)) {
    scene.textures.remove(textureKey);
  }

  const sheetTexture = scene.textures.createCanvas(
    textureKey,
    sheetWidth,
    sheetHeight
  );

  const variants: Uint8ClampedArray[] = [];

  for (let variant = 0; variant < GRASS_VARIANT_COUNT; variant++) {
    const buffer = generateSingleGrassTile64x32(variant, seed);
    variants.push(buffer);

    if (sheetTexture) {
      const ctx = sheetTexture.getContext();
      const tileImageData = new ImageData(
        new Uint8ClampedArray(buffer),
        GRASS_TILE_WIDTH,
        GRASS_TILE_HEIGHT
      );
      const sx = (variant % colsInSheet) * GRASS_TILE_WIDTH;
      const sy = Math.floor(variant / colsInSheet) * GRASS_TILE_HEIGHT;
      ctx.putImageData(tileImageData, sx, sy);

      sheetTexture.add(
        `grass_${variant}`,
        0,
        sx,
        sy,
        GRASS_TILE_WIDTH,
        GRASS_TILE_HEIGHT
      );
    }
  }

  sheetTexture?.refresh();

  const result: GrassTileAtlas = {
    textureKey,
    tileWidth: GRASS_TILE_WIDTH,
    tileHeight: GRASS_TILE_HEIGHT,
    variantCount: GRASS_VARIANT_COUNT,
    variants
  };

  atlasCache.set(textureKey, result);
  return result;
}

/**
 * Tek bir 64×32 piksel izometrik çimen karosunu (RGBA tamponu) üretir.
 *
 * Tam sayı izometrik kafes maskesi:
 *   a = (px - 32) + 2 * py
 *   b = 2 * py - (px - 32)
 *   0 <= a < 64 ve 0 <= b < 64 koşulu düzlemi 0 boşluk ve 0 çakışma ile kaplar (1024 piksel).
 */
function generateSingleGrassTile64x32(
  variant: number,
  seed: number
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(GRASS_TILE_WIDTH * GRASS_TILE_HEIGHT * 4);
  const vSeed = seed + (variant + 1) * 733;

  // 1. Katman: Periyodik kenar uyumlu temel çimen dokusu + varyanta özgü iç doku
  for (let py = 0; py < GRASS_TILE_HEIGHT; py++) {
    for (let px = 0; px < GRASS_TILE_WIDTH; px++) {
      const a = px - 32 + 2 * py;
      const b = 2 * py - (px - 32);

      if (a < 0 || a >= 64 || b < 0 || b >= 64) {
        continue;
      }

      const u = (a + 0.5) / 64;
      const v = (b + 0.5) / 64;

      // Tüm varyantlarda ortak periyodik kenar dokusu (u=0 ile u=1 ve v=0 ile v=1 birebir eşleşir)
      const p2 = periodicValueNoise2D(u * 2, v * 2, 2, seed + 11);
      const p4 = periodicValueNoise2D(u * 4, v * 4, 4, seed + 29);
      const p8 = periodicValueNoise2D(u * 8, v * 8, 8, seed + 53);
      const p16 = periodicValueNoise2D(u * 16, v * 16, 16, seed + 89);

      // Dikey çim liflerini hissettiren anizotropik ince periyodik doku
      const bladeGrain = periodicValueNoise2D(u * 16, v * 8, 8, seed + 131);

      const baseTurf =
        p2 * 0.22 +
        p4 * 0.30 +
        p8 * 0.24 +
        p16 * 0.12 +
        bladeGrain * 0.12;

      // Karo kenarlarında 0, iç bölgede 1 olan yumuşak maske (kenar dikişlerini tamamen gizler)
      const edgeDist = Math.min(u, 1 - u, v, 1 - v);
      const interiorWeight = smoothstep(0.02, 0.26, edgeDist);

      // Her 64×32 varyanta özgü iç çayır kümesi ve hafif kuruluk/canlılık farkı
      const vPatch = valueNoise2D(u * 3.4 + 3.1, v * 3.4 + 7.7, vSeed + 17);
      const vDetail = valueNoise2D(u * 9.2 + 5.9, v * 9.2 + 2.3, vSeed + 41);
      const vDryness = valueNoise2D(u * 2.6 + 11.4, v * 2.6 + 8.2, vSeed + 67);

      const variantTurf = vPatch * 0.52 + vDetail * 0.32 + bladeGrain * 0.16;
      const lushness = Phaser.Math.Clamp(
        Phaser.Math.Linear(baseTurf, variantTurf, interiorWeight * 0.72),
        0,
        1
      );

      const dryPatch =
        Phaser.Math.Clamp((vDryness - 0.48) * 0.42, 0, 0.16) * interiorWeight;

      const rgb = mapHistoricalGrassPalette(lushness, dryPatch);

      const idx = (py * GRASS_TILE_WIDTH + px) * 4;
      buf[idx] = rgb.r;
      buf[idx + 1] = rgb.g;
      buf[idx + 2] = rgb.b;
      buf[idx + 3] = 255;
    }
  }

  // 2. Katman: Karo iç bölgesine yerleştirilen piksel hassasiyetli küçük çimen yaprakları ve toprak/ot benekleri
  stampMicroGrassDetails(buf, variant, vSeed);

  return buf;
}

/**
 * 64×32 izometrik karonun güvenli iç alanına (kenar birleşimini bozmayacak şekilde)
 * küçük çim tutamları ve doğal mikro detaylar işler.
 */
function stampMicroGrassDetails(
  buf: Uint8ClampedArray,
  variant: number,
  vSeed: number
): void {
  const tuftCount = 10 + (variant % 3);

  for (let i = 0; i < tuftCount; i++) {
    // Kenarlardan en az %18 içeride kalacak şekilde (u, v) seçimi
    const u = 0.18 + hash2D(i, 1, vSeed + 101) * 0.64;
    const v = 0.18 + hash2D(i, 2, vSeed + 149) * 0.64;

    // (u, v) -> 64×32 karo içi piksel koordinatı (px, py)
    const px = Math.round(32 + (u - v) * 32);
    const py = Math.round((u + v) * 16);

    const styleRoll = hash2D(i, 3, vSeed + 193);
    const lean = hash2D(i, 4, vSeed + 227) > 0.5 ? 1 : -1;

    // Kök gölgesi (1 piksel koyu yosun tonu)
    blendPixelInsideDiamond(buf, px, py, 34, 56, 24, 0.42);

    if (styleRoll < 0.72) {
      // Kısa doğal çim yaprağı (2 piksel yüksekliğinde) + yan filiz
      blendPixelInsideDiamond(buf, px, py - 1, 96, 134, 55, 0.50);
      blendPixelInsideDiamond(buf, px + lean, py - 2, 134, 164, 74, 0.44);
      blendPixelInsideDiamond(buf, px - lean, py - 1, 78, 114, 46, 0.36);
    } else if (styleRoll < 0.90) {
      // Güneş alan bozkır kuru ot ucu
      blendPixelInsideDiamond(buf, px, py - 1, 122, 140, 64, 0.44);
      blendPixelInsideDiamond(buf, px, py - 2, 152, 166, 82, 0.36);
    } else {
      // Çok hafif doğal toprak / yonca beneği
      blendPixelInsideDiamond(buf, px + 1, py, 92, 86, 50, 0.30);
      blendPixelInsideDiamond(buf, px, py - 1, 110, 146, 64, 0.38);
    }
  }
}

function blendPixelInsideDiamond(
  buf: Uint8ClampedArray,
  px: number,
  py: number,
  r: number,
  g: number,
  b: number,
  alpha: number
): void {
  if (px < 0 || px >= GRASS_TILE_WIDTH || py < 0 || py >= GRASS_TILE_HEIGHT) {
    return;
  }

  const a = px - 32 + 2 * py;
  const bCoord = 2 * py - (px - 32);
  if (a < 2 || a >= 62 || bCoord < 2 || bCoord >= 62) {
    return;
  }

  const idx = (py * GRASS_TILE_WIDTH + px) * 4;
  if (buf[idx + 3] === 0) {
    return;
  }

  buf[idx] = Math.round(Phaser.Math.Linear(buf[idx], r, alpha));
  buf[idx + 1] = Math.round(Phaser.Math.Linear(buf[idx + 1], g, alpha));
  buf[idx + 2] = Math.round(Phaser.Math.Linear(buf[idx + 2], b, alpha));
}

/**
 * Tarihî RTS (Age of Empires / Stronghold tarzı Orta Asya bozkır-çayır) renk geçişi.
 */
function mapHistoricalGrassPalette(
  lushness: number,
  dryMix: number
): { r: number; g: number; b: number } {
  let r: number;
  let g: number;
  let b: number;

  if (lushness < 0.36) {
    const k = lushness / 0.36;
    r = Phaser.Math.Linear(46, 67, k);
    g = Phaser.Math.Linear(76, 103, k);
    b = Phaser.Math.Linear(35, 45, k);
  } else if (lushness < 0.70) {
    const k = (lushness - 0.36) / 0.34;
    r = Phaser.Math.Linear(67, 93, k);
    g = Phaser.Math.Linear(103, 130, k);
    b = Phaser.Math.Linear(45, 55, k);
  } else {
    const k = (lushness - 0.70) / 0.30;
    r = Phaser.Math.Linear(93, 122, k);
    g = Phaser.Math.Linear(130, 152, k);
    b = Phaser.Math.Linear(55, 65, k);
  }

  r = Phaser.Math.Linear(r, 122, dryMix);
  g = Phaser.Math.Linear(g, 116, dryMix);
  b = Phaser.Math.Linear(b, 60, dryMix);

  return {
    r: Math.round(Phaser.Math.Clamp(r, 0, 255)),
    g: Math.round(Phaser.Math.Clamp(g, 0, 255)),
    b: Math.round(Phaser.Math.Clamp(b, 0, 255))
  };
}

/**
 * Tam sayı periyotta (period) sarılan kesintisiz 2B değer gürültüsü.
 * x=0 ile x=period ve y=0 ile y=period noktalarında birebir aynı değeri ve türevi üretir.
 */
function periodicValueNoise2D(
  x: number,
  y: number,
  period: number,
  seed: number
): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = quintic(x - ix);
  const fy = quintic(y - iy);

  const wx0 = ((ix % period) + period) % period;
  const wy0 = ((iy % period) + period) % period;
  const wx1 = (wx0 + 1) % period;
  const wy1 = (wy0 + 1) % period;

  const v00 = hash2D(wx0, wy0, seed);
  const v10 = hash2D(wx1, wy0, seed);
  const v01 = hash2D(wx0, wy1, seed);
  const v11 = hash2D(wx1, wy1, seed);

  const nx0 = Phaser.Math.Linear(v00, v10, fx);
  const nx1 = Phaser.Math.Linear(v01, v11, fx);
  return Phaser.Math.Linear(nx0, nx1, fy);
}

export function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = quintic(x - ix);
  const fy = quintic(y - iy);

  const v00 = hash2D(ix, iy, seed);
  const v10 = hash2D(ix + 1, iy, seed);
  const v01 = hash2D(ix, iy + 1, seed);
  const v11 = hash2D(ix + 1, iy + 1, seed);

  const nx0 = Phaser.Math.Linear(v00, v10, fx);
  const nx1 = Phaser.Math.Linear(v01, v11, fx);
  return Phaser.Math.Linear(nx0, nx1, fy);
}

export function fbm2D(
  x: number,
  y: number,
  octaves: number,
  seed: number
): number {
  let total = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    total += valueNoise2D(x * frequency, y * frequency, seed + i * 19) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }

  return total / norm;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Phaser.Math.Clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return quintic(t);
}

function quintic(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function hash2D(ix: number, iy: number, seed: number): number {
  let h =
    Math.imul(ix, 374761393) ^
    Math.imul(iy, 668265263) ^
    Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
