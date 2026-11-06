/**
 * Karahanlı RTS — Köylü Birim Sınıfı (Villager)
 *
 * Tarihî Karahanlı dönemine uygun erkek köylü biriminin konum, hareket hızı,
 * can/saldırı/savunma/tokluk verilerini, tekli/çoklu seçim durumunu, odun toplama
 * ve ortak depoya teslim döngüsünü, ayrıca garnizon destekli binalara (Town Hall vb.)
 * girip çıkma davranışını yönetir.
 */

import Phaser from 'phaser';
import {
  ForestSystem,
  TreeResourceNode,
  WoodHarvestResult,
} from './forestSystem';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';
import {
  CarriedResourceSummary,
  GarrisonableUnit,
  UnitCategory,
  UnitNutritionState,
} from './unitTypes';
import { WoodDepot } from './woodDepot';

export const VILLAGER_TEXTURE_KEY = 'villager_karahanli';
export const VILLAGER_ASSET_PATH = 'assets/sprites/villager_karahanli.png';
export const VILLAGER_FRAME_WIDTH = 160;
export const VILLAGER_FRAME_HEIGHT = 152;

/** Köylünün tek seferde taşıyabileceği maksimum odun kapasitesi */
export const DEFAULT_WOOD_CAPACITY = 20;

/** Köylü temel istatistikleri */
export const VILLAGER_DEFAULT_MAX_HP = 60;
export const VILLAGER_DEFAULT_ATTACK = 3;
export const VILLAGER_DEFAULT_DEFENSE = 0;
export const VILLAGER_DEFAULT_MAX_SATIETY = 100;

/** Bir balta darbesiyle 1 odun toplama süresi (ms) */
const CHOP_INTERVAL_MS = 800;

const ANIM_WALK_FRONT = 'karahanli_villager_walk_front';
const ANIM_WALK_BACK = 'karahanli_villager_walk_back';
const ANIM_CHOP_FRONT = 'karahanli_villager_chop_front';
const ANIM_CHOP_BACK = 'karahanli_villager_chop_back';

const ORIGIN_X = 80 / VILLAGER_FRAME_WIDTH;
const ORIGIN_Y = 132 / VILLAGER_FRAME_HEIGHT;

const DEFAULT_SCALE = 0.37;
const DEFAULT_MOVE_SPEED = 1.95;

const BASE_WALK_FPS = 8.5;
const CHOP_ANIM_FPS = 5;

export type VillagerState =
  | 'idle'
  | 'walking'
  | 'chopping'
  | 'returning_to_depot'
  | 'entering_building'
  | 'garrisoned';

export interface VillagerConfig {
  id: string;
  displayName?: string;
  col: number;
  row: number;
  moveSpeed?: number;
  scale?: number;
  maxWoodCapacity?: number;
  maxHp?: number;
  initialHp?: number;
  attackDamage?: number;
  defenseArmor?: number;
  initialFacingBack?: boolean;
  initialFacingLeft?: boolean;
}

export type WoodHarvestCallback = (
  villager: Villager,
  result: WoodHarvestResult
) => void;

export type WoodDepositCallback = (
  villager: Villager,
  depositedAmount: number,
  totalStoredWood: number
) => void;

export interface VillagerWorldContext {
  forestSystem: ForestSystem;
  woodDepot: WoodDepot;
  planPathToTree: (villager: Villager, tree: TreeResourceNode) => GridCoord[];
  planPathToDepot: (villager: Villager) => GridCoord[];
  canEnterBuildingNow: (villager: Villager, buildingId: string) => boolean;
  completeEnterBuilding: (villager: Villager, buildingId: string) => boolean;
  isFoodEconomyActive?: () => boolean;
  onWoodHarvested?: WoodHarvestCallback;
  onWoodDeposited?: WoodDepositCallback;
}

export class Villager implements GarrisonableUnit {
  public readonly id: string;
  public readonly displayName: string;
  public readonly unitCategory: UnitCategory = 'villager';
  public readonly unitTypeLabel = 'Karahanlı Köylüsü';

  private readonly isoGrid: IsoGrid;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly selectionRing: Phaser.GameObjects.Graphics;
  private readonly unitScale: number;
  private readonly maxWoodCapacity: number;

