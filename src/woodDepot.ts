/**
 * Karahanlı RTS — Odun Deposu (WoodDepot)
 *
 * Harita üzerinde köylünün kolayca ulaşabileceği sabit bir karoda yer alan,
 * 2:1 izometrik açıya uyumlu sade ahşap sundurma ve tomruk istifi görseline sahip
 * odun deposu. Köylünün topladığı odunlar buraya teslim edildiğinde toplam odun
 * sayacında birikir.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';

export interface WoodDepotConfig {
  col: number;
  row: number;
  initialWood?: number;
}

/** Koruluğun hemen doğusundaki açık çayırda kolay ulaşılabilir sabit depo konumu */
export const DEFAULT_WOOD_DEPOT_CONFIG: WoodDepotConfig = {
  col: 7,
  row: 6,
  initialWood: 0,
};

const DEPOT_TEXTURE_KEY = 'karahanli_wood_depot_v1';
const TEX_W = 136;
const TEX_H = 112;
/** Karonun tam merkezinin doku içindeki piksel karşılığı */
const ANCHOR_X = 68;
const ANCHOR_Y = 78;
/** 2x yüksek çözünürlüklü dokuyu dünya ölçeğinde (~68x56 px) net çizmek için ölçek */
const DISPLAY_SCALE = 0.5;

export class WoodDepot {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly tile: { col: number; row: number };
  private readonly sprite: Phaser.GameObjects.Image;
  private storedWood: number;
  private pulseTween?: Phaser.Tweens.Tween;

  constructor(
    scene: Phaser.Scene,
    isoGrid: IsoGrid,
    config: WoodDepotConfig = DEFAULT_WOOD_DEPOT_CONFIG
  ) {
    this.scene = scene;
    this.isoGrid = isoGrid;
    this.tile = { col: config.col, row: config.row };
    this.storedWood = config.initialWood ?? 0;

    WoodDepot.ensureTexture(scene);

    const worldPos = isoGrid.tileToWorld(this.tile.col, this.tile.row);
    this.sprite = scene.add.image(worldPos.x, worldPos.y, DEPOT_TEXTURE_KEY);
    this.sprite.setOrigin(ANCHOR_X / TEX_W, ANCHOR_Y / TEX_H);
    this.sprite.setScale(DISPLAY_SCALE);
    this.sprite.setDepth(isoGrid.getTileDepth(this.tile.col, this.tile.row));
  }

  /** Depo karosunu döndürür. */
  public getTile(): { col: number; row: number } {
    return { col: this.tile.col, row: this.tile.row };
  }

  /** Deponun dünya piksel koordinatını döndürür. */
  public getWorldPosition(): { x: number; y: number } {
    return this.isoGrid.tileToWorld(this.tile.col, this.tile.row);
  }

  /** Verilen tam sayı (col, row) karosunun depoya ait olup olmadığını kontrol eder. */
  public occupiesTile(col: number, row: number): boolean {
    return col === this.tile.col && row === this.tile.row;
  }

  /** Depoda biriken toplam odun miktarını döndürür. */
  public getStoredWood(): number {
    return this.storedWood;
  }

  /**
   * Köylünün getirdiği odunu depoya ekler ve hafif bir teslim animasyonu oynatır.
   */
  public depositWood(amount: number): number {
    if (amount <= 0) {
      return this.storedWood;
    }

    this.storedWood += amount;
    this.playDepositPulse();
    return this.storedWood;
  }

  /**
   * Dünya koordinatındaki (worldX, worldY) tıklama/dokunmanın depo üzerine
   * isabet edip etmediğini kontrol eder.
   */
  public containsWorldPoint(
    worldX: number,
    worldY: number,
    isTouch = false
  ): boolean {
    const pos = this.getWorldPosition();
    const pad = isTouch ? 10 : 4;
    const dx = worldX - pos.x;
    const dy = worldY - pos.y;

    return (
      Math.abs(dx) <= 28 + pad &&
      dy >= -34 - pad &&
      dy <= 15 + pad
    );
  }

