/**
 * Karahanlı RTS — Town Hall (Eski Türk Hükümdar Konağı / Ana Merkez Binası)
 *
 * Karahanlı yerleşiminin kalbi olan, ahşap sütunlu, kızıl tuğla ve taş temelli,
 * giriş kapısı üzerinde Türk geometrik motifli ve kurt kabartmalı zarif arması bulunan,
 * tuğ sancaklı 3x3 karoluk hükümdar konağı:
 * - Mevcut köylü üretimi (20 Odun, 5 sn) ve üretim kuyruğunu korur
 * - Celtic Kings tarzı sınırsız kapasiteli garnizon sistemiyle köylü, savaşçı
 *   ve komutan gruplarını (50+ kişilik ordular dahil) içine alır
 * - Harita üzerinde yüzen garnizon yazısı göstermez; garnizondaki birim sayısı ve
 *   türleri yalnızca bina seçildiğinde alt bilgi panelinde gösterilir
 * - İçerideki birimler zamanla can yeniler; erzak ekonomisiyle beslenmeye hazırdır
 */

import Phaser from 'phaser';
import {
  BuildingGarrisonController,
  BuildingGarrisonSnapshot,
  GarrisonableBuilding,
} from './garrisonSystem';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';
import { SettlementFoodProvisionWallet } from './unitTypes';
import { WoodDepot } from './woodDepot';

export const TOWN_HALL_TEXTURE_KEY = 'town_hall_karahanli';
export const TOWN_HALL_ASSET_PATH = 'assets/sprites/town_hall_karahanli.png';

/** Köylü üretim maliyeti (odun) ve üretim süresi (ms) */
export const VILLAGER_PRODUCTION_WOOD_COST = 20;
export const VILLAGER_PRODUCTION_DURATION_MS = 5000;
export const TRAIN_VILLAGER_TASK_ID = 'train_villager';

const TEX_WIDTH = 397;
const TEX_HEIGHT = 311;
/** 3x3 izometrik taş/kızıl tuğla kaide merkezinin doku içindeki tam piksel karşılığı */
const ORIGIN_X = 198.32 / TEX_WIDTH;
const ORIGIN_Y = 206.12 / TEX_HEIGHT;
/** 2x retina dokuyu dünya uzayında tam 3x3 karo elmasına oturtan ölçek */
const DISPLAY_SCALE = 0.5;
const MAX_PRODUCTION_QUEUE = 5;

export type SettlementAgeId =
  | 'age_1_bozkir_obasi'
  | 'age_2_karahanli_beyligi'
  | 'age_3_hakanlik_merkezi';

export interface SettlementAgeInfo {
  id: SettlementAgeId;
  order: number;
  title: string;
}

export const SETTLEMENT_AGES: Record<SettlementAgeId, SettlementAgeInfo> = {
  age_1_bozkir_obasi: {
    id: 'age_1_bozkir_obasi',
    order: 1,
    title: 'I. Çağ — Bozkır Obası',
  },
  age_2_karahanli_beyligi: {
    id: 'age_2_karahanli_beyligi',
    order: 2,
    title: 'II. Çağ — Karahanlı Beyliği',
  },
  age_3_hakanlik_merkezi: {
    id: 'age_3_hakanlik_merkezi',
    order: 3,
    title: 'III. Çağ — Hakanlık Merkezi',
  },
};

export interface SettlementResourceCost {
  wood?: number;
  food?: number;
  stone?: number;
  gold?: number;
}

export type TownHallTaskKind =
  | 'unit_production'
  | 'tech_research'
  | 'age_advance';

export interface TownHallTaskDefinition {
  id: string;
  kind: TownHallTaskKind;
  label: string;
  cost: SettlementResourceCost;
  durationMs: number;
  requiredAge?: SettlementAgeId;
  unique?: boolean;
  targetAge?: SettlementAgeId;
}

export interface ActiveQueueItem {
  definition: TownHallTaskDefinition;
  elapsedMs: number;
}

export type EnqueueTaskFailReason =
  | 'unknown_task'
  | 'insufficient_wood'
  | 'queue_full'
  | 'already_completed'
  | 'age_locked';

