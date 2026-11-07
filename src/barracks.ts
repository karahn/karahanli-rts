/**
 * Karahanlı RTS — Karahanlı Kışlası (Askerî Eğitim Yapısı)
 *
 * Yerleşimin güneybatısında (cols 6..8, rows 10..11) yer alan, ZEMİNE DOĞRUDAN
 * OTURAN açık avlulu askerî talim yapısı:
 * - Kaba yontulmuş taş ve ahşap karkas duvarlarla çevrili, ortası açık toprak
 *   avlu/talim alanı olan alçak ve geniş bir yapıdır
 * - Town Hall'daki gibi büyük yükseltilmiş taş platform KULLANMAZ; yalnızca
 *   girişte küçük bir taş eşik bulunur
 * - Town Hall ile aynı çizim kalitesinde ama ondan daha alçak ve daha az
 *   baskındır (görünür yükseklik ~88 px'e karşı ~126 px)
 * - Seçildiğinde alt bilgi panelinde bina adı, can değeri ve Kılıçlı Asker
 *   üretim butonu gösterilir
 * - Üretilen asker kışlanın ön cephesinde (güneyde) ortaya çıkar
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';

export const BARRACKS_TEXTURE_KEY = 'barracks_karahanli';
export const BARRACKS_ASSET_PATH = 'assets/sprites/barracks_karahanli.png';

const TEX_WIDTH = 322;
const TEX_HEIGHT = 177;
/**
 * Dokunun izometrik taban elmasının merkezine karşılık gelen orijin.
 * Town Hall dokusunda kullanılan yöntemin aynısıyla (taban elmasının alt
 * kenarları ölçülerek) hesaplandı — Town Hall'da sapma 0.8 px.
 */
const ORIGIN_X = 0.5;
const ORIGIN_Y = 0.56497;
/** 2x retina dokuyu dünya uzayında tam 3x2 karo elmasına oturtan ölçek */
const DISPLAY_SCALE = 0.49844;

/** 3x2 karo ayak izinin dünya uzayındaki elmas yarı genişliği / yarı yüksekliği */
const FOOTPRINT_HALF_WIDTH = 80;
const FOOTPRINT_HALF_HEIGHT = 37.88;

/** Kılıçlı asker üretim süresi (ms) ve maliyeti (test aşamasında ücretsiz) */
export const WARRIOR_PRODUCTION_DURATION_MS = 5000;
export const WARRIOR_PRODUCTION_WOOD_COST = 0;
export const TRAIN_WARRIOR_TASK_ID = 'train_warrior';
const MAX_PRODUCTION_QUEUE = 5;

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
  canTrainWarrior: boolean;
  warriorWoodCost: number;
  warriorDurationSec: number;
  queueLength: number;
  activeProgressRatio: number;
  activeRemainingSec: number;
}

export type BarracksTaskCompletedCallback = (taskId: string) => void;

export interface EnqueueTaskResult {
  ok: boolean;
  reason?: 'queue_full';
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
  private readonly progressGraphics: Phaser.GameObjects.Graphics;

  private selected = false;
  private productionElapsedMs: number | null = null;
  private queueLength = 0;
  private readonly completionListeners = new Set<BarracksTaskCompletedCallback>();
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

    this.progressGraphics = scene.add.graphics();
    this.progressGraphics.setPosition(worldPos.x, worldPos.y - 74);
    this.progressGraphics.setDepth(sortDepth + 120);
    this.progressGraphics.setVisible(false);
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

    // 1) 3x2 izometrik taban elması (zemine oturan avlu alanı)
    const diamondHit =
      Math.abs(dx) / (FOOTPRINT_HALF_WIDTH + 2 + pad) +
        Math.abs(dy - 2) / (FOOTPRINT_HALF_HEIGHT + 1 + pad) <=
      1.0;
    if (diamondHit) {
      return true;
    }