  /** Sabit arayüz (HUD) kamerasının depo görselini çizmemesini sağlar. */
  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore(this.sprite);
  }

  /** Harita taşınırsa depo konumunu ve derinliğini günceller. */
  public syncPosition(): void {
    const pos = this.getWorldPosition();
    this.sprite.setPosition(pos.x, pos.y);
    this.sprite.setDepth(this.isoGrid.getTileDepth(this.tile.col, this.tile.row));
  }

  public destroy(): void {
    this.pulseTween?.stop();
    this.sprite.destroy();
  }

  private playDepositPulse(): void {
    this.pulseTween?.stop();
    this.sprite.setScale(DISPLAY_SCALE);

    this.pulseTween = this.scene.tweens.add({
      targets: this.sprite,
      scaleX: DISPLAY_SCALE * 1.06,
      scaleY: DISPLAY_SCALE * 1.06,
      duration: 90,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (this.sprite.active) {
          this.sprite.setScale(DISPLAY_SCALE);
        }
      },
    });
  }

  /**
   * 2:1 izometrik açıyla tam uyumlu, sade ve tarihî dokuya uygun ahşap odun deposu
   * (kalas platform + sundurma çatısı + istiflenmiş tomruklar) dokusunu üretir.
   */
  private static ensureTexture(scene: Phaser.Scene): void {
    if (scene.textures.exists(DEPOT_TEXTURE_KEY)) {
      return;
    }

    const canvasTex = scene.textures.createCanvas(
      DEPOT_TEXTURE_KEY,
      TEX_W,
      TEX_H
    );
    if (!canvasTex) {
      return;
    }

    const ctx = canvasTex.getContext();
    ctx.clearRect(0, 0, TEX_W, TEX_H);

    const cx = ANCHOR_X;
    const cy = ANCHOR_Y;

    // 1) Hafif doğal temas gölgesi (2:1 elmas taban altında)
    ctx.save();
    ctx.fillStyle = 'rgba(14, 24, 10, 0.28)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 28);
    ctx.lineTo(cx + 58, cy + 1);
    ctx.lineTo(cx, cy + 30);
    ctx.lineTo(cx - 58, cy + 1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 2) İzometrik ahşap platform tabanı (52x26 yarıçap -> 104x52 doku px = 52x26 dünya px)
    const hw = 52;
    const hh = 26;
    const deckH = 6; // platform kalınlığı

    const pTop = { x: cx, y: cy - hh - deckH };
    const pRight = { x: cx + hw, y: cy - deckH };
    const pBot = { x: cx, y: cy + hh - deckH };
    const pLeft = { x: cx - hw, y: cy - deckH };

    // Sol-ön yan kiriş (güneş alan sıcak ahşap)
    ctx.fillStyle = '#7c5329';
    ctx.beginPath();
    ctx.moveTo(pLeft.x, pLeft.y);
    ctx.lineTo(pBot.x, pBot.y);
    ctx.lineTo(pBot.x, pBot.y + deckH);
    ctx.lineTo(pLeft.x, pLeft.y + deckH);
    ctx.closePath();
    ctx.fill();

    // Sağ-ön yan kiriş (gölgeli koyu ahşap)
    ctx.fillStyle = '#56381a';
    ctx.beginPath();
    ctx.moveTo(pBot.x, pBot.y);
    ctx.lineTo(pRight.x, pRight.y);
    ctx.lineTo(pRight.x, pRight.y + deckH);
    ctx.lineTo(pBot.x, pBot.y + deckH);
    ctx.closePath();
    ctx.fill();

    // Üst kalas döşeme yüzeyi
    ctx.fillStyle = '#9c6f3e';
    ctx.beginPath();
    ctx.moveTo(pTop.x, pTop.y);
    ctx.lineTo(pRight.x, pRight.y);
    ctx.lineTo(pBot.x, pBot.y);
    ctx.lineTo(pLeft.x, pLeft.y);
    ctx.closePath();
    ctx.fill();

    // Kalas derz çizgileri (izometrik sol-üst -> sağ-alt yönünde)
    ctx.strokeStyle = 'rgba(58, 36, 16, 0.42)';
    ctx.lineWidth = 1.2;
    for (let i = 1; i < 6; i++) {
      const t = i / 6;
      const sx = pTop.x + (pLeft.x - pTop.x) * t;
      const sy = pTop.y + (pLeft.y - pTop.y) * t;
      const ex = pRight.x + (pBot.x - pRight.x) * t;
      const ey = pRight.y + (pBot.y - pRight.y) * t;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }

    ctx.strokeStyle = '#3d2711';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(pTop.x, pTop.y);
    ctx.lineTo(pRight.x, pRight.y);
    ctx.lineTo(pBot.x, pBot.y);
    ctx.lineTo(pLeft.x, pLeft.y);
    ctx.closePath();
    ctx.stroke();

    // 3) Sağ-ön yarıda istiflenmiş kesilmiş kütükler (6 adet piramit dizilim)
    const drawIsoLog = (lx: number, ly: number): void => {
      // Kütük ekseni sol-üstten sağ-alta (-14, -7) -> (+10, +5) uzanır
      const x0 = lx - 13;
      const y0 = ly - 6.5;
      const x1 = lx + 11;
      const y1 = ly + 5.5;
      const r = 5.2;

      // Kütük gövdesi (kabuk)
      ctx.fillStyle = '#6b4421';
      ctx.strokeStyle = '#38210d';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(x0, y0 - r);
      ctx.lineTo(x1, y1 - r);
      ctx.lineTo(x1, y1 + r);
      ctx.lineTo(x0, y0 + r);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // Üst kabuk ışık şeridi
      ctx.strokeStyle = '#8b5c31';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x0 + 1, y0 - r + 1.6);
      ctx.lineTo(x1 - 1, y1 - r + 1.6);
      ctx.stroke();

      // Sağ-alt kesim yüzeyi (açık sarımsı ahşap halkası)
      ctx.fillStyle = '#d8aa6c';
      ctx.strokeStyle = '#4a2e14';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(x1, y1, 3.6, 5.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // İç yaş halkası noktası
      ctx.fillStyle = '#9c6b36';
      ctx.beginPath();
      ctx.arc(x1, y1, 1.4, 0, Math.PI * 2);
      ctx.fill();
    };

    // Alt sıra (3 kütük, arkadan öne)
    drawIsoLog(cx + 18, cy - 11);
    drawIsoLog(cx + 10, cy - 7);
    drawIsoLog(cx + 2, cy - 3);
    // Orta sıra (2 kütük)
    drawIsoLog(cx + 14, cy - 17);
    drawIsoLog(cx + 6, cy - 13);
    // Üst sıra (1 kütük)
    drawIsoLog(cx + 10, cy - 23);

    // 4) Sol-arka kısımda açık ahşap sundurma (4 dikme + eğimli kalas çatı)
    const drawPost = (px: number, py: number, postH: number): void => {
      ctx.fillStyle = '#5e3c1b';
      ctx.fillRect(px - 2.5, py - postH, 5, postH);
      ctx.fillStyle = '#85582d';
      ctx.fillRect(px - 2.5, py - postH, 2.5, postH);
      ctx.strokeStyle = '#331e0b';
      ctx.lineWidth = 1;
      ctx.strokeRect(px - 2.5, py - postH, 5, postH);
    };

    // Arka dikmeler (daha yüksek) ve ön dikmeler (hafif eğimli sundurma)
    const postBackTop = { x: cx - 4, y: cy - 24 };
    const postBackLeft = { x: cx - 38, y: cy - 7 };
    const postFrontMid = { x: cx + 10, y: cy - 15 };
    const postFrontLeft = { x: cx - 24, y: cy + 2 };

    drawPost(postBackTop.x, postBackTop.y, 38);
    drawPost(postBackLeft.x, postBackLeft.y, 38);
    drawPost(postFrontMid.x, postFrontMid.y, 31);
    drawPost(postFrontLeft.x, postFrontLeft.y, 31);

    // Sundurma çatısı köşe noktaları
    const rTop = { x: postBackTop.x - 2, y: postBackTop.y - 40 };
    const rLeft = { x: postBackLeft.x - 4, y: postBackLeft.y - 40 };
    const rBottom = { x: postFrontLeft.x + 2, y: postFrontLeft.y - 31 };
    const rRight = { x: postFrontMid.x + 4, y: postFrontMid.y - 31 };

    // Çatı alt gölge kalınlığı
    ctx.fillStyle = '#472d14';
    ctx.beginPath();
    ctx.moveTo(rLeft.x, rLeft.y + 3);
    ctx.lineTo(rBottom.x, rBottom.y + 3);
    ctx.lineTo(rRight.x, rRight.y + 3);
    ctx.lineTo(rRight.x, rRight.y);
    ctx.lineTo(rBottom.x, rBottom.y);
    ctx.lineTo(rLeft.x, rLeft.y);
    ctx.closePath();
    ctx.fill();

    // Çatı üst kalas yüzeyi (güneş ışığı alan sıcak ahşap)
    const roofGrad = ctx.createLinearGradient(rTop.x, rTop.y, rBottom.x, rBottom.y);
    roofGrad.addColorStop(0, '#b5834a');
    roofGrad.addColorStop(1, '#8c5f2f');
    ctx.fillStyle = roofGrad;
    ctx.beginPath();
    ctx.moveTo(rTop.x, rTop.y);
    ctx.lineTo(rRight.x, rRight.y);
    ctx.lineTo(rBottom.x, rBottom.y);
    ctx.lineTo(rLeft.x, rLeft.y);
    ctx.closePath();
    ctx.fill();

    // Çatı kalas çizgileri
    ctx.strokeStyle = 'rgba(56, 34, 14, 0.48)';
    ctx.lineWidth = 1.1;
    for (let i = 1; i < 5; i++) {
      const t = i / 5;
      const sx = rTop.x + (rLeft.x - rTop.x) * t;
      const sy = rTop.y + (rLeft.y - rTop.y) * t;
      const ex = rRight.x + (rBottom.x - rRight.x) * t;
      const ey = rRight.y + (rBottom.y - rRight.y) * t;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    }

    ctx.strokeStyle = '#3b2410';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(rTop.x, rTop.y);
    ctx.lineTo(rRight.x, rRight.y);
    ctx.lineTo(rBottom.x, rBottom.y);
    ctx.lineTo(rLeft.x, rLeft.y);
    ctx.closePath();
    ctx.stroke();

    canvasTex.refresh();
  }
}