export interface EnqueueTaskResult {
  ok: boolean;
  reason?: EnqueueTaskFailReason;
}

export interface TownHallHudSnapshot {
  id: string;
  buildingName: string;
  buildingSubtitle: string;
  selected: boolean;
  hp: number;
  maxHp: number;
  ageTitle: string;
  canTrainVillager: boolean;
  villagerWoodCost: number;
  villagerDurationSec: number;
  storedWood: number;
  queueLength: number;
  activeTaskLabel: string | null;
  activeProgressRatio: number;
  activeRemainingSec: number;
  garrison: BuildingGarrisonSnapshot;
}

export interface TownHallConfig {
  id?: string;
  originCol: number;
  originRow: number;
  footprintCols?: number;
  footprintRows?: number;
  initialAge?: SettlementAgeId;
  maxHp?: number;
}

/** Haritanın tam merkezinde, odun deposu ve koruluğa komşu anıtsal 3x3 yerleşim konumu */
export const DEFAULT_TOWN_HALL_CONFIG: TownHallConfig = {
  id: 'town_hall_main',
  originCol: 9,
  originRow: 5,
  footprintCols: 3,
  footprintRows: 3,
  initialAge: 'age_1_bozkir_obasi',
  maxHp: 1200,
};

export type TownHallTaskCompletedCallback = (
  task: TownHallTaskDefinition
) => void;

export class TownHall implements GarrisonableBuilding {
  public readonly id: string;
  public readonly buildingName = 'Town Hall';
  public readonly buildingSubtitle = 'Hükümdar Konağı';
  public readonly garrison: BuildingGarrisonController;

  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly woodDepot: WoodDepot;
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
  private currentAge: SettlementAgeId;
  private rallyPoint: GridCoord | null = null;
  private readonly researchedTechIds = new Set<string>();
  private readonly taskRegistry = new Map<string, TownHallTaskDefinition>();
  private readonly taskQueue: ActiveQueueItem[] = [];
  private readonly completionListeners = new Set<TownHallTaskCompletedCallback>();
  private pulseTween?: Phaser.Tweens.Tween;

