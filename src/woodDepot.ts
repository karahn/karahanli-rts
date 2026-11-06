/**
 * Karahanlı RTS — Odun Deposu (WoodDepot)
 *
 * Harita üzerinde koruluk ile Town Hall arasındaki açık meydanda yer alan,
 * Town Hall'un mimari diline uyumlu kızıl tuğla/taş temelli, oyma ahşap direkli,
 * ahşap kiremit çatılı ve istiflenmiş gerçekçi kütük yığınlarına sahip izometrik
 * odun deposu. Köylülerin topladığı odunlar buraya teslim edildiğinde yerleşimin
 * toplam odun sayacında birikir.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';

export const WOOD_DEPOT_TEXTURE_KEY = 'wood_depot_karahanli';
export const WOOD_DEPOT_ASSET_PATH = 'assets/sprites/wood_depot_karahanli.png';

export interface WoodDepotConfig {
  col: number;
  row: number;
  initialWood?: number;
}

/** Koruluğun hemen doğusunda, Town Hall meydanıyla uyumlu açık depo konumu */
export const DEFAULT_WOOD_DEPOT_CONFIG: WoodDepotConfig = {
  col: 6,
  row: 5,
  initialWood: 0,
};

const TEX_W = 174;
const TEX_H = 136;
/** Taş/tuğla temel kaidesinin izometrik merkezinin doku içindeki piksel karşılığı */
const ORIGIN_X = 87.01 / TEX_W;
const ORIGIN_Y = 88.19 / TEX_H;
/** 2x yüksek çözünürlüklü dokuyu dünya ölçeğinde (~83.5x65 px) net çizmek için ölçek */
const DISPLAY_SCALE = 0.48;

export class WoodDepot {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly tile: { col: number; row: number };
  private readonly shadowGraphics: Phaser.GameObjects.Graphics;
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

    const worldPos = isoGrid.tileToWorld(this.tile.col, this.tile.row);

    this.shadowGraphics = scene.add.graphics();
    this.drawGroundContactShadow();
    this.shadowGraphics.setPosition(worldPos.x, worldPos.y);
    this.shadowGraphics.setDepth(1.5);

    this.sprite = scene.add.image(worldPos.x, worldPos.y, WOOD_DEPOT_TEXTURE_KEY);
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(DISPLAY_SCALE);
    this.sprite.setDepth(isoGrid.getTileDepth(this.tile.col, this.tile.row));
  }

  /** Odun deposu görselini sahne yüklemesinde belleğe alır. */
  public static preload(scene: Phaser.Scene): void {
    scene.load.image(WOOD_DEPOT_TEXTURE_KEY, WOOD_DEPOT_ASSET_PATH);
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

  /** Depoda belirtilen miktarda harcanabilir odun olup olmadığını döndürür. */
  public canAffordWood(amount: number): boolean {
    return amount >= 0 && this.storedWood >= amount;
  }

  /**
   * Üretim, inşaat veya araştırma için depodan odun harcar.
   * Yeterli odun yoksa false döndürür ve mevcut miktarı değiştirmez.
   */
  public spendWood(amount: number): boolean {
    if (amount <= 0) {
      return true;
    }
    if (this.storedWood < amount) {
      return false;
    }
    this.storedWood -= amount;
    return true;
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

    const baseHit =
      Math.abs(dx) / (43 + pad) + Math.abs(dy - 1) / (22 + pad) <= 1.0;
    if (baseHit) {
      return true;
    }

    return (
      Math.abs(dx) <= 36 + pad &&
      dy >= -42 - pad &&
      dy <= 18 + pad
    );
  }

  /** Sabit arayüz (HUD) kamerasının depo görselini çizmemesini sağlar. */
  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore([this.shadowGraphics, this.sprite]);
  }

  /** Harita taşınırsa depo konumunu ve derinliğini günceller. */
  public syncPosition(): void {
    const pos = this.getWorldPosition();
    this.shadowGraphics.setPosition(pos.x, pos.y);
    this.sprite.setPosition(pos.x, pos.y);
    this.sprite.setDepth(this.isoGrid.getTileDepth(this.tile.col, this.tile.row));
  }

  public destroy(): void {
    this.pulseTween?.stop();
    this.shadowGraphics.destroy();
    this.sprite.destroy();
  }

  private playDepositPulse(): void {
    this.pulseTween?.stop();
    this.sprite.setScale(DISPLAY_SCALE);

    this.pulseTween = this.scene.tweens.add({
      targets: this.sprite,
      scaleX: DISPLAY_SCALE * 1.045,
      scaleY: DISPLAY_SCALE * 1.045,
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

  private drawGroundContactShadow(): void {
    this.shadowGraphics.clear();
    const hw = 43;
    const hh = 22;

    this.shadowGraphics.fillStyle(0x0d190a, 0.24);
    this.shadowGraphics.beginPath();
    this.shadowGraphics.moveTo(0, -hh + 1);
    this.shadowGraphics.lineTo(hw, 2);
    this.shadowGraphics.lineTo(0, hh + 3);
    this.shadowGraphics.lineTo(-hw, 2);
    this.shadowGraphics.closePath();
    this.shadowGraphics.fillPath();
  }
}
