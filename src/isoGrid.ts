/**
 * Karahanlı RTS — İzometrik Çimen Arazi (Tile) Sistemi
 * 2:1 izometrik projeksiyon ve 8×8 karo (tile) düzenini koruyarak,
 * prosedürel çok katmanlı bozkır/çayır çimen dokusunu tek bir Phaser CanvasTexture
 * üzerinde boşluksuz (seamless) ve mobil dostu (tek draw call) olarak üretir.
 */

import Phaser from 'phaser';

export interface IsoGridOptions {
  cols: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  seed?: number;
  showGridLines?: boolean;
}

export class IsoGrid {
  private readonly scene: Phaser.Scene;
  private readonly cols: number;
  private readonly rows: number;
  private readonly tileWidth: number;
  private readonly tileHeight: number;
  private readonly seed: number;
  private readonly showGridLines: boolean;
  private readonly textureKey: string;
  private terrainImage?: Phaser.GameObjects.Image;

  constructor(scene: Phaser.Scene, options: IsoGridOptions) {
    this.scene = scene;
    this.cols = options.cols;
    this.rows = options.rows;
    this.tileWidth = options.tileWidth;
    this.tileHeight = options.tileHeight;
    this.seed = options.seed ?? 1040;
    this.showGridLines = options.showGridLines ?? true;
    this.textureKey = `karahanli-iso-grass-${this.cols}x${this.rows}-${this.seed}`;

    this.draw();
  }

  /**
   * Izgara (col, row) karo merkezini ızgara merkezine göre izometrik ekran koordinatına çevirir.
   */
  public gridToIso(col: number, row: number): { x: number; y: number } {
    const halfW = this.tileWidth / 2;
    const halfH = this.tileHeight / 2;

    const rawX = (col - row) * halfW;
    const rawY = (col + row) * halfH;

    const centerOffsetX = ((this.cols - this.rows) * this.tileWidth) / 4;
    const centerOffsetY = ((this.cols + this.rows - 2) * this.tileHeight) / 4;

    return {
      x: rawX - centerOffsetX,
      y: rawY - centerOffsetY
    };
  }

  /**
   * Sürekli (u, v) harita düzlemi koordinatını ([0..cols], [0..rows]) yerel izometrik koordinata çevirir.
   */
  private planeToLocalIso(u: number, v: number): { x: number; y: number } {
    const topOrigin = this.gridToIso(0, 0);
    const topX = topOrigin.x;
    const topY = topOrigin.y - this.tileHeight / 2;

    const halfW = this.tileWidth / 2;
    const halfH = this.tileHeight / 2;

    return {
      x: topX + (u - v) * halfW,
      y: topY + (u + v) * halfH
    };
  }

