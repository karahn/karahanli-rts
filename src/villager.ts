/**
 * Karahanlı RTS — Köylü Birim Sınıfı (Villager)
 *
 * Tarihî Karahanlı dönemine uygun erkek köylü biriminin konum, hareket hızı,
 * seçim durumu, yönlü yürüyüş animasyonu, balta sallayarak odun toplama (20 kapasite),
 * dolunca ortak odun deposuna yürüme, odunu teslim edip tekrar ağaca dönme döngüsünü
 * ve izometrik derinlik sıralamasını bağımsız olarak yönetir.
 */

import Phaser from 'phaser';
import {
  ForestSystem,
  TreeResourceNode,
  WoodHarvestResult,
} from './forestSystem';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';
import { WoodDepot } from './woodDepot';

export const VILLAGER_TEXTURE_KEY = 'villager_karahanli';
export const VILLAGER_ASSET_PATH = 'assets/sprites/villager_karahanli.png';
export const VILLAGER_FRAME_WIDTH = 160;
export const VILLAGER_FRAME_HEIGHT = 152;

/** Köylünün tek seferde taşıyabileceği maksimum odun kapasitesi */
export const DEFAULT_WOOD_CAPACITY = 20;

/** Bir balta darbesiyle 1 odun toplama süresi (ms) — 4 kare / 5 FPS = 800ms ile tam senkron */
const CHOP_INTERVAL_MS = 800;

const ANIM_WALK_FRONT = 'karahanli_villager_walk_front';
const ANIM_WALK_BACK = 'karahanli_villager_walk_back';
const ANIM_CHOP_FRONT = 'karahanli_villager_chop_front';
const ANIM_CHOP_BACK = 'karahanli_villager_chop_back';

const ORIGIN_X = 80 / VILLAGER_FRAME_WIDTH;
/** Her iki çizme tabanının çimen yüzeyine tam bastığı dikey referans noktası */
const ORIGIN_Y = 132 / VILLAGER_FRAME_HEIGHT;

/** Ağaçlarla gerçekçi orantıda köylü görsel ölçeği (~34 dünya px boy) */
const DEFAULT_SCALE = 0.37;

/** Adım açıklığıyla kayma olmadan örtüşen doğal yürüyüş hızı (karo/sn) */
const DEFAULT_MOVE_SPEED = 1.95;

const BASE_WALK_FPS = 8.5;
const CHOP_ANIM_FPS = 5;

export type VillagerState =
  | 'idle'
  | 'walking'
  | 'chopping'
  | 'returning_to_depot';

export interface VillagerConfig {
  id: string;
  displayName?: string;
  col: number;
  row: number;
  moveSpeed?: number;
  scale?: number;
  maxWoodCapacity?: number;
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
  onWoodHarvested?: WoodHarvestCallback;
  onWoodDeposited?: WoodDepositCallback;
}

export class Villager {
  public readonly id: string;
  public readonly displayName: string;
  private readonly isoGrid: IsoGrid;
  private readonly sprite: Phaser.GameObjects.Sprite;
  private readonly selectionRing: Phaser.GameObjects.Graphics;
  private readonly unitScale: number;
  private readonly maxWoodCapacity: number;

  private gridPos: GridCoord;
  private worldPos: { x: number; y: number };
  private moveSpeed: number;
  private selected = false;
  private state: VillagerState = 'idle';
  private targetGridPos: GridCoord | null = null;
  private pathQueue: GridCoord[] = [];
  private facingBack: boolean;
  private facingLeft: boolean;

