/**
 * Karahanlı RTS — Karahanlı Kışlası (Barracks)
 *
 * Tarihî Türk mimarisinden esinlenen, ahşap ve taş detaylı, kızıl tuğla temelli,
 * oyma ahşap direkli ve koyu kiremit çatılı izometrik askerî yapı. 3x2 karoluk
 * footprint ile haritaya yerleştirilir ve seçildiğinde alt bilgi panelinde
 * "Kılıçlı Asker Üret" butonunu gösterir.
 *
 * - 5 saniyede 1 Kılıçlı Asker üretir (test için ücretsiz, ileride yiyecek/altın maliyeti)
 * - Celtic Kings tarzı sınırsız kapasiteli garnizon (savaşçı/komutan) destekler
 * - Town Hall ile aynı üretim kuyruğu mantığını kullanır (max 5)
 */

import Phaser from 'phaser';
import {
  BuildingGarrisonController,
  BuildingGarrisonSnapshot,
  GarrisonableBuilding,
} from './garrisonSystem';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';

export const BARRACKS_TEXTURE_KEY = 'barracks_karahanli';
export const BARRACKS_ASSET_PATH = 'assets/sprites/barracks_karahanli.png';

export const BARRACKS_TRAIN_WARRIOR_TASK_ID = 'train_warrior_swordsman';
export const BARRACKS_WARRIOR_PRODUCTION_DURATION_MS = 5000;
export const BARRACKS_WARRIOR_GOLD_COST = 0; // şimdilik ücretsiz, ileride eklenecek
export const BARRACKS_WARRIOR_FOOD_COST = 0;

const TEX_WIDTH = 800;
const TEX_HEIGHT = 550;
const ORIGIN_X = 400 / TEX_WIDTH; // 0.5
const ORIGIN_Y = 385 / TEX_HEIGHT; // ~0.7
const DISPLAY_SCALE = 0.38;
const MAX_PRODUCTION_QUEUE = 5;

export type BarracksTaskKind = 'unit_production';

export interface BarracksTaskDefinition {
  id: string;
  kind: BarracksTaskKind;
  label: string;
  durationMs: number;
  cost: { wood?: number; food?: number; gold?: number };
}

export interface BarracksActiveQueueItem {
  definition: BarracksTaskDefinition;
  elapsedMs: number;
}

export type BarracksEnqueueFailReason = 'unknown_task' | 'queue_full' | 'insufficient_resources';

export interface BarracksEnqueueResult {
  ok: boolean;
  reason?: BarracksEnqueueFailReason;
}

export interface BarracksHudSnapshot {
  id: string;
  buildingName: string;
  buildingSubtitle: string;
  selected: boolean;
  hp: number;
  maxHp: number;
  canTrainWarrior: boolean;
  warriorDurationSec: number;
  queueLength: number;
  activeTaskLabel: string | null;
  activeProgressRatio: number;
  activeRemainingSec: number;
  garrison: BuildingGarrisonSnapshot;
}

export interface BarracksConfig {
  id?: string;
  originCol: number;
  originRow: number;
  footprintCols?: number;
  footprintRows?: number;
  maxHp?: number;
}

/** Haritanın güneybatı meydanında, Town Hall'a komşu 3x2 kışla konumu */
export const DEFAULT_BARRACKS_CONFIG: BarracksConfig = {
  id: 'barracks_main',
  originCol: 4,
  originRow: 10,
  footprintCols: 3,
  footprintRows: 2,
  maxHp: 900,
};

export type BarracksTaskCompletedCallback = (task: BarracksTaskDefinition) => void;