  private readonly maxHp: number;
  private hp: number;
  private readonly attackDamage: number;
  private readonly defenseArmor: number;
  private readonly maxSatiety = VILLAGER_DEFAULT_MAX_SATIETY;
  private satiety = VILLAGER_DEFAULT_MAX_SATIETY;
  private foodEconomyActive = false;

  private gridPos: GridCoord;
  private worldPos: { x: number; y: number };
  private moveSpeed: number;
  private selected = false;
  private state: VillagerState = 'idle';
  private targetGridPos: GridCoord | null = null;
  private pathQueue: GridCoord[] = [];
  private facingBack: boolean;
  private facingLeft: boolean;

  /** Kaynak taşıma ve ağaç hedef durumu */
  private carriedWood = 0;
  private assignedTreeId: string | null = null;
  private chopTimerMs = 0;

  /** Garnizon ve komutan-grup bağlantısı durumu */
  private pendingBuildingId: string | null = null;
  private pendingBuildingName: string | null = null;
  private garrisonBuildingId: string | null = null;
  private garrisonBuildingName: string | null = null;
  private commanderId: string | null = null;
  private readonly attachedSubordinateIds = new Set<string>();

  /** Çoklu hareket sırasında hedef yakınında sıkışmayı önleyen varış sayacı */
  private nearGoalCrowdedMs = 0;
  private wasSeparatedLastStep = false;

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid, config: VillagerConfig) {
    this.id = config.id;
    this.displayName = config.displayName ?? config.id;
    this.isoGrid = isoGrid;
    this.gridPos = { col: config.col, row: config.row };
    this.worldPos = isoGrid.tileToWorld(config.col, config.row);
    this.moveSpeed = config.moveSpeed ?? DEFAULT_MOVE_SPEED;
    this.unitScale = config.scale ?? DEFAULT_SCALE;
    this.maxWoodCapacity = config.maxWoodCapacity ?? DEFAULT_WOOD_CAPACITY;
    this.maxHp = config.maxHp ?? VILLAGER_DEFAULT_MAX_HP;
    this.hp = Phaser.Math.Clamp(
      config.initialHp ?? this.maxHp,
      1,
      this.maxHp
    );
    this.attackDamage = config.attackDamage ?? VILLAGER_DEFAULT_ATTACK;
    this.defenseArmor = config.defenseArmor ?? VILLAGER_DEFAULT_DEFENSE;
    this.facingBack = config.initialFacingBack ?? false;
    this.facingLeft = config.initialFacingLeft ?? false;

    this.selectionRing = scene.add.graphics();
    this.drawSelectionRing();
    this.selectionRing.setVisible(false);

    this.sprite = scene.add.sprite(
      this.worldPos.x,
      this.worldPos.y,
      VILLAGER_TEXTURE_KEY,
      this.facingBack ? 4 : 0
    );
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(this.unitScale);
    this.sprite.setFlipX(this.facingLeft);

    this.syncVisualTransform();
  }

  public static preload(scene: Phaser.Scene): void {
    scene.load.spritesheet(VILLAGER_TEXTURE_KEY, VILLAGER_ASSET_PATH, {
      frameWidth: VILLAGER_FRAME_WIDTH,
      frameHeight: VILLAGER_FRAME_HEIGHT,
    });
  }

  public static ensureAnimations(scene: Phaser.Scene): void {
    if (!scene.anims.exists(ANIM_WALK_FRONT)) {
      scene.anims.create({
        key: ANIM_WALK_FRONT,
        frames: scene.anims.generateFrameNumbers(VILLAGER_TEXTURE_KEY, {
          frames: [1, 2, 3, 0],
        }),
        frameRate: BASE_WALK_FPS,
        repeat: -1,
      });
    }

    if (!scene.anims.exists(ANIM_WALK_BACK)) {
      scene.anims.create({
        key: ANIM_WALK_BACK,
        frames: scene.anims.generateFrameNumbers(VILLAGER_TEXTURE_KEY, {
          frames: [5, 6, 7, 4],
        }),
        frameRate: BASE_WALK_FPS,
        repeat: -1,
      });
    }

    if (!scene.anims.exists(ANIM_CHOP_FRONT)) {
      scene.anims.create({
        key: ANIM_CHOP_FRONT,
        frames: scene.anims.generateFrameNumbers(VILLAGER_TEXTURE_KEY, {
          frames: [8, 9, 10, 11],
        }),
        frameRate: CHOP_ANIM_FPS,
        repeat: -1,
      });
    }

    if (!scene.anims.exists(ANIM_CHOP_BACK)) {
      scene.anims.create({
        key: ANIM_CHOP_BACK,
        frames: scene.anims.generateFrameNumbers(VILLAGER_TEXTURE_KEY, {
          frames: [12, 13, 14, 15],
        }),
        frameRate: CHOP_ANIM_FPS,
        repeat: -1,
      });
    }
  }

  // --- Can, Saldırı, Savunma ve Açlık Veri Modelleri ---

  public getHp(): number {
    return this.hp;
  }

  public getMaxHp(): number {
    return this.maxHp;
  }

  public heal(amount: number): number {
    if (amount <= 0 || this.hp >= this.maxHp) {
      return 0;
    }
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - before;
  }

  public takeDamage(amount: number): number {
    if (amount <= 0) {
      return 0;
    }
    const reduced = Math.max(1, amount - this.defenseArmor);
    const before = this.hp;
    this.hp = Math.max(0, this.hp - reduced);
    return before - this.hp;
  }

  public getAttackDamage(): number {
    return this.attackDamage;
  }

  public getDefenseArmor(): number {
    return this.defenseArmor;
  }

  public isCombatSystemActive(): boolean {
    return false;
  }

  public getNutritionState(): UnitNutritionState {
    return {
      satiety: this.satiety,
      maxSatiety: this.maxSatiety,
      foodEconomyActive: this.foodEconomyActive,
      statusText: this.foodEconomyActive
        ? `Tok (%${Math.round((this.satiety / this.maxSatiety) * 100)})`
        : `Doygun ${this.satiety}/${this.maxSatiety} (Erzak sistemi yakında)`,
    };
  }

  public restoreSatiety(amount: number): number {
    if (amount <= 0 || this.satiety >= this.maxSatiety) {
      return 0;
    }
    const before = this.satiety;
    this.satiety = Math.min(this.maxSatiety, this.satiety + amount);
    return this.satiety - before;
  }

  public getCarriedResourceSummary(): CarriedResourceSummary {
    return {
      resourceType: this.carriedWood > 0 ? 'wood' : null,
      resourceLabel: 'Odun',
      amount: this.carriedWood,
      maxCapacity: this.maxWoodCapacity,
    };
  }

  public getTaskDescription(
    resolveTreeLabel?: (treeId: string) => string | null
  ): string {
    if (this.state === 'garrisoned') {
      return `Binada (${this.garrisonBuildingName ?? 'Town Hall'})`;
    }
    if (this.state === 'entering_building') {
      return `Binaya Giriyor (${this.pendingBuildingName ?? 'Town Hall'})`;
    }
    if (this.state === 'chopping') {
      const treeInfo =
        this.assignedTreeId && resolveTreeLabel
          ? resolveTreeLabel(this.assignedTreeId)
          : null;
      return treeInfo ? `Odun Topluyor (${treeInfo})` : 'Odun Topluyor';
    }
    if (this.state === 'returning_to_depot') {
      return 'Depoya Odun Götürüyor';
    }
    if (this.state === 'walking') {
      if (this.assignedTreeId) {
        const treeInfo = resolveTreeLabel
          ? resolveTreeLabel(this.assignedTreeId)
          : null;
        return treeInfo ? `Ağaca Yürüyor (${treeInfo})` : 'Ağaca Yürüyor';
      }
      return 'Yürüyor';
    }
    return 'Bekliyor';
  }

  // --- Komutan ve Bağlı Birlik (Retinue) Altyapısı ---

  public getCommanderId(): string | null {
    return this.commanderId;
  }

  public setCommanderId(commanderId: string | null): void {
    this.commanderId = commanderId;
  }

  public getAttachedUnitIds(): readonly string[] {
    return Array.from(this.attachedSubordinateIds);
  }

  public attachSubordinateUnit(unitId: string): void {
    if (unitId !== this.id) {
      this.attachedSubordinateIds.add(unitId);
    }
  }

  public detachSubordinateUnit(unitId: string): void {
    this.attachedSubordinateIds.delete(unitId);
  }

  // --- Garnizon Durum ve Yaşam Döngüsü ---

  public isGarrisoned(): boolean {
    return this.state === 'garrisoned' && this.garrisonBuildingId !== null;
  }

  public getGarrisonBuildingId(): string | null {
    return this.garrisonBuildingId;
  }

  public onEnterGarrison(buildingId: string, buildingName: string): void {
    this.garrisonBuildingId = buildingId;
    this.garrisonBuildingName = buildingName;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.assignedTreeId = null;
    this.chopTimerMs = 0;
    this.pathQueue = [];
    this.targetGridPos = null;
    this.nearGoalCrowdedMs = 0;
    this.selected = false;
    this.state = 'garrisoned';

    this.sprite.anims.stop();
    this.selectionRing.setVisible(false);
    this.sprite.setVisible(false);
  }

  public onExitGarrison(exitSpot: GridCoord): void {
    this.garrisonBuildingId = null;
    this.garrisonBuildingName = null;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.assignedTreeId = null;
    this.chopTimerMs = 0;
    this.pathQueue = [];
    this.targetGridPos = null;
    this.nearGoalCrowdedMs = 0;

    this.gridPos.col = exitSpot.col;
    this.gridPos.row = exitSpot.row;
    this.facingBack = false;
    this.facingLeft = true;

    this.sprite.setVisible(true);
    this.enterIdlePose();
    this.syncVisualTransform();
  }

  // --- Seçim ve Hareket Kontrolleri ---

  public setSelected(value: boolean): void {
    if (this.isGarrisoned() && value) {
      return;
    }
    if (this.selected === value) {
      return;
    }
    this.selected = value;
    this.selectionRing.setVisible(value && !this.isGarrisoned());
  }

  public isSelected(): boolean {
    return this.selected && !this.isGarrisoned();
  }

  public isMoving(): boolean {
    return (
      this.state === 'walking' ||
      this.state === 'returning_to_depot' ||
      this.state === 'entering_building'
    );
  }

  public getGridPosition(): GridCoord {
    return { col: this.gridPos.col, row: this.gridPos.row };
  }

  public getWorldPosition(): { x: number; y: number } {
    return { x: this.worldPos.x, y: this.worldPos.y };
  }

  public getTargetPosition(): GridCoord | null {
    return this.targetGridPos
      ? { col: this.targetGridPos.col, row: this.targetGridPos.row }
      : null;
  }

  public getTargetTreeId(): string | null {
    return this.assignedTreeId;
  }

  public getCarriedWood(): number {
    return this.carriedWood;
  }

  public getMaxWoodCapacity(): number {
    return this.maxWoodCapacity;
  }

  public isCarryFull(): boolean {
    return this.carriedWood >= this.maxWoodCapacity;
  }

  public getMoveSpeed(): number {
    return this.moveSpeed;
  }

  public setMoveSpeed(speedTilesPerSec: number): void {
    this.moveSpeed = Math.max(0.2, speedTilesPerSec);
    if (this.isMoving()) {
      this.sprite.anims.timeScale = this.moveSpeed / DEFAULT_MOVE_SPEED;
    }
  }

  public getState(): VillagerState {
    return this.state;
  }

  public setMovePath(waypoints: GridCoord[]): void {
    if (this.isGarrisoned()) {
      return;
    }
    this.assignedTreeId = null;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.chopTimerMs = 0;
    this.nearGoalCrowdedMs = 0;

    if (waypoints.length === 0) {
      this.stopMovement();
      return;
    }

    this.assignPathQueue(waypoints, 'walking');
  }

  public setHarvestTreeOrder(
    treeId: string,
    approachWaypoints: GridCoord[],
    context: VillagerWorldContext
  ): void {
    if (this.isGarrisoned()) {
      return;
    }
    this.assignedTreeId = treeId;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.chopTimerMs = 0;
    this.nearGoalCrowdedMs = 0;

    if (this.isCarryFull()) {
      this.startReturnToDepot(context);
      return;
    }

    if (approachWaypoints.length > 0) {
      this.assignPathQueue(approachWaypoints, 'walking');
      return;
    }

    this.pathQueue = [];
    this.targetGridPos = null;
    this.beginChoppingIfPossible(context);
  }

  public setDeliverToDepotOrder(
    context: VillagerWorldContext,
    customWaypoints?: GridCoord[]
  ): void {
    if (this.isGarrisoned()) {
      return;
    }
    this.assignedTreeId = null;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.chopTimerMs = 0;
    this.nearGoalCrowdedMs = 0;

    if (this.carriedWood <= 0) {
      const depotWaypoints = customWaypoints ?? context.planPathToDepot(this);
      if (depotWaypoints.length > 0) {
        this.assignPathQueue(depotWaypoints, 'walking');
      } else {
        this.stopMovement();
      }
      return;
    }

    this.startReturnToDepot(context, customWaypoints);
  }

  /**
   * Birime belirtilen garnizon binasına (ör. Town Hall) yürüyüp girişe ulaştığında
   * içeri girme emri verir.
   */
  public setEnterBuildingOrder(
    buildingId: string,
    buildingName: string,
    approachWaypoints: GridCoord[],
    context: VillagerWorldContext
  ): void {
    if (this.isGarrisoned()) {
      return;
    }

    this.assignedTreeId = null;
    this.chopTimerMs = 0;
    this.nearGoalCrowdedMs = 0;
    this.pendingBuildingId = buildingId;
    this.pendingBuildingName = buildingName;

    if (context.canEnterBuildingNow(this, buildingId)) {
      context.completeEnterBuilding(this, buildingId);
      return;
    }

    if (approachWaypoints.length > 0) {
      this.assignPathQueue(approachWaypoints, 'entering_building');
      return;
    }

    if (!context.completeEnterBuilding(this, buildingId)) {
      this.stopMovement();
    }
  }

  public stopMovement(): void {
    if (this.isGarrisoned()) {
      return;
    }
    this.pathQueue = [];
    this.targetGridPos = null;
    this.assignedTreeId = null;
    this.pendingBuildingId = null;
    this.pendingBuildingName = null;
    this.chopTimerMs = 0;
    this.nearGoalCrowdedMs = 0;
    this.enterIdlePose();
  }

  public update(deltaMs: number, context: VillagerWorldContext): void {
    this.foodEconomyActive = context.isFoodEconomyActive?.() ?? false;

    if (this.isGarrisoned()) {
      // Bina içindeki birim kaynak toplamaz ve haritada hareket etmez
      this.wasSeparatedLastStep = false;
      return;
    }

    if (
      this.state === 'walking' ||
      this.state === 'returning_to_depot' ||
      this.state === 'entering_building'
    ) {
      this.updatePathMovement(deltaMs, context);
      this.wasSeparatedLastStep = false;
      return;
    }

    this.wasSeparatedLastStep = false;
    if (this.state === 'chopping') {
      this.updateChopping(deltaMs, context);
    }
  }

  public applySeparationOffset(
    dCol: number,
    dRow: number,
    isWalkablePos: (col: number, row: number) => boolean
  ): boolean {
    if (this.isGarrisoned()) {
      return false;
    }
    if (Math.abs(dCol) < 0.0001 && Math.abs(dRow) < 0.0001) {
      return false;
    }

    const fullCol = this.gridPos.col + dCol;
    const fullRow = this.gridPos.row + dRow;

    if (isWalkablePos(fullCol, fullRow)) {
      this.gridPos.col = fullCol;
      this.gridPos.row = fullRow;
      this.wasSeparatedLastStep = true;
      this.syncVisualTransform();
      return true;
    }

    if (Math.abs(dCol) > 0.0001 && isWalkablePos(fullCol, this.gridPos.row)) {
      this.gridPos.col = fullCol;
      this.wasSeparatedLastStep = true;
      this.syncVisualTransform();
      return true;
    }

    if (Math.abs(dRow) > 0.0001 && isWalkablePos(this.gridPos.col, fullRow)) {
      this.gridPos.row = fullRow;
      this.wasSeparatedLastStep = true;
      this.syncVisualTransform();
      return true;
    }

    return false;
  }

  public containsWorldPoint(
    worldX: number,
    worldY: number,
    isTouch = false
  ): boolean {
    if (this.isGarrisoned()) {
      return false;
    }

    const visualHalfW = Math.round(18 * this.unitScale);
    const visualHeight = Math.round(92 * this.unitScale);

    const padX = isTouch ? 14 : 7;
    const padTop = isTouch ? 12 : 6;
    const padBottom = isTouch ? 10 : 6;

    return (
      worldX >= this.worldPos.x - (visualHalfW + padX) &&
      worldX <= this.worldPos.x + (visualHalfW + padX) &&
      worldY >= this.worldPos.y - (visualHeight + padTop) &&
      worldY <= this.worldPos.y + padBottom
    );
  }

  public intersectsWorldRect(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): boolean {
    if (this.isGarrisoned()) {
      return false;
    }

    const halfW = 16 * this.unitScale;
    const bodyHeight = 88 * this.unitScale;

    const unitLeft = this.worldPos.x - halfW;
    const unitRight = this.worldPos.x + halfW;
    const unitTop = this.worldPos.y - bodyHeight;
    const unitBottom = this.worldPos.y + 4;

    return (
      unitRight >= minX &&
      unitLeft <= maxX &&
      unitBottom >= minY &&
      unitTop <= maxY
    );
  }

  public distanceToBodyCenter(worldX: number, worldY: number): number {
    const bodyCenterY = this.worldPos.y - 46 * this.unitScale;
    return Math.hypot(worldX - this.worldPos.x, worldY - bodyCenterY);
  }

  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore([this.selectionRing, this.sprite]);
  }

  public syncVisualTransform(): void {
    this.worldPos = this.isoGrid.tileToWorld(this.gridPos.col, this.gridPos.row);
    const depth = this.isoGrid.getTileDepth(this.gridPos.col, this.gridPos.row);

    this.sprite.setPosition(this.worldPos.x, this.worldPos.y);
    this.sprite.setDepth(depth);

    this.selectionRing.setPosition(this.worldPos.x, this.worldPos.y);
    this.selectionRing.setDepth(depth - 0.05);
  }

  public destroy(): void {
    this.selectionRing.destroy();
    this.sprite.destroy();
  }

  private assignPathQueue(
    waypoints: GridCoord[],
    moveState: 'walking' | 'returning_to_depot' | 'entering_building'
  ): void {
    this.pathQueue = waypoints.map((pt) => ({ col: pt.col, row: pt.row }));
    this.targetGridPos = {
      col: waypoints[waypoints.length - 1].col,
      row: waypoints[waypoints.length - 1].row,
    };
    this.nearGoalCrowdedMs = 0;
    this.state = moveState;
    this.updateWalkingFacing(waypoints[0]);
  }

  private enterIdlePose(): void {
    this.state = 'idle';
    this.sprite.anims.stop();
    this.sprite.anims.timeScale = 1;
    this.sprite.setFrame(this.facingBack ? 4 : 0);
    this.sprite.setFlipX(this.facingLeft);
  }

  private updatePathMovement(
    deltaMs: number,
    context: VillagerWorldContext
  ): void {
    const arrivingState = this.state;

    if (this.pathQueue.length > 0) {
      let remainingStep = this.moveSpeed * (deltaMs / 1000);

      while (remainingStep > 0 && this.pathQueue.length > 0) {
        const nextWaypoint = this.pathQueue[0];
        const dc = nextWaypoint.col - this.gridPos.col;
        const dr = nextWaypoint.row - this.gridPos.row;
        const dist = Math.hypot(dc, dr);

        if (dist <= 0.002) {
          this.gridPos.col = nextWaypoint.col;
          this.gridPos.row = nextWaypoint.row;
          this.pathQueue.shift();
          if (this.pathQueue.length > 0) {
            this.updateWalkingFacing(this.pathQueue[0]);
          }
          continue;
        }

        this.updateWalkingFacing(nextWaypoint);

        if (remainingStep >= dist) {
          this.gridPos.col = nextWaypoint.col;
          this.gridPos.row = nextWaypoint.row;
          remainingStep -= dist;
          this.pathQueue.shift();
          if (this.pathQueue.length > 0) {
            this.updateWalkingFacing(this.pathQueue[0]);
          }
        } else {
          const ratio = remainingStep / dist;
          this.gridPos.col += dc * ratio;
          this.gridPos.row += dr * ratio;
          remainingStep = 0;
        }
      }

      // Binaya girme emriyle yürürken son basamaklara ulaştıysa doğrudan içeri al
      if (
        arrivingState === 'entering_building' &&
        this.pendingBuildingId &&
        this.pathQueue.length <= 1 &&
        context.canEnterBuildingNow(this, this.pendingBuildingId)
      ) {
        this.syncVisualTransform();
        context.completeEnterBuilding(this, this.pendingBuildingId);
        return;
      }

      if (this.pathQueue.length === 1) {
        const finalPt = this.pathQueue[0];
        const distToFinal = Math.hypot(
          finalPt.col - this.gridPos.col,
          finalPt.row - this.gridPos.row
        );
        if (distToFinal < 0.72 && this.wasSeparatedLastStep) {
          this.nearGoalCrowdedMs += deltaMs;
          if (this.nearGoalCrowdedMs >= 260) {
            this.pathQueue = [];
          }
        } else {
          this.nearGoalCrowdedMs = Math.max(0, this.nearGoalCrowdedMs - deltaMs);
        }
      }

      this.syncVisualTransform();
    }

    if (this.pathQueue.length === 0) {
      this.targetGridPos = null;
      this.nearGoalCrowdedMs = 0;

      if (arrivingState === 'entering_building' && this.pendingBuildingId) {
        const bid = this.pendingBuildingId;
        if (!context.completeEnterBuilding(this, bid)) {
          this.stopMovement();
        }
      } else if (arrivingState === 'returning_to_depot') {
        this.completeDepotDeliveryAndResume(context);
      } else if (this.assignedTreeId) {
        this.beginChoppingIfPossible(context);
      } else {
        this.stopMovement();
      }
    }
  }

  private beginChoppingIfPossible(context: VillagerWorldContext): void {
    if (!this.assignedTreeId) {
      this.stopMovement();
      return;
    }

    if (this.isCarryFull()) {
      this.startReturnToDepot(context);
      return;
    }

    const tree = context.forestSystem.getTree(this.assignedTreeId);
    if (!tree || tree.woodAmount <= 0) {
      if (this.carriedWood > 0) {
        this.assignedTreeId = null;
        this.startReturnToDepot(context);
      } else {
        this.stopMovement();
      }
      return;
    }

    const treeWorld = this.isoGrid.tileToWorld(tree.tile.col, tree.tile.row);
    this.orientTowardWorldPoint(treeWorld.x, treeWorld.y);

    this.state = 'chopping';
    this.chopTimerMs = CHOP_INTERVAL_MS * 0.5;
    this.playChopAnimation();
  }

  private updateChopping(
    deltaMs: number,
    context: VillagerWorldContext
  ): void {
    if (!this.assignedTreeId) {
      this.stopMovement();
      return;
    }

    if (this.isCarryFull()) {
      this.startReturnToDepot(context);
      return;
    }

    const tree = context.forestSystem.getTree(this.assignedTreeId);
    if (!tree || tree.woodAmount <= 0) {
      if (this.carriedWood > 0) {
        this.assignedTreeId = null;
        this.startReturnToDepot(context);
      } else {
        this.stopMovement();
      }
      return;
    }

    const treeWorld = this.isoGrid.tileToWorld(tree.tile.col, tree.tile.row);
    this.orientTowardWorldPoint(treeWorld.x, treeWorld.y);
    this.playChopAnimation();

    this.chopTimerMs += deltaMs;

    while (this.chopTimerMs >= CHOP_INTERVAL_MS) {
      this.chopTimerMs -= CHOP_INTERVAL_MS;

      const freeSpace = this.maxWoodCapacity - this.carriedWood;
      if (freeSpace <= 0) {
        this.startReturnToDepot(context);
        return;
      }

      const result = context.forestSystem.harvestWood(
        this.assignedTreeId,
        Math.min(1, freeSpace)
      );

      if (result.harvested > 0) {
        this.carriedWood += result.harvested;
        context.onWoodHarvested?.(this, result);
      }

      if (this.isCarryFull()) {
        if (result.depleted) {
          this.assignedTreeId = null;
        }
        this.startReturnToDepot(context);
        return;
      }

      if (result.depleted) {
        this.assignedTreeId = null;
        if (this.carriedWood > 0) {
          this.startReturnToDepot(context);
        } else {
          this.stopMovement();
        }
        return;
      }
    }
  }

  private startReturnToDepot(
    context: VillagerWorldContext,
    customWaypoints?: GridCoord[]
  ): void {
    this.chopTimerMs = 0;
    const depotTile = context.woodDepot.getTile();
    const distToDepot = Math.hypot(
      this.gridPos.col - depotTile.col,
      this.gridPos.row - depotTile.row
    );

    if (distToDepot >= 0.72 && distToDepot <= 1.24) {
      this.pathQueue = [];
      this.targetGridPos = null;
      this.completeDepotDeliveryAndResume(context);
      return;
    }

    const waypoints = customWaypoints ?? context.planPathToDepot(this);
    if (waypoints.length > 0) {
      this.assignPathQueue(waypoints, 'returning_to_depot');
    } else {
      this.completeDepotDeliveryAndResume(context);
    }
  }

  private completeDepotDeliveryAndResume(context: VillagerWorldContext): void {
    const depotWorld = context.woodDepot.getWorldPosition();
    this.orientTowardWorldPoint(depotWorld.x, depotWorld.y);

    if (this.carriedWood > 0) {
      const delivered = this.carriedWood;
      this.carriedWood = 0;
      const totalStored = context.woodDepot.depositWood(delivered);
      context.onWoodDeposited?.(this, delivered, totalStored);
    }

    if (this.assignedTreeId) {
      const tree = context.forestSystem.getTree(this.assignedTreeId);
      if (tree && tree.woodAmount > 0) {
        const backToTree = context.planPathToTree(this, tree);
        if (backToTree.length > 0) {
          this.assignPathQueue(backToTree, 'walking');
          return;
        }
        this.beginChoppingIfPossible(context);
        return;
      }
    }

    this.stopMovement();
  }

  private orientTowardWorldPoint(targetX: number, targetY: number): void {
    const vx = targetX - this.worldPos.x;
    const vy = targetY - this.worldPos.y;

    if (Math.abs(vx) > 0.25) {
      this.facingLeft = vx < 0;
    }
    if (Math.abs(vy) > 0.25) {
      this.facingBack = vy < -0.15;
    }

    this.sprite.setFlipX(this.facingLeft);
  }

  private updateWalkingFacing(nextTarget: GridCoord): void {
    const nextWorld = this.isoGrid.tileToWorld(nextTarget.col, nextTarget.row);
    this.orientTowardWorldPoint(nextWorld.x, nextWorld.y);
    this.sprite.anims.timeScale = this.moveSpeed / DEFAULT_MOVE_SPEED;

    const desiredAnim = this.facingBack ? ANIM_WALK_BACK : ANIM_WALK_FRONT;
    if (
      this.sprite.anims.currentAnim?.key !== desiredAnim ||
      !this.sprite.anims.isPlaying
    ) {
      this.sprite.play(desiredAnim, true);
    }
  }

  private playChopAnimation(): void {
    this.sprite.anims.timeScale = 1;
    const desiredAnim = this.facingBack ? ANIM_CHOP_BACK : ANIM_CHOP_FRONT;
    if (
      this.sprite.anims.currentAnim?.key !== desiredAnim ||
      !this.sprite.anims.isPlaying
    ) {
      this.sprite.play(desiredAnim, true);
    }
  }

  private drawSelectionRing(): void {
    this.selectionRing.clear();
    const ringW = Math.max(18, Math.round(60 * this.unitScale));
    const ringH = Math.max(9, Math.round(30 * this.unitScale));

    this.selectionRing.fillStyle(0x22c55e, 0.15);
    this.selectionRing.fillEllipse(0, 0, ringW, ringH);
    this.selectionRing.lineStyle(1.4, 0x4ade80, 0.95);
    this.selectionRing.strokeEllipse(0, 0, ringW, ringH);
  }
}