  constructor(
    scene: Phaser.Scene,
    isoGrid: IsoGrid,
    woodDepot: WoodDepot,
    config: TownHallConfig = DEFAULT_TOWN_HALL_CONFIG
  ) {
    this.id = config.id ?? 'town_hall_main';
    this.scene = scene;
    this.isoGrid = isoGrid;
    this.woodDepot = woodDepot;
    this.originCol = config.originCol;
    this.originRow = config.originRow;
    this.footprintCols = config.footprintCols ?? 3;
    this.footprintRows = config.footprintRows ?? 3;
    this.currentAge = config.initialAge ?? 'age_1_bozkir_obasi';
    this.maxHp = config.maxHp ?? 1200;
    this.hp = this.maxHp;

    // Katı kapasite sınırı olmadan (50+ kişilik ordular dahil) tüm birimleri kabul eden garnizon
    this.garrison = new BuildingGarrisonController({
      buildingId: this.id,
      buildingName: this.buildingName,
      allowedCategories: ['villager', 'warrior', 'commander'],
      maxCapacity: null,
      healHpPerSecond: 2.5,
      satietyPerFoodUnit: 25,
    });

    this.registerTaskDefinition({
      id: TRAIN_VILLAGER_TASK_ID,
      kind: 'unit_production',
      label: 'Köylü',
      cost: { wood: VILLAGER_PRODUCTION_WOOD_COST },
      durationMs: VILLAGER_PRODUCTION_DURATION_MS,
    });

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
      TOWN_HALL_TEXTURE_KEY
    );
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(DISPLAY_SCALE);
    this.sprite.setDepth(sortDepth);

  }

  public static preload(scene: Phaser.Scene): void {
    scene.load.image(TOWN_HALL_TEXTURE_KEY, TOWN_HALL_ASSET_PATH);
  }

  public registerTaskDefinition(definition: TownHallTaskDefinition): void {
    this.taskRegistry.set(definition.id, definition);
  }

  public getRegisteredTasks(kind?: TownHallTaskKind): TownHallTaskDefinition[] {
    const all = Array.from(this.taskRegistry.values());
    return kind ? all.filter((t) => t.kind === kind) : all;
  }

  public onTaskCompleted(listener: TownHallTaskCompletedCallback): void {
    this.completionListeners.add(listener);
  }

  public getCurrentAge(): SettlementAgeInfo {
    return SETTLEMENT_AGES[this.currentAge];
  }

  public hasResearchedTech(techId: string): boolean {
    return this.researchedTechIds.has(techId);
  }

  public setRallyPoint(target: GridCoord | null): void {
    this.rallyPoint = target ? { col: target.col, row: target.row } : null;
  }

  public getRallyPoint(): GridCoord | null {
    return this.rallyPoint
      ? { col: this.rallyPoint.col, row: this.rallyPoint.row }
      : null;
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

    // 1) 3x3 izometrik taş ve kızıl tuğla kaide elması
    const diamondHit =
      Math.abs(dx) / (98 + pad) + Math.abs(dy - 2) / (51 + pad) <= 1.0;
    if (diamondHit) {
      return true;
    }

    // 2) Ahşap sütunlu gövde ve kademeli konak çatısı
    return (
      Math.abs(dx) <= 72 + pad &&
      dy >= -96 - pad &&
      dy <= 28 + pad
    );
  }

  /**
   * Birimlerin binaya girmek üzere yönlendirileceği ön merdiven ve çevre yaklaşım noktaları.
   */
  public getEntranceApproachSpots(): GridCoord[] {
    const cMid = this.originCol + (this.footprintCols - 1) * 0.5;
    const stairRow = this.originRow + this.footprintRows - 1 + 0.9;

    return [
      { col: cMid, row: stairRow },
      { col: cMid - 0.65, row: stairRow },
      { col: cMid + 0.65, row: stairRow },
      { col: cMid - 1.25, row: stairRow - 0.1 },
      { col: cMid + 1.25, row: stairRow - 0.1 },
      { col: this.originCol - 0.88, row: this.originRow + 1.6 },
      { col: this.originCol + this.footprintCols - 1 + 0.88, row: this.originRow + 1.6 },
    ];
  }

  /**
   * Binaya giriş emri almış bir birimin kapı/merdiven eşiğine ulaşıp ulaşmadığını kontrol eder.
   */
  public isNearEntranceForEntry(pos: GridCoord): boolean {
    const minC = this.originCol - 1.32;
    const maxC = this.originCol + this.footprintCols - 1 + 1.32;
    const minR = this.originRow - 1.32;
    const maxR = this.originRow + this.footprintRows - 1 + 1.38;

    return (
      pos.col >= minC &&
      pos.col <= maxC &&
      pos.row >= minR &&
      pos.row <= maxR
    );
  }

  /**
   * Yeni üretilen veya garnizondan çıkan birimlerin yerleşeceği öncelikli açık noktalar.
   */
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
      { col: westCol, row: this.originRow + 1.0 },
      { col: eastCol, row: this.originRow + 1.0 },
      { col: cMid, row: backRow },
    ];
  }

  public canTrainVillager(): boolean {
    return this.canEnqueueTask(TRAIN_VILLAGER_TASK_ID).ok;
  }

  public tryTrainVillager(): EnqueueTaskResult {
    return this.tryEnqueueTask(TRAIN_VILLAGER_TASK_ID);
  }

  public canEnqueueTask(taskId: string): EnqueueTaskResult {
    const def = this.taskRegistry.get(taskId);
    if (!def) {
      return { ok: false, reason: 'unknown_task' };
    }

    if (def.unique) {
      if (this.researchedTechIds.has(def.id)) {
        return { ok: false, reason: 'already_completed' };
      }
      if (this.taskQueue.some((item) => item.definition.id === def.id)) {
        return { ok: false, reason: 'already_completed' };
      }
    }

    if (def.requiredAge) {
      const curOrder = SETTLEMENT_AGES[this.currentAge].order;
      const reqOrder = SETTLEMENT_AGES[def.requiredAge].order;
      if (curOrder < reqOrder) {
        return { ok: false, reason: 'age_locked' };
      }
    }

    if (this.taskQueue.length >= MAX_PRODUCTION_QUEUE) {
      return { ok: false, reason: 'queue_full' };
    }

    const woodCost = def.cost.wood ?? 0;
    if (!this.woodDepot.canAffordWood(woodCost)) {
      return { ok: false, reason: 'insufficient_wood' };
    }

    return { ok: true };
  }

  public tryEnqueueTask(taskId: string): EnqueueTaskResult {
    const check = this.canEnqueueTask(taskId);
    if (!check.ok) {
      return check;
    }

    const def = this.taskRegistry.get(taskId)!;
    const woodCost = def.cost.wood ?? 0;
    if (woodCost > 0 && !this.woodDepot.spendWood(woodCost)) {
      return { ok: false, reason: 'insufficient_wood' };
    }

    this.taskQueue.push({
      definition: def,
      elapsedMs: 0,
    });

    this.playOrderPulse();
    return { ok: true };
  }

  public update(
    deltaMs: number,
    foodWallet?: SettlementFoodProvisionWallet
  ): void {
    // 1) İçerideki birimlerin can yenileme ve erzak güncellemesi
    this.garrison.update(deltaMs, foodWallet);

    // 2) Üretim / araştırma kuyruğu
    if (this.taskQueue.length === 0) {
      return;
    }

    const active = this.taskQueue[0];
    active.elapsedMs += deltaMs;

    if (active.elapsedMs >= active.definition.durationMs) {
      const carryOverMs = Math.min(
        100,
        active.elapsedMs - active.definition.durationMs
      );
      const finishedTask = active.definition;
      this.taskQueue.shift();

      if (this.taskQueue.length > 0 && carryOverMs > 0) {
        this.taskQueue[0].elapsedMs += carryOverMs;
      }

      this.applyInternalTaskCompletion(finishedTask);
      this.playOrderPulse();

      for (const listener of this.completionListeners) {
        listener(finishedTask);
      }
    }
  }

  public getHudSnapshot(): TownHallHudSnapshot {
    const active = this.taskQueue[0];
    const ratio = active
      ? Phaser.Math.Clamp(active.elapsedMs / active.definition.durationMs, 0, 1)
      : 0;
    const remainingSec = active
      ? Math.max(0, (active.definition.durationMs - active.elapsedMs) / 1000)
      : 0;

    return {
      id: this.id,
      buildingName: this.buildingName,
      buildingSubtitle: this.buildingSubtitle,
      selected: this.selected,
      hp: this.hp,
      maxHp: this.maxHp,
      ageTitle: SETTLEMENT_AGES[this.currentAge].title,
      canTrainVillager: this.canTrainVillager(),
      villagerWoodCost: VILLAGER_PRODUCTION_WOOD_COST,
      villagerDurationSec: VILLAGER_PRODUCTION_DURATION_MS / 1000,
      storedWood: this.woodDepot.getStoredWood(),
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
    camera.ignore([
      this.shadowGraphics,
      this.selectionGraphics,
      this.sprite,
    ]);
  }

  public destroy(): void {
    this.pulseTween?.stop();
    this.completionListeners.clear();
    this.taskQueue.length = 0;
    this.garrison.clearAllWithoutEject();
    this.shadowGraphics.destroy();
    this.selectionGraphics.destroy();
    this.sprite.destroy();
  }

  private applyInternalTaskCompletion(task: TownHallTaskDefinition): void {
    if (task.kind === 'tech_research') {
      this.researchedTechIds.add(task.id);
    } else if (task.kind === 'age_advance' && task.targetAge) {
      this.currentAge = task.targetAge;
    }
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
        if (this.sprite.active) {
          this.sprite.setScale(DISPLAY_SCALE);
        }
      },
    });
  }


  private drawGroundContactShadow(): void {
    this.shadowGraphics.clear();
    const hw = 100;
    const hh = 51;

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
    const hw = 101;
    const hh = 52;

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
