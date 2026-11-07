/**
 * Karahanlı RTS — Karahanlı Kışlası (Askerî Yapı)
 *
 * Karahanlı yerleşiminin güneybatısında, Hükümdar Konağı'nın batısında yer alan,
 * kızıl tuğla ve kaba yontulmuş taş temel üzerine kerpiç dolgulu ahşap karkasla
 * inşa edilmiş, kirpi saçaklı ahşap kiremit çatılı ve tunç kurt totemli büyük
 * kemerli kapısı bulunan 3x2 karoluk askerî kışla:
 * - Town Hall ile aynı izometrik izdüşüm, ölçek ve çizim kalitesindedir
 * - Haritaya doğal yerleşim düzeninde (koruluğun güneyi, konağın batısı) konumlanır
 * - Seçildiğinde alt bilgi panelinde bina adı, alt başlığı ve can değeri gösterilir
 * - Birimler için engel teşkil eder; köylüler çevresinden dolaşarak geçer
 *
 * NOT: Bu aşamada asker üretimi ve savaş sistemi bulunmamaktadır.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';

export const BARRACKS_TEXTURE_KEY = 'barracks_karahanli';
export const BARRACKS_ASSET_PATH = 'assets/sprites/barracks_karahanli.png';

const TEX_WIDTH = 322;
const TEX_HEIGHT = 251;
/**
 * Dokunun izometrik taban elmasının merkezine karşılık gelen orijin.
 * Town Hall dokusunda kullanılan yöntemin aynısıyla, taban elmasının
 * alt-sol / alt-sağ kenarları ölçülerek hesaplanmıştır.
 */
const ORIGIN_X = 0.50155;
const ORIGIN_Y = 0.66534;
/** 2x retina dokuyu dünya uzayında tam 3x2 karo elmasına oturtan ölçek */
const DISPLAY_SCALE = 0.5;

/** 3x2 karo ayak izinin dünya uzayındaki elmas yarı genişliği / yarı yüksekliği */
const FOOTPRINT_HALF_WIDTH = 80;
const FOOTPRINT_HALF_HEIGHT = 41.5;

export interface BarracksConfig {
  id?: string;
  originCol: number;
  originRow: number;
  footprintCols?: number;
  footprintRows?: number;
  maxHp?: number;
}

export interface BarracksHudSnapshot {
  id: string;
  buildingName: string;
  buildingSubtitle: string;
  selected: boolean;
  hp: number;
  maxHp: number;
}

/** Koruluğun güneyinde, Hükümdar Konağı'nın batısında kalan açık askerî meydan */
export const DEFAULT_BARRACKS_CONFIG: BarracksConfig = {
  id: 'barracks_main',
  originCol: 6,
  originRow: 10,
  footprintCols: 3,
  footprintRows: 2,
  maxHp: 800,
};

export class Barracks {
  public readonly id: string;
  public readonly buildingName = 'Kışla';
  public readonly buildingSubtitle = 'Karahanlı Kışlası';

  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly originCol: number;
  private readonly originRow: number;
  private readonly footprintCols: number;
  private readonly footprintRows: number;

  private hp: number;
  private readonly maxHp: number;

  private readonly shadowGraphics: Phaser.GameObjects.Graphics;
  private readonly selectionGraphics: Phaser.GameObjects.Graphics;
  private readonly sprite: Phaser.GameObjects.Image;

  private selected = false;
  private pulseTween?: Phaser.Tweens.Tween;

  constructor(
    scene: Phaser.Scene,
    isoGrid: IsoGrid,
    config: BarracksConfig = DEFAULT_BARRACKS_CONFIG
  ) {
    this.id = config.id ?? 'barracks_main';
    this.scene = scene;
    this.isoGrid = isoGrid;
    this.originCol = config.originCol;
    this.originRow = config.originRow;
    this.footprintCols = config.footprintCols ?? 3;
    this.footprintRows = config.footprintRows ?? 2;
    this.maxHp = config.maxHp ?? 800;
    this.hp = this.maxHp;

    const centerTile = this.getCenterTile();
    const worldPos = isoGrid.tileToWorld(centerTile.col, centerTile.row);
    const sortDepth = isoGrid.getTileDepth(
      centerTile.col + 0.1,
      centerTile.row + 0.1
    );

    this.shadowGraphics = scene.add.graphics();
    this.drawGroundContactShadow();
    this.shadowGraphics.setPosition(worldPos.x, worldPos.y);
    this.shadowGraphics.setDepth(1.5);

    this.selectionGraphics = scene.add.graphics();
    this.drawSelectionDiamond();
    this.selectionGraphics.setPosition(worldPos.x, worldPos.y);
    this.selectionGraphics.setDepth(2.2);
    this.selectionGraphics.setVisible(false);

    this.sprite = scene.add.image(
      worldPos.x,
      worldPos.y,
      BARRACKS_TEXTURE_KEY
    );
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(DISPLAY_SCALE);
    this.sprite.setDepth(sortDepth);
  }

  public static preload(scene: Phaser.Scene): void {
    scene.load.image(BARRACKS_TEXTURE_KEY, BARRACKS_ASSET_PATH);
  }

  public setSelected(value: boolean): void {
    if (this.selected === value) {
      return;
    }
    this.selected = value;
    this.selectionGraphics.setVisible(value);
  }

  public isSelected(): boolean {
    return this.selected;
  }