  /** Her köylünün kendi bağımsız odun taşıma ve hedef ağaç durumu */
  private carriedWood = 0;
  private assignedTreeId: string | null = null;
  private chopTimerMs = 0;

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid, config: VillagerConfig) {
    this.id = config.id;
    this.displayName = config.displayName ?? config.id;
    this.isoGrid = isoGrid;
    this.gridPos = { col: config.col, row: config.row };
    this.worldPos = isoGrid.tileToWorld(config.col, config.row);
    this.moveSpeed = config.moveSpeed ?? DEFAULT_MOVE_SPEED;
    this.unitScale = config.scale ?? DEFAULT_SCALE;
    this.maxWoodCapacity = config.maxWoodCapacity ?? DEFAULT_WOOD_CAPACITY;
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

  public setSelected(value: boolean): void {
    if (this.selected === value) {
      return;
    }
    this.selected = value;
    this.selectionRing.setVisible(value);
  }

  public isSelected(): boolean {
    return this.selected;
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
    if (this.state === 'walking' || this.state === 'returning_to_depot') {
      this.sprite.anims.timeScale = this.moveSpeed / DEFAULT_MOVE_SPEED;
    }
  }

  public getState(): VillagerState {
    return this.state;
  }

  /**
   * Köylüye normal bir yürüyüş rotası atar.
   * Sadece bu köylünün aktif odun toplama veya depoya dönüş döngüsü iptal edilir.
   */
  public setMovePath(waypoints: GridCoord[]): void {
    this.assignedTreeId = null;
    this.chopTimerMs = 0;

    if (waypoints.length === 0) {
      this.stopMovement();
      return;
    }

    this.assignPathQueue(waypoints, 'walking');
  }

  /**
   * Köylüye belirtilen ağaca yürüyüp odun toplama (ve 20 doldukça ortak depoya taşıma) emri verir.
   */
  public setHarvestTreeOrder(
    treeId: string,
    approachWaypoints: GridCoord[],
    context: VillagerWorldContext
  ): void {
    this.assignedTreeId = treeId;
    this.chopTimerMs = 0;

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

  /**
   * Köylüye elindeki mevcut odunu doğrudan ortak depoya götürüp bırakma emri verir.
   */
  public setDeliverToDepotOrder(context: VillagerWorldContext): void {
    this.assignedTreeId = null;
    this.chopTimerMs = 0;

    if (this.carriedWood <= 0) {
      const depotWaypoints = context.planPathToDepot(this);
      if (depotWaypoints.length > 0) {
        this.assignPathQueue(depotWaypoints, 'walking');
      } else {
        this.stopMovement();
      }
      return;
    }

    this.startReturnToDepot(context);
  }

  public stopMovement(): void {
    this.pathQueue = [];
    this.targetGridPos = null;
    this.assignedTreeId = null;
    this.chopTimerMs = 0;
    this.enterIdlePose();
  }

  public update(deltaMs: number, context: VillagerWorldContext): void {
    if (this.state === 'walking' || this.state === 'returning_to_depot') {
      this.updatePathMovement(deltaMs, context);
      return;
    }

    if (this.state === 'chopping') {
      this.updateChopping(deltaMs, context);
    }
  }

  public containsWorldPoint(
    worldX: number,
    worldY: number,
    isTouch = false
  ): boolean {
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

  /**
   * Tıklanan/dokunulan noktanın bu köylünün görsel gövde merkezine olan uzaklığını döndürür.
   * Yakın duran birden fazla köylü arasında en doğru seçimi yapmak için kullanılır.
   */
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
    moveState: 'walking' | 'returning_to_depot'
  ): void {
    this.pathQueue = waypoints.map((pt) => ({ col: pt.col, row: pt.row }));
    this.targetGridPos = {
      col: waypoints[waypoints.length - 1].col,
      row: waypoints[waypoints.length - 1].row,
    };
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

        if (dist <= 0.0005) {
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

      this.syncVisualTransform();
    }

    if (this.pathQueue.length === 0) {
      this.targetGridPos = null;

      if (arrivingState === 'returning_to_depot') {
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

  private startReturnToDepot(context: VillagerWorldContext): void {
    this.chopTimerMs = 0;
    const depotTile = context.woodDepot.getTile();
    const distToDepot = Math.hypot(
      this.gridPos.col - depotTile.col,
      this.gridPos.row - depotTile.row
    );

    if (distToDepot >= 0.74 && distToDepot <= 1.08) {
      this.pathQueue = [];
      this.targetGridPos = null;
      this.completeDepotDeliveryAndResume(context);
      return;
    }

    const waypoints = context.planPathToDepot(this);
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