    // 2) Alçak avlu duvarları ve ahşap sundurma çatıları
    return Math.abs(dx) <= 66 + pad && dy >= -50 - pad && dy <= 14 + pad;
  }

  /**
   * Üretilen askerlerin çıkış noktaları — kışlanın ön cephesi (güney).
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

  // --- Kılıçlı Asker üretimi ---

  public canTrainWarrior(): boolean {
    return this.queueLength < MAX_PRODUCTION_QUEUE;
  }

  public tryTrainWarrior(): EnqueueTaskResult {
    if (!this.canTrainWarrior()) {
      return { ok: false, reason: 'queue_full' };
    }

    if (this.queueLength === 0) {
      this.productionElapsedMs = 0;
    }
    this.queueLength += 1;
    this.playPulse();
    this.refreshWorldProgressBar();
    return { ok: true };
  }

  public onTaskCompleted(listener: BarracksTaskCompletedCallback): void {
    this.completionListeners.add(listener);
  }

  public update(deltaMs: number): void {
    if (this.queueLength === 0 || this.productionElapsedMs === null) {
      if (this.progressGraphics.visible) {
        this.progressGraphics.setVisible(false);
      }
      return;
    }

    this.productionElapsedMs += deltaMs;

    if (this.productionElapsedMs >= WARRIOR_PRODUCTION_DURATION_MS) {
      const carryOverMs = Math.min(
        100,
        this.productionElapsedMs - WARRIOR_PRODUCTION_DURATION_MS
      );
      this.queueLength = Math.max(0, this.queueLength - 1);

      if (this.queueLength > 0) {
        this.productionElapsedMs = carryOverMs;
      } else {
        this.productionElapsedMs = null;
      }

      this.playPulse();
      for (const listener of this.completionListeners) {
        listener(TRAIN_WARRIOR_TASK_ID);
      }
    }

    this.refreshWorldProgressBar();
  }

  public getHudSnapshot(): BarracksHudSnapshot {
    const ratio =
      this.productionElapsedMs === null
        ? 0
        : Phaser.Math.Clamp(
            this.productionElapsedMs / WARRIOR_PRODUCTION_DURATION_MS,
            0,
            1
          );
    const remainingSec =
      this.productionElapsedMs === null
        ? 0
        : Math.max(
            0,
            (WARRIOR_PRODUCTION_DURATION_MS - this.productionElapsedMs) / 1000
          );

    return {
      id: this.id,
      buildingName: this.buildingName,
      buildingSubtitle: this.buildingSubtitle,
      selected: this.selected,
      hp: this.hp,
      maxHp: this.maxHp,
      canTrainWarrior: this.canTrainWarrior(),
      warriorWoodCost: WARRIOR_PRODUCTION_WOOD_COST,
      warriorDurationSec: WARRIOR_PRODUCTION_DURATION_MS / 1000,
      queueLength: this.queueLength,
      activeProgressRatio: ratio,
      activeRemainingSec: remainingSec,
    };
  }

  /** Seçim/üretim geri bildirimi için hafif ölçek darbesi. */
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
      this.progressGraphics,
    ]);
  }

  public destroy(): void {
    this.pulseTween?.stop();
    this.completionListeners.clear();
    this.shadowGraphics.destroy();
    this.selectionGraphics.destroy();
    this.sprite.destroy();
    this.progressGraphics.destroy();
  }

  private refreshWorldProgressBar(): void {
    if (this.queueLength === 0 || this.productionElapsedMs === null) {
      this.progressGraphics.clear();
      this.progressGraphics.setVisible(false);
      return;
    }

    const ratio = Phaser.Math.Clamp(
      this.productionElapsedMs / WARRIOR_PRODUCTION_DURATION_MS,
      0,
      1
    );

    const barW = 58;
    const barH = 6;
    const x = -barW * 0.5;

    this.progressGraphics.clear();
    this.progressGraphics.fillStyle(0x0f172a, 0.88);
    this.progressGraphics.fillRoundedRect(x - 2, -2, barW + 4, barH + 4, 4);
    this.progressGraphics.lineStyle(1, 0x94a3b8, 0.8);
    this.progressGraphics.strokeRoundedRect(x - 2, -2, barW + 4, barH + 4, 4);

    if (ratio > 0.01) {
      this.progressGraphics.fillStyle(0x4ade80, 0.95);
      this.progressGraphics.fillRoundedRect(
        x,
        0,
        Math.max(3, barW * ratio),
        barH,
        2.5
      );
    }

    this.progressGraphics.setVisible(true);
  }

  private drawGroundContactShadow(): void {
    this.shadowGraphics.clear();
    const hw = FOOTPRINT_HALF_WIDTH + 2;
    const hh = FOOTPRINT_HALF_HEIGHT + 1;

    this.shadowGraphics.fillStyle(0x0d190a, 0.22);
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

/** Doküman amaçlı doku ölçüleri (sabitlerin kullanıldığını garantiler) */
export const BARRACKS_TEXTURE_METRICS = {
  TEX_WIDTH,
  TEX_HEIGHT,
  ORIGIN_X,
  ORIGIN_Y,
  DISPLAY_SCALE,
};