export class Barracks implements GarrisonableBuilding {
  public readonly id: string;
  public readonly buildingName = 'Kışla';
  public readonly buildingSubtitle = 'Karahanlı Kışlası';
  public readonly garrison: BuildingGarrisonController;

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
  private readonly taskRegistry = new Map<string, BarracksTaskDefinition>();
  private readonly taskQueue: BarracksActiveQueueItem[] = [];
  private readonly completionListeners = new Set<BarracksTaskCompletedCallback>();
  private pulseTween?: Phaser.Tweens.Tween;

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid, config: BarracksConfig = DEFAULT_BARRACKS_CONFIG) {
    this.id = config.id ?? 'barracks_main';
    this.scene = scene;
    this.isoGrid = isoGrid;
    this.originCol = config.originCol;
    this.originRow = config.originRow;
    this.footprintCols = config.footprintCols ?? 3;
    this.footprintRows = config.footprintRows ?? 2;
    this.maxHp = config.maxHp ?? 900;
    this.hp = this.maxHp;

    this.garrison = new BuildingGarrisonController({
      buildingId: this.id,
      buildingName: this.buildingName,
      allowedCategories: ['warrior', 'commander', 'villager'],
      maxCapacity: null,
      healHpPerSecond: 2.0,
      satietyPerFoodUnit: 25,
    });

    this.registerTaskDefinition({
      id: BARRACKS_TRAIN_WARRIOR_TASK_ID,
      kind: 'unit_production',
      label: 'Kılıçlı Asker',
      durationMs: BARRACKS_WARRIOR_PRODUCTION_DURATION_MS,
      cost: {},
    });

    const centerTile = this.getCenterTile();
    const worldPos = isoGrid.tileToWorld(centerTile.col, centerTile.row);
    const sortDepth = isoGrid.getTileDepth(centerTile.col + 0.1, centerTile.row + 0.1);

    this.shadowGraphics = scene.add.graphics();
    this.drawGroundContactShadow();
    this.shadowGraphics.setPosition(worldPos.x, worldPos.y);
    this.shadowGraphics.setDepth(1.5);

    this.selectionGraphics = scene.add.graphics();
    this.drawSelectionDiamond();
    this.selectionGraphics.setPosition(worldPos.x, worldPos.y);
    this.selectionGraphics.setDepth(2.2);
    this.selectionGraphics.setVisible(false);

    this.sprite = scene.add.image(worldPos.x, worldPos.y, BARRACKS_TEXTURE_KEY);
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(DISPLAY_SCALE);
    this.sprite.setDepth(sortDepth);

    this.progressGraphics = scene.add.graphics();
    this.progressGraphics.setPosition(worldPos.x, worldPos.y - 88);
    this.progressGraphics.setDepth(sortDepth + 120);
    this.progressGraphics.setVisible(false);
  }

  public static preload(scene: Phaser.Scene): void {
    scene.load.image(BARRACKS_TEXTURE_KEY, BARRACKS_ASSET_PATH);
  }

  public registerTaskDefinition(definition: BarracksTaskDefinition): void {
    this.taskRegistry.set(definition.id, definition);
  }

  public onTaskCompleted(listener: BarracksTaskCompletedCallback): void {
    this.completionListeners.add(listener);
  }

  public setSelected(value: boolean): void {
    if (this.selected === value) return;
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
  public containsWorldPoint(worldX: number, worldY: number, isTouch = false): boolean {
    const center = this.getWorldPosition();
    const pad = isTouch ? 10 : 4;
    const dx = worldX - center.x;
    const dy = worldY - center.y;
    // Diamond hit for 3x2
    const hw = 74;
    const hh = 36;
    const diamondHit = Math.abs(dx) / hw + Math.abs(dy) / hh <= 1.0 + pad * 0.01;
    if (diamondHit) return true;
    return Math.abs(dx) <= 84 + pad && dy >= -82 - pad && dy <= 20 + pad;
  }
  public getEntranceApproachSpots(): GridCoord[] {
    const cMid = this.originCol + (this.footprintCols - 1) * 0.5;
    const stairRow = this.originRow + this.footprintRows - 1 + 0.9;
    return [
      { col: cMid, row: stairRow },
      { col: cMid - 0.65, row: stairRow },
      { col: cMid + 0.65, row: stairRow },
      { col: cMid - 1.25, row: stairRow - 0.1 },
      { col: cMid + 1.25, row: stairRow - 0.1 },
      { col: this.originCol - 0.88, row: this.originRow + 0.9 },
      { col: this.originCol + this.footprintCols - 1 + 0.88, row: this.originRow + 0.9 },
    ];
  }
  public isNearEntranceForEntry(pos: GridCoord): boolean {
    const minC = this.originCol - 1.32;
    const maxC = this.originCol + this.footprintCols - 1 + 1.32;
    const minR = this.originRow - 1.32;
    const maxR = this.originRow + this.footprintRows - 1 + 1.38;
    return pos.col >= minC && pos.col <= maxC && pos.row >= minR && pos.row <= maxR;
  }
  public getSpawnCandidateSpots(): GridCoord[] {
    const cMid = this.originCol + (this.footprintCols - 1) * 0.5;
    const frontRow = this.originRow + this.footprintRows - 1 + 1.05;
    const westCol = this.originCol - 0.92;
    const eastCol = this.originCol + this.footprintCols - 1 + 0.92;
    const backRow = this.originRow - 0.92;
    return [
      { col: cMid, row: frontRow },
      { col: cMid - 0.88, row: frontRow },
      { col: cMid + 0.88, row: frontRow },
      { col: westCol, row: frontRow - 0.7 },
      { col: eastCol, row: frontRow - 0.7 },
      { col: cMid - 0.45, row: frontRow + 0.82 },
      { col: cMid + 0.45, row: frontRow + 0.82 },
      { col: cMid - 1.35, row: frontRow + 0.82 },
      { col: cMid + 1.35, row: frontRow + 0.82 },
      { col: westCol, row: this.originRow + 0.8 },
      { col: eastCol, row: this.originRow + 0.8 },
      { col: cMid, row: backRow },
    ];
  }

  public canTrainWarrior(): boolean {
    return this.canEnqueueTask(BARRACKS_TRAIN_WARRIOR_TASK_ID).ok;
  }
  public tryTrainWarrior(): BarracksEnqueueResult {
    return this.tryEnqueueTask(BARRACKS_TRAIN_WARRIOR_TASK_ID);
  }
  public canEnqueueTask(taskId: string): BarracksEnqueueResult {
    const def = this.taskRegistry.get(taskId);
    if (!def) return { ok: false, reason: 'unknown_task' };
    if (this.taskQueue.length >= MAX_PRODUCTION_QUEUE) return { ok: false, reason: 'queue_full' };
    // Ücretsiz test: kaynak kontrolü yok (ileride yiyecek/altın eklenecek)
    return { ok: true };
  }
  public tryEnqueueTask(taskId: string): BarracksEnqueueResult {
    const check = this.canEnqueueTask(taskId);
    if (!check.ok) return check;
    const def = this.taskRegistry.get(taskId)!;
    this.taskQueue.push({ definition: def, elapsedMs: 0 });
    this.playOrderPulse();
    this.refreshWorldProgressBar();
    return { ok: true };
  }

  public update(deltaMs: number): void {
    this.garrison.update(deltaMs);
    if (this.taskQueue.length === 0) {
      if (this.progressGraphics.visible) this.progressGraphics.setVisible(false);
      return;
    }
    const active = this.taskQueue[0];
    active.elapsedMs += deltaMs;
    if (active.elapsedMs >= active.definition.durationMs) {
      const carryOverMs = Math.min(100, active.elapsedMs - active.definition.durationMs);
      const finishedTask = active.definition;
      this.taskQueue.shift();
      if (this.taskQueue.length > 0 && carryOverMs > 0) {
        this.taskQueue[0].elapsedMs += carryOverMs;
      }
      this.playOrderPulse();
      for (const listener of this.completionListeners) {
        listener(finishedTask);
      }
    }
    this.refreshWorldProgressBar();
  }

  public getHudSnapshot(): BarracksHudSnapshot {
    const active = this.taskQueue[0];
    const ratio = active ? Phaser.Math.Clamp(active.elapsedMs / active.definition.durationMs, 0, 1) : 0;
    const remainingSec = active ? Math.max(0, (active.definition.durationMs - active.elapsedMs) / 1000) : 0;
    return {
      id: this.id,
      buildingName: this.buildingName,
      buildingSubtitle: this.buildingSubtitle,
      selected: this.selected,
      hp: this.hp,
      maxHp: this.maxHp,
      canTrainWarrior: this.canTrainWarrior(),
      warriorDurationSec: BARRACKS_WARRIOR_PRODUCTION_DURATION_MS / 1000,
      queueLength: this.taskQueue.length,
      activeTaskLabel: active ? active.definition.label : null,
      activeProgressRatio: ratio,
      activeRemainingSec: remainingSec,
      garrison: this.garrison.getSnapshot(),
    };
  }

  public playGarrisonPulse(): void {
    this.playOrderPulse();
  }
  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore([this.shadowGraphics, this.selectionGraphics, this.sprite, this.progressGraphics]);
  }
  public destroy(): void {
    this.pulseTween?.stop();
    this.completionListeners.clear();
    this.taskQueue.length = 0;
    this.garrison.clearAllWithoutEject();
    this.shadowGraphics.destroy();
    this.selectionGraphics.destroy();
    this.sprite.destroy();
    this.progressGraphics.destroy();
  }

  private playOrderPulse(): void {
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
        if (this.sprite.active) this.sprite.setScale(DISPLAY_SCALE);
      },
    });
  }
  private refreshWorldProgressBar(): void {
    if (this.taskQueue.length === 0) {
      this.progressGraphics.clear();
      this.progressGraphics.setVisible(false);
      return;
    }
    const active = this.taskQueue[0];
    const ratio = Phaser.Math.Clamp(active.elapsedMs / active.definition.durationMs, 0, 1);
    const barW = 58;
    const barH = 6;
    const x = -barW * 0.5;
    const y = 0;
    this.progressGraphics.clear();
    this.progressGraphics.fillStyle(0x0f172a, 0.88);
    this.progressGraphics.fillRoundedRect(x - 2, y - 2, barW + 4, barH + 4, 4);
    this.progressGraphics.lineStyle(1, 0x94a3b8, 0.8);
    this.progressGraphics.strokeRoundedRect(x - 2, y - 2, barW + 4, barH + 4, 4);
    if (ratio > 0.01) {
      this.progressGraphics.fillStyle(0x38bdf8, 0.95);
      this.progressGraphics.fillRoundedRect(x, y, Math.max(3, barW * ratio), barH, 2.5);
    }
    this.progressGraphics.setVisible(true);
  }
  private drawGroundContactShadow(): void {
    this.shadowGraphics.clear();
    const hw = 78;
    const hh = 39;
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
    const hw = 79;
    const hh = 40;
    this.selectionGraphics.fillStyle(0x38bdf8, 0.09);
    this.selectionGraphics.beginPath();
    this.selectionGraphics.moveTo(0, -hh);
    this.selectionGraphics.lineTo(hw, 1);
    this.selectionGraphics.lineTo(0, hh + 2);
    this.selectionGraphics.lineTo(-hw, 1);
    this.selectionGraphics.closePath();
    this.selectionGraphics.fillPath();
    this.selectionGraphics.lineStyle(2.0, 0x38bdf8, 0.95);
    this.selectionGraphics.beginPath();
    this.selectionGraphics.moveTo(0, -hh);
    this.selectionGraphics.lineTo(hw, 1);
    this.selectionGraphics.lineTo(0, hh + 2);
    this.selectionGraphics.lineTo(-hw, 1);
    this.selectionGraphics.closePath();
    this.selectionGraphics.strokePath();
  }
}
