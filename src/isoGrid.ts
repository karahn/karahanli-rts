/**
 * Karahanlı RTS — İzometrik Çimen Arazi (Tile) Sistemi
 * 64×32 piksel kesintisiz (seamless) izometrik çimen karosu dokularını kullanarak
 * 8×8 haritayı boşluksuz, tekrarlayan desenlerden arındırılmış ve mobil uyumlu
 * (tek WebGL draw call) biçimde oluşturur.
 */

import Phaser from 'phaser';
import {
  ensureGrassTileAtlas,
  fbm2D,
  GRASS_TILE_HEIGHT,
  GRASS_TILE_WIDTH,
  hash2D
} from './grassTexture';

export interface IsoGridOptions {
  cols: number;
  rows: number;
  tileWidth?: number;
  tileHeight?: number;
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
  private readonly mapTextureKey: string;
  private terrainImage?: Phaser.GameObjects.Image;
  private mapX = 0;
  private mapY = 0;

  constructor(scene: Phaser.Scene, options: IsoGridOptions) {
    this.scene = scene;
    this.cols = options.cols;
    this.rows = options.rows;
    this.tileWidth = options.tileWidth ?? GRASS_TILE_WIDTH;
    this.tileHeight = options.tileHeight ?? GRASS_TILE_HEIGHT;
    this.seed = options.seed ?? 1071;
    this.showGridLines = options.showGridLines ?? true;
    this.mapTextureKey = `karahanli-iso-map-${this.cols}x${this.rows}-${this.tileWidth}x${this.tileHeight}-s${this.seed}`;

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
   * 64×32 çimen dokusu atlasını üretir, komşu tekrarını önleyen varyant matrisiyle
   * 8×8 haritanın tamamına uygular ve tek bir GPU dokusu olarak sahneye yerleştirir.
   */
  public draw(): void {
    const atlas = ensureGrassTileAtlas(this.scene, this.seed);

    const halfW = this.tileWidth / 2;
    const halfH = this.tileHeight / 2;

    const topCorner = this.planeToLocalIso(0, 0);
    const rightCorner = this.planeToLocalIso(this.cols, 0);
    const bottomCorner = this.planeToLocalIso(this.cols, this.rows);
    const leftCorner = this.planeToLocalIso(0, this.rows);

    const pad = 4;
    const skirtDepth = 6;

    const spanLeft = -leftCorner.x;
    const spanRight = rightCorner.x;
    const spanTop = -topCorner.y;
    const spanBottom = bottomCorner.y;

    const canvasWidth = Math.ceil(spanLeft + spanRight + pad * 2);
    const canvasHeight = Math.ceil(spanTop + spanBottom + skirtDepth + pad * 2);

    const originX = Math.round(pad + spanLeft);
    const originY = Math.round(pad + spanTop);

    if (this.scene.textures.exists(this.mapTextureKey)) {
      this.scene.textures.remove(this.mapTextureKey);
    }

    const mapCanvas = this.scene.textures.createCanvas(
      this.mapTextureKey,
      canvasWidth,
      canvasHeight
    );

    if (!mapCanvas) {
      return;
    }

    const ctx = mapCanvas.getContext();
    const imageData = ctx.createImageData(canvasWidth, canvasHeight);
    const out = imageData.data;

    // 1) Tekrarlayan desenleri önlemek için komşu karoların aynı varyantı kullanmadığı 8×8 varyant tablosu
    const variantGrid = this.buildNonRepeatingVariantGrid(atlas.variantCount);

    // 2) Her bir 8×8 karoya karşılık gelen 64×32 piksel çimen dokusunu tam sayı kafes koordinatlarına yerleştir
    const topApexX = Math.round(originX + topCorner.x);
    const topApexY = Math.round(originY + topCorner.y);

    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        const variantIdx = variantGrid[row][col];
        const tilePixels = atlas.variants[variantIdx];

        // 64×32 karonun sol-üst çerçeve başlangıç koordinatı
        const tileLeft = topApexX + (col - row) * halfW - halfW;
        const tileTop = topApexY + (col + row) * halfH;

        for (let ty = 0; ty < GRASS_TILE_HEIGHT; ty++) {
          const dstY = tileTop + ty;
          if (dstY < 0 || dstY >= canvasHeight) {
            continue;
          }

          for (let tx = 0; tx < GRASS_TILE_WIDTH; tx++) {
            const srcIdx = (ty * GRASS_TILE_WIDTH + tx) * 4;
            if (tilePixels[srcIdx + 3] === 0) {
              continue;
            }

            const dstX = tileLeft + tx;
            if (dstX < 0 || dstX >= canvasWidth) {
              continue;
            }

            const dstIdx = (dstY * canvasWidth + dstX) * 4;
            out[dstIdx] = tilePixels[srcIdx];
            out[dstIdx + 1] = tilePixels[srcIdx + 1];
            out[dstIdx + 2] = tilePixels[srcIdx + 2];
            out[dstIdx + 3] = 255;
          }
        }
      }
    }