  /**
   * 8×8 izometrik çimen arazi dokusunu oluşturur ve sahneye tek bir GPU dokusu olarak ekler.
   */
  public draw(): void {
    const halfW = this.tileWidth / 2;
    const halfH = this.tileHeight / 2;

    const topCorner = this.planeToLocalIso(0, 0);
    const rightCorner = this.planeToLocalIso(this.cols, 0);
    const bottomCorner = this.planeToLocalIso(this.cols, this.rows);
    const leftCorner = this.planeToLocalIso(0, this.rows);

    const pad = 4;
    const skirtDepth = 7;

    const spanLeft = -leftCorner.x;
    const spanRight = rightCorner.x;
    const spanTop = -topCorner.y;
    const spanBottom = bottomCorner.y;

    const logicalWidth = Math.ceil(spanLeft + spanRight + pad * 2);
    const logicalHeight = Math.ceil(spanTop + spanBottom + skirtDepth + pad * 2);

    const originX = pad + spanLeft;
    const originY = pad + spanTop;

    // Mobil ve Retina ekranlar için dengeli çözünürlük (maksimum 2x ile sınırlı)
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const canvasWidth = Math.ceil(logicalWidth * dpr);
    const canvasHeight = Math.ceil(logicalHeight * dpr);

    if (this.scene.textures.exists(this.textureKey)) {
      this.scene.textures.remove(this.textureKey);
    }

    const canvasTexture = this.scene.textures.createCanvas(
      this.textureKey,
      canvasWidth,
      canvasHeight
    );

    if (!canvasTexture) {
      return;
    }

    const ctx = canvasTexture.getContext();

    // 1) Karo bazlı hafif ton varyasyonu tablosu (8×8 karolar arası yumuşak geçiş için)
    const tileTones = this.buildTileToneField();

    // 2) Piksel düzeyinde kesintisiz (boşluksuz) izometrik çimen dokusu sentezi
    const imageData = ctx.createImageData(canvasWidth, canvasHeight);
    const data = imageData.data;

    const topCanvasX = originX + topCorner.x;
    const topCanvasY = originY + topCorner.y;

    // Kenar yumuşatma (anti-aliasing) için ekran pikseli başına (u, v) gradyan büyüklüğü
    const edgeGradPerDevicePx =
      (0.5 * Math.hypot(1 / halfW, 1 / halfH)) / dpr;

    for (let py = 0; py < canvasHeight; py++) {
      const ly = (py + 0.5) / dpr;
      const dy = ly - topCanvasY;

      for (let px = 0; px < canvasWidth; px++) {
        const lx = (px + 0.5) / dpr;
        const dx = lx - topCanvasX;

        // Ters izometrik dönüşüm: ekran pikselinden sürekli karo koordinatına (u, v)
        const u = 0.5 * (dx / halfW + dy / halfH);
        const v = 0.5 * (dy / halfH - dx / halfW);

        const minEdgeUV = Math.min(u, this.cols - u, v, this.rows - v);
        const edgeDistPx = minEdgeUV / edgeGradPerDevicePx;

        if (edgeDistPx <= -0.75) {
          continue;
        }

        const alpha = Phaser.Math.Clamp(edgeDistPx + 0.65, 0, 1);

        const clampedU = Phaser.Math.Clamp(u, 0, this.cols - 0.0001);
        const clampedV = Phaser.Math.Clamp(v, 0, this.rows - 0.0001);

        const color = this.sampleGrassColor(
          clampedU,
          clampedV,
          lx,
          ly,
          tileTones
        );

        const idx = (py * canvasWidth + px) * 4;
        data[idx] = color.r;
        data[idx + 1] = color.g;
        data[idx + 2] = color.b;
        data[idx + 3] = Math.round(alpha * 255);
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // 3) Vektörel katmanlar: ön toprak kesiti (skirt), ince çimen tutamları ve hafif 8×8 karo çizgileri
    ctx.save();
    ctx.scale(dpr, dpr);

    // 3a) Harita ön kenarlarına tarihî RTS tarzı ince toprak/çim kesiti (üst yüzeyin altına çizilir)
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    this.drawTerrainSkirt(
      ctx,
      originX,
      originY,
      leftCorner,
      bottomCorner,
      rightCorner,
      skirtDepth
    );
    ctx.restore();

    // 3b) 8×8 elmas alanının içine kırpılmış doğal mikro çimen yaprakları
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(originX + topCorner.x, originY + topCorner.y);
    ctx.lineTo(originX + rightCorner.x, originY + rightCorner.y);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y);
    ctx.lineTo(originX + leftCorner.x, originY + leftCorner.y);
    ctx.closePath();
    ctx.clip();

    this.drawGrassTufts(ctx, originX, originY);

    if (this.showGridLines) {
      this.drawSubtleTileGrid(ctx, originX, originY);
    }
    ctx.restore();

    // 3c) Dış sınır çizgisini temiz ve net biçimde çerçevele
    ctx.beginPath();
    ctx.moveTo(originX + topCorner.x, originY + topCorner.y);
    ctx.lineTo(originX + rightCorner.x, originY + rightCorner.y);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y);
    ctx.lineTo(originX + leftCorner.x, originY + leftCorner.y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(28, 46, 20, 0.55)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    ctx.restore();
    canvasTexture.refresh();

    if (this.terrainImage) {
      this.terrainImage.setTexture(this.textureKey);
    } else {
      this.terrainImage = this.scene.add.image(0, 0, this.textureKey);
    }

    this.terrainImage.setOrigin(originX / logicalWidth, originY / logicalHeight);
    this.terrainImage.setScale(1 / dpr);
  }

  public setPosition(x: number, y: number): void {
    this.terrainImage?.setPosition(x, y);
  }

  /**
   * Her karonun (8×8) kendine özgü çok hafif doğal ton farkına sahip olması için
   * köşe değerleri tablosu üretir; karolar arası geçişte yumuşak enterpolasyonla birleşir.
   */
  private buildTileToneField(): number[][] {
    const field: number[][] = [];
    for (let r = 0; r <= this.rows; r++) {
      const rowValues: number[] = [];
      for (let c = 0; c <= this.cols; c++) {
        rowValues.push(this.hash2D(c + 13, r + 29, this.seed + 7) * 2 - 1);
      }
      field.push(rowValues);
    }
    return field;
  }

  /**
   * Verilen harita düzlemi noktasında (u, v) çok katmanlı doğal bozkır/çayır çimen rengini hesaplar.
   */
  private sampleGrassColor(
    u: number,
    v: number,
    lx: number,
    ly: number,
    tileTones: number[][]
  ): { r: number; g: number; b: number } {
    // Karo bazlı yumuşak varyasyon (keskin kenar oluşturmadan her karoya hafif karakter verir)
    const col = Math.min(Math.floor(u), this.cols - 1);
    const row = Math.min(Math.floor(v), this.rows - 1);
    const fu = this.quintic(u - col);
    const fv = this.quintic(v - row);

    const t00 = tileTones[row][col];
    const t10 = tileTones[row][col + 1];
    const t01 = tileTones[row + 1][col];
    const t11 = tileTones[row + 1][col + 1];
    const tileTone = Phaser.Math.Linear(
      Phaser.Math.Linear(t00, t10, fu),
      Phaser.Math.Linear(t01, t11, fu),
      fv
    );

    // Çok ölçekli doğal çimen gürültüsü (geniş çayır dalgaları + orta kümeler + ince doku)
    const macro = this.fbm2D(u * 0.72 + 4.1, v * 0.72 + 9.3, 3, this.seed);
    const meso = this.fbm2D(u * 2.85 + 17.4, v * 2.85 + 3.8, 2, this.seed + 31);
    const micro = this.valueNoise2D(u * 9.6 + 5.2, v * 9.6 + 21.7, this.seed + 67);

    // Dikey yönlü hafif çim dokusu (ekran uzayında kısa çim lifleri hissi)
    const bladeGrain = this.valueNoise2D(
      lx * 0.52 + 11.0,
      ly * 0.95 + 6.0,
      this.seed + 101
    );

    // Kuzeybatıdan gelen hafif güneş ışığı için mikro eğim gölgelemesi
    const hSampleA = this.fbm2D((u - 0.09) * 1.45, (v - 0.06) * 1.45, 2, this.seed);
    const hSampleB = this.fbm2D((u + 0.09) * 1.45, (v + 0.06) * 1.45, 2, this.seed);
    const sunSlope = (hSampleA - hSampleB) * 0.35;

    // Bozkır kuru ot / toprak sıcaklığı yamaları
    const steppeDryness = this.fbm2D(
      u * 0.95 + 41.2,
      v * 0.95 + 58.6,
      2,
      this.seed + 149
    );

    let lushness =
      macro * 0.44 +
      meso * 0.27 +
      micro * 0.14 +
      bladeGrain * 0.15 +
      tileTone * 0.07 +
      sunSlope;

    lushness = Phaser.Math.Clamp(lushness, 0, 1);

    // Tarihî RTS atmosferine uygun doğal bozkır/çayır renk paleti
    // Koyu gölgeli çim -> tok orta çimen -> güneş alan zeytin yeşili -> sıcak bozkır çimi
    let r: number;
    let g: number;
    let b: number;

    if (lushness < 0.38) {
      const k = lushness / 0.38;
      r = Phaser.Math.Linear(47, 68, k);
      g = Phaser.Math.Linear(77, 104, k);
      b = Phaser.Math.Linear(37, 47, k);
    } else if (lushness < 0.72) {
      const k = (lushness - 0.38) / 0.34;
      r = Phaser.Math.Linear(68, 94, k);
      g = Phaser.Math.Linear(104, 131, k);
      b = Phaser.Math.Linear(47, 57, k);
    } else {
      const k = (lushness - 0.72) / 0.28;
      r = Phaser.Math.Linear(94, 121, k);
      g = Phaser.Math.Linear(131, 150, k);
      b = Phaser.Math.Linear(57, 66, k);
    }

    // Hafif bozkır sıcaklığı geçişi (doğal sarımsı-toprak alt tonu)
    const dryMix = Phaser.Math.Clamp((steppeDryness - 0.52) * 0.32, 0, 0.13);
    r = Phaser.Math.Linear(r, 118, dryMix);
    g = Phaser.Math.Linear(g, 114, dryMix);
    b = Phaser.Math.Linear(b, 60, dryMix);

    // Harita kenarlarında çok hafif doğal çerçeveleme
    const borderDist = Math.min(u, this.cols - u, v, this.rows - v);
    const edgeShade = Phaser.Math.Clamp(borderDist / 0.45, 0, 1);
    const vignette = 0.93 + 0.07 * edgeShade;

    return {
      r: Math.round(Phaser.Math.Clamp(r * vignette, 0, 255)),
      g: Math.round(Phaser.Math.Clamp(g * vignette, 0, 255)),
      b: Math.round(Phaser.Math.Clamp(b * vignette, 0, 255))
    };
  }

  /**
   * Çimen yüzeyinin üzerinde sade ve doğal duran küçük çim tutamları çizer.
   */
  private drawGrassTufts(
    ctx: CanvasRenderingContext2D,
    originX: number,
    originY: number
  ): void {
    const tuftsPerTile = 7;
    const totalTufts = this.cols * this.rows * tuftsPerTile;

    ctx.lineCap = 'round';

    for (let i = 0; i < totalTufts; i++) {
      const rx = this.hash2D(i, 1, this.seed + 211);
      const ry = this.hash2D(i, 2, this.seed + 223);

      const u = 0.08 + rx * (this.cols - 0.16);
      const v = 0.08 + ry * (this.rows - 0.16);
      const pos = this.planeToLocalIso(u, v);

      const cx = originX + pos.x;
      const cy = originY + pos.y;

      const patchTone = this.fbm2D(u * 0.72 + 4.1, v * 0.72 + 9.3, 2, this.seed);
      const bladeCount = this.hash2D(i, 3, this.seed + 239) > 0.55 ? 3 : 2;

      // Tutam kök gölgesi
      ctx.fillStyle = 'rgba(28, 48, 20, 0.20)';
      ctx.fillRect(cx - 1.2, cy - 0.3, 2.4, 1.1);

      for (let b = 0; b < bladeCount; b++) {
        const offsetX = (b - (bladeCount - 1) * 0.5) * 1.35;
        const lean = (this.hash2D(i * 5 + b, 4, this.seed + 251) - 0.5) * 1.9;
        const bladeH = 2.1 + this.hash2D(i * 5 + b, 5, this.seed + 263) * 2.1;

        ctx.beginPath();
        ctx.moveTo(cx + offsetX, cy);
        ctx.quadraticCurveTo(
          cx + offsetX + lean * 0.45,
          cy - bladeH * 0.55,
          cx + offsetX + lean,
          cy - bladeH
        );

        if (patchTone > 0.54) {
          ctx.strokeStyle = 'rgba(154, 182, 86, 0.34)';
        } else if (patchTone > 0.36) {
          ctx.strokeStyle = 'rgba(118, 152, 68, 0.32)';
        } else {
          ctx.strokeStyle = 'rgba(78, 114, 49, 0.30)';
        }

        ctx.lineWidth = 0.85;
        ctx.stroke();
      }
    }
  }

  /**
   * 8×8 karo yapısını bozmadan çok hafif ve doğal taktiksel karo sınır çizgileri çizer.
   */
  private drawSubtleTileGrid(
    ctx: CanvasRenderingContext2D,
    originX: number,
    originY: number
  ): void {
    ctx.strokeStyle = 'rgba(24, 42, 17, 0.14)';
    ctx.lineWidth = 0.85;

    ctx.beginPath();
    for (let c = 1; c < this.cols; c++) {
      const start = this.planeToLocalIso(c, 0);
      const end = this.planeToLocalIso(c, this.rows);
      ctx.moveTo(originX + start.x, originY + start.y);
      ctx.lineTo(originX + end.x, originY + end.y);
    }

    for (let r = 1; r < this.rows; r++) {
      const start = this.planeToLocalIso(0, r);
      const end = this.planeToLocalIso(this.cols, r);
      ctx.moveTo(originX + start.x, originY + start.y);
      ctx.lineTo(originX + end.x, originY + end.y);
    }
    ctx.stroke();
  }

  /**
   * Haritanın ön iki kenarına tarihî RTS sahnelerine özgü ince toprak kesiti çizer.
   */
  private drawTerrainSkirt(
    ctx: CanvasRenderingContext2D,
    originX: number,
    originY: number,
    leftCorner: { x: number; y: number },
    bottomCorner: { x: number; y: number },
    rightCorner: { x: number; y: number },
    skirtDepth: number
  ): void {
    // Sol-ön kesit (güneş alan toprak yüzeyi)
    ctx.beginPath();
    ctx.moveTo(originX + leftCorner.x, originY + leftCorner.y);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y + skirtDepth);
    ctx.lineTo(originX + leftCorner.x, originY + leftCorner.y + skirtDepth);
    ctx.closePath();
    ctx.fillStyle = '#473927';
    ctx.fill();

    // Sağ-ön kesit (gölgeli toprak yüzeyi)
    ctx.beginPath();
    ctx.moveTo(originX + bottomCorner.x, originY + bottomCorner.y);
    ctx.lineTo(originX + rightCorner.x, originY + rightCorner.y);
    ctx.lineTo(originX + rightCorner.x, originY + rightCorner.y + skirtDepth);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y + skirtDepth);
    ctx.closePath();
    ctx.fillStyle = '#33281b';
    ctx.fill();
  }

  private fbm2D(
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
      total += this.valueNoise2D(x * frequency, y * frequency, seed + i * 19) * amplitude;
      norm += amplitude;
      amplitude *= 0.5;
      frequency *= 2.03;
    }

    return total / norm;
  }

  private valueNoise2D(x: number, y: number, seed: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = this.quintic(x - ix);
    const fy = this.quintic(y - iy);

    const v00 = this.hash2D(ix, iy, seed);
    const v10 = this.hash2D(ix + 1, iy, seed);
    const v01 = this.hash2D(ix, iy + 1, seed);
    const v11 = this.hash2D(ix + 1, iy + 1, seed);

    const nx0 = Phaser.Math.Linear(v00, v10, fx);
    const nx1 = Phaser.Math.Linear(v01, v11, fx);
    return Phaser.Math.Linear(nx0, nx1, fy);
  }

  private quintic(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  private hash2D(ix: number, iy: number, seed: number): number {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
}