  public getCenterTile(): GridCoord {
    return {
      col: this.originCol + (this.footprintCols - 1) * 0.5,
      row: this.originRow + (this.footprintRows - 1) * 0.5,
    };
  }

  public getWorldPosition(): { x: number; y: number } {
    const center = this.getCenterTile();
    return this.isoGrid.tileToWorld(center.col, center.row);
  }

  public occupiesTile(col: number, row: number): boolean {
    return (
      col >= this.originCol &&
      col < this.originCol + this.footprintCols &&
      row >= this.originRow &&
      row < this.originRow + this.footprintRows
    );
  }

  public containsWorldPoint(
    worldX: number,
    worldY: number,
    isTouch = false
  ): boolean {
    const center = this.getWorldPosition();
    const pad = isTouch ? 10 : 4;
    const dx = worldX - center.x;
    const dy = worldY - center.y;

    // 1) 3x2 izometrik taş temel kaide elması
    const diamondHit =
      Math.abs(dx) / (FOOTPRINT_HALF_WIDTH + 2 + pad) +
        Math.abs(dy - 2) / (FOOTPRINT_HALF_HEIGHT + 1 + pad) <=
      1.0;
    if (diamondHit) {
      return true;
    }

    // 2) Ahşap karkas gövde ve kirpi saçaklı kiremit çatı
    return Math.abs(dx) <= 62 + pad && dy >= -78 - pad && dy <= 22 + pad;
  }

  /**
   * İleride üretilecek birimlerin çıkış noktaları — kışlanın ön cephesi (güney).
   */
  public getSpawnCandidateSpots(): GridCoord[] {
    const cMid = this.originCol + (this.footprintCols - 1) * 0.5;
    const frontRow = this.originRow + this.footprintRows - 1 + 1.05;

    return [
      { col: cMid, row: frontRow },
      { col: cMid - 0.85, row: frontRow },
      { col: cMid + 0.85, row: frontRow },
      { col: cMid - 0.45, row: frontRow + 0.8 },
      { col: cMid + 0.45, row: frontRow + 0.8 },
      { col: this.originCol - 0.9, row: frontRow - 0.5 },
      { col: this.originCol + this.footprintCols - 1 + 0.9, row: frontRow - 0.5 },
    ];
  }

  public getHudSnapshot(): BarracksHudSnapshot {
    return {
      id: this.id,
      buildingName: this.buildingName,
      buildingSubtitle: this.buildingSubtitle,
      selected: this.selected,
      hp: this.hp,
      maxHp: this.maxHp,
    };
  }

  /** Seçim/puanlama geri bildirimi için hafif ölçek darbesi. */
  public playPulse(): void {
    this.pulseTween?.stop();
    this.sprite.setScale(DISPLAY_SCALE);

    this.pulseTween = this.scene.tweens.add({
      targets: this.sprite,
      scaleX: DISPLAY_SCALE * 1.022,
      scaleY: DISPLAY_SCALE * 1.022,
      duration: 95,
      yoyo: true,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (this.sprite.active) {
          this.sprite.setScale(DISPLAY_SCALE);
        }
      },
    });
  }

  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore([
      this.shadowGraphics,
      this.selectionGraphics,
      this.sprite,
    ]);
  }

  public destroy(): void {
    this.pulseTween?.stop();
    this.shadowGraphics.destroy();
    this.selectionGraphics.destroy();
    this.sprite.destroy();
  }

  private drawGroundContactShadow(): void {
    this.shadowGraphics.clear();
    const hw = FOOTPRINT_HALF_WIDTH + 2;
    const hh = FOOTPRINT_HALF_HEIGHT + 1;

    this.shadowGraphics.fillStyle(0x0d190a, 0.25);
    this.shadowGraphics.beginPath();
    this.shadowGraphics.moveTo(0, -hh + 2);
    this.shadowGraphics.lineTo(hw, 3);
    this.shadowGraphics.lineTo(0, hh + 5);
    this.shadowGraphics.lineTo(-hw, 3);
    this.shadowGraphics.closePath();
    this.shadowGraphics.fillPath();
  }

  private drawSelectionDiamond(): void {
    this.selectionGraphics.clear();
    const hw = FOOTPRINT_HALF_WIDTH * 1.05;
    const hh = FOOTPRINT_HALF_HEIGHT * 1.05;

    this.selectionGraphics.fillStyle(0x22c55e, 0.09);
    this.selectionGraphics.beginPath();
    this.selectionGraphics.moveTo(0, -hh);
    this.selectionGraphics.lineTo(hw, 1);
    this.selectionGraphics.lineTo(0, hh + 2);
    this.selectionGraphics.lineTo(-hw, 1);
    this.selectionGraphics.closePath();
    this.selectionGraphics.fillPath();

    this.selectionGraphics.lineStyle(2.0, 0x4ade80, 0.95);
    this.selectionGraphics.beginPath();
    this.selectionGraphics.moveTo(0, -hh);
    this.selectionGraphics.lineTo(hw, 1);
    this.selectionGraphics.lineTo(0, hh + 2);
    this.selectionGraphics.lineTo(-hw, 1);
    this.selectionGraphics.closePath();
    this.selectionGraphics.strokePath();
  }
}

/** TypeScript'in kullanılmayan sabitleri atmasını engelleyen doküman referansı */
export const BARRACKS_TEXTURE_METRICS = {
  TEX_WIDTH,
  TEX_HEIGHT,
  ORIGIN_X,
  ORIGIN_Y,
  DISPLAY_SCALE,
};