    // 3) Harita genelinde doğal çayır ışığı / bozkır ton geçişi (yapay karo tekrarını tamamen kırar)
    this.applyWorldMeadowAtmosphere(
      out,
      canvasWidth,
      canvasHeight,
      topApexX,
      topApexY,
      halfW,
      halfH
    );

    ctx.putImageData(imageData, 0, 0);

    // 4) Ön kenar toprak kesiti (skirt), hafif 8×8 taktik ızgara izi ve dış sınır yumuşatması
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

    if (this.showGridLines) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(originX + topCorner.x, originY + topCorner.y);
      ctx.lineTo(originX + rightCorner.x, originY + rightCorner.y);
      ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y);
      ctx.lineTo(originX + leftCorner.x, originY + leftCorner.y);
      ctx.closePath();
      ctx.clip();

      this.drawSubtleTileGrid(ctx, originX, originY);
      ctx.restore();
    }

    // Dış elmas sınırına temiz tarihî RTS çerçeve çizgisi
    ctx.beginPath();
    ctx.moveTo(originX + topCorner.x, originY + topCorner.y);
    ctx.lineTo(originX + rightCorner.x, originY + rightCorner.y);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y);
    ctx.lineTo(originX + leftCorner.x, originY + leftCorner.y);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(26, 44, 18, 0.52)';
    ctx.lineWidth = 1;
    ctx.stroke();

    mapCanvas.refresh();

    if (this.terrainImage) {
      this.terrainImage.setTexture(this.mapTextureKey);
    } else {
      this.terrainImage = this.scene.add.image(0, 0, this.mapTextureKey);
    }

    this.terrainImage.setOrigin(originX / canvasWidth, originY / canvasHeight);
    this.terrainImage.setDepth(0);
  }

  public setPosition(x: number, y: number): void {
    this.mapX = Math.round(x);
    this.mapY = Math.round(y);
    this.terrainImage?.setPosition(this.mapX, this.mapY);
  }

  /**
   * Verilen (col, row) karosunun sahnedeki (dünya/ekran) tam merkez koordinatını döndürür.
   */
  public tileToWorld(col: number, row: number): { x: number; y: number } {
    const local = this.gridToIso(col, row);
    return {
      x: Math.round(this.mapX + local.x),
      y: Math.round(this.mapY + local.y)
    };
  }

  /**
   * İzometrik derinlik sıralaması (depth sorting) değerini hesaplar.
   * Zemin depth=0'da kalır; güneydeki (ekranda daha aşağıda bulunan) nesneler önde çizilir.
   */
  public getTileDepth(col: number, row: number, zOffset = 0): number {
    const local = this.gridToIso(col, row);
    return 1000 + local.y + col * 0.01 + zOffset;
  }

  /**
   * Yatay, dikey ve çapraz komşu karoların aynı 64×32 dokuyu tekrar kullanmasını engelleyen seçici.
   */
  private buildNonRepeatingVariantGrid(variantCount: number): number[][] {
    const grid: number[][] = [];

    for (let r = 0; r < this.rows; r++) {
      const rowArr: number[] = [];
      for (let c = 0; c < this.cols; c++) {
        const forbidden = new Set<number>();
        if (c > 0) {
          forbidden.add(rowArr[c - 1]);
        }
        if (r > 0) {
          forbidden.add(grid[r - 1][c]);
          if (c > 0) {
            forbidden.add(grid[r - 1][c - 1]);
          }
          if (c + 1 < this.cols) {
            forbidden.add(grid[r - 1][c + 1]);
          }
        }

        const startPick = Math.floor(
          hash2D(c + 17, r + 31, this.seed + 509) * variantCount
        );
        let chosen = startPick;
        for (let step = 0; step < variantCount; step++) {
          const candidate = (startPick + step * 3) % variantCount;
          if (!forbidden.has(candidate)) {
            chosen = candidate;
            break;
          }
        }

        rowArr.push(chosen);
      }
      grid.push(rowArr);
    }

    return grid;
  }

  /**
   * 64×32 karoların kesintisiz birleştiği yüzey üzerine harita ölçeğinde hafif güneş/gölge
   * ve bozkır ton geçişleri uygular; böylece 8×8 haritada yapay tekrar hissi oluşmaz.
   */
  private applyWorldMeadowAtmosphere(
    out: Uint8ClampedArray,
    canvasWidth: number,
    canvasHeight: number,
    topApexX: number,
    topApexY: number,
    halfW: number,
    halfH: number
  ): void {
    const edgeGrad = 0.5 * Math.hypot(1 / halfW, 1 / halfH);

    for (let py = 0; py < canvasHeight; py++) {
      const dy = py + 0.5 - topApexY;

      for (let px = 0; px < canvasWidth; px++) {
        const idx = (py * canvasWidth + px) * 4;
        if (out[idx + 3] === 0) {
          continue;
        }

        const dx = px + 0.5 - topApexX;
        const u = 0.5 * (dx / halfW + dy / halfH);
        const v = 0.5 * (dy / halfH - dx / halfW);

        // Geniş ölçekli güneşli çayır açıklıkları ve gölgeli çukurlar
        const meadowWave = fbm2D(u * 0.48 + 3.7, v * 0.48 + 8.1, 2, this.seed + 701);
        const sunSlope =
          (fbm2D((u - 0.12) * 0.85, (v - 0.08) * 0.85, 2, this.seed + 739) -
            fbm2D((u + 0.12) * 0.85, (v + 0.08) * 0.85, 2, this.seed + 739)) *
          0.28;
        const warmZone = fbm2D(u * 0.62 + 21.5, v * 0.62 + 14.2, 2, this.seed + 787);

        const lightFactor = 0.90 + meadowWave * 0.19 + sunSlope;

        // Dış kenarlarda yumuşak çerçeveleme ve kenar anti-aliasing
        const borderUV = Math.min(u, this.cols - u, v, this.rows - v);
        const vignette = 0.94 + 0.06 * Phaser.Math.Clamp(borderUV / 0.5, 0, 1);
        const edgeAlpha = Phaser.Math.Clamp(borderUV / edgeGrad + 0.75, 0, 1);

        let r = out[idx] * lightFactor * vignette;
        let g = out[idx + 1] * lightFactor * vignette;
        let b = out[idx + 2] * lightFactor * vignette;

        // Hafif bozkır güneşi sıcaklığı
        const warmShift = Phaser.Math.Clamp((warmZone - 0.52) * 0.22, 0, 0.09);
        r = Phaser.Math.Linear(r, 126, warmShift);
        g = Phaser.Math.Linear(g, 120, warmShift);
        b = Phaser.Math.Linear(b, 62, warmShift);

        out[idx] = Math.round(Phaser.Math.Clamp(r, 0, 255));
        out[idx + 1] = Math.round(Phaser.Math.Clamp(g, 0, 255));
        out[idx + 2] = Math.round(Phaser.Math.Clamp(b, 0, 255));
        out[idx + 3] = Math.round(edgeAlpha * 255);
      }
    }
  }

  private drawSubtleTileGrid(
    ctx: CanvasRenderingContext2D,
    originX: number,
    originY: number
  ): void {
    ctx.strokeStyle = 'rgba(22, 38, 15, 0.10)';
    ctx.lineWidth = 0.75;

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

  private drawTerrainSkirt(
    ctx: CanvasRenderingContext2D,
    originX: number,
    originY: number,
    leftCorner: { x: number; y: number },
    bottomCorner: { x: number; y: number },
    rightCorner: { x: number; y: number },
    skirtDepth: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(originX + leftCorner.x, originY + leftCorner.y);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y + skirtDepth);
    ctx.lineTo(originX + leftCorner.x, originY + leftCorner.y + skirtDepth);
    ctx.closePath();
    ctx.fillStyle = '#473927';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(originX + bottomCorner.x, originY + bottomCorner.y);
    ctx.lineTo(originX + rightCorner.x, originY + rightCorner.y);
    ctx.lineTo(originX + rightCorner.x, originY + rightCorner.y + skirtDepth);
    ctx.lineTo(originX + bottomCorner.x, originY + bottomCorner.y + skirtDepth);
    ctx.closePath();
    ctx.fillStyle = '#312619';
    ctx.fill();
  }
}
