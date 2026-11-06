/**
 * Karahanlı RTS — Köylü Birim Sınıfı (Villager)
 *
 * Tarihî Karahanlı dönemine uygun erkek köylü biriminin konum, hareket hızı,
 * seçim durumu, hedef koordinatı, yönlü yürüyüş animasyonu, balta sallayarak
 * odun toplama döngüsü (20 odun taşıma kapasitesi) ve izometrik derinlik
 * sıralamasını yönetir.
 */

import Phaser from 'phaser';
import { ForestSystem, WoodHarvestResult } from './forestSystem';
import { IsoGrid } from './isoGrid';
import { GridCoord } from './pathfinding';

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

/** Ağaçlarla (kayın ~0.54, çam ~0.60) gerçekçi orantıda köylü görsel ölçeği (~34 dünya px boy) */
const DEFAULT_SCALE = 0.37;

/** Yeni ölçekteki adım açıklığıyla kayma olmadan örtüşen doğal yürüyüş hızı (karo/sn) */
const DEFAULT_MOVE_SPEED = 1.95;

/** Temel yürüyüş animasyonu kare hızı (FPS) */
const BASE_WALK_FPS = 8.5;

/** Balta sallama animasyonu kare hızı (FPS) */
const CHOP_ANIM_FPS = 5;

export type VillagerState = 'idle' | 'walking' | 'chopping';

export interface VillagerConfig {
  id: string;
  col: number;
  row: number;
  moveSpeed?: number;
  scale?: number;
  maxWoodCapacity?: number;
}

export type WoodHarvestCallback = (
  villager: Villager,
  result: WoodHarvestResult
) => void;

export class Villager {
  public readonly id: string;
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
  private facingBack = false;
  private facingLeft = false;

  /** Odun toplama ve taşıma durumu */
  private carriedWood = 0;
  private targetTreeId: string | null = null;
  private chopTimerMs = 0;

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid, config: VillagerConfig) {
    this.id = config.id;
    this.isoGrid = isoGrid;
    this.gridPos = { col: config.col, row: config.row };
    this.worldPos = isoGrid.tileToWorld(config.col, config.row);
    this.moveSpeed = config.moveSpeed ?? DEFAULT_MOVE_SPEED;
    this.unitScale = config.scale ?? DEFAULT_SCALE;
    this.maxWoodCapacity = config.maxWoodCapacity ?? DEFAULT_WOOD_CAPACITY;

    // Seçildiğinde ayaklarının altında beliren ince yeşil seçim halkası
    this.selectionRing = scene.add.graphics();
    this.drawSelectionRing();
    this.selectionRing.setVisible(false);

    // Tarihî Karahanlı köylü sprite'ı
    this.sprite = scene.add.sprite(
      this.worldPos.x,
      this.worldPos.y,
      VILLAGER_TEXTURE_KEY,
      0
    );
    this.sprite.setOrigin(ORIGIN_X, ORIGIN_Y);
    this.sprite.setScale(this.unitScale);

    this.syncVisualTransform();
  }

  /**
   * Köylü spritesheet görselini Phaser önbelleğine yükler.
   */
  public static preload(scene: Phaser.Scene): void {
    scene.load.spritesheet(VILLAGER_TEXTURE_KEY, VILLAGER_ASSET_PATH, {
      frameWidth: VILLAGER_FRAME_WIDTH,
      frameHeight: VILLAGER_FRAME_HEIGHT,
    });
  }

  /**
   * Ön-çapraz ve arka-çapraz yürüyüş ile balta sallama animasyonlarını kaydeder.
   */
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

  /** Seçim durumunu günceller ve yeşil seçim halkasını açar/kapatır. */
  public setSelected(value: boolean): void {
    if (this.selected === value) {
      return;
    }
    this.selected = value;
    this.selectionRing.setVisible(value);
  }

  /** Köylünün seçili olup olmadığını döndürür. */
  public isSelected(): boolean {
    return this.selected;
  }

  /** Mevcut ızgara koordinatının kopyasını döndürür. */
  public getGridPosition(): GridCoord {
    return { col: this.gridPos.col, row: this.gridPos.row };
  }

  /** Mevcut dünya piksel koordinatını döndürür. */
  public getWorldPosition(): { x: number; y: number } {
    return { x: this.worldPos.x, y: this.worldPos.y };
  }

  /** Aktif hedef ızgara koordinatını (yoksa null) döndürür. */
  public getTargetPosition(): GridCoord | null {
    return this.targetGridPos
      ? { col: this.targetGridPos.col, row: this.targetGridPos.row }
      : null;
  }

  /** Köylünün şu anda hedeflediği ağacın kimliğini (yoksa null) döndürür. */
  public getTargetTreeId(): string | null {
    return this.targetTreeId;
  }

  /** Köylünün üzerinde taşıdığı odun miktarını döndürür. */
  public getCarriedWood(): number {
    return this.carriedWood;
  }

  /** Köylünün maksimum odun taşıma kapasitesini (20) döndürür. */
  public getMaxWoodCapacity(): number {
    return this.maxWoodCapacity;
  }

  /** Köylünün odun taşıma kapasitesinin dolu olup olmadığını döndürür. */
  public isCarryFull(): boolean {
    return this.carriedWood >= this.maxWoodCapacity;
  }

  /** Köylünün hareket hızını (karo/sn) döndürür. */
  public getMoveSpeed(): number {
    return this.moveSpeed;
  }

  /** Köylünün hareket hızını (karo/sn) günceller ve adım temposunu senkronize eder. */
  public setMoveSpeed(speedTilesPerSec: number): void {
    this.moveSpeed = Math.max(0.2, speedTilesPerSec);
    if (this.state === 'walking') {
      this.sprite.anims.timeScale = this.moveSpeed / DEFAULT_MOVE_SPEED;
    }
  }

  /** Mevcut durumunu ('idle' | 'walking' | 'chopping') döndürür. */
  public getState(): VillagerState {
    return this.state;
  }

  /**
   * Köylüye normal bir yürüyüş rotası atar.
   * Devam eden odun toplama veya önceki yürüyüş emri anında iptal edilir.
   */
  public setMovePath(waypoints: GridCoord[]): void {
    this.targetTreeId = null;
    this.chopTimerMs = 0;

    if (waypoints.length === 0) {
      this.stopMovement();
      return;
    }

    this.pathQueue = waypoints.map((pt) => ({ col: pt.col, row: pt.row }));
    this.targetGridPos = {
      col: waypoints[waypoints.length - 1].col,
      row: waypoints[waypoints.length - 1].row,
    };
    this.state = 'walking';
    this.updateWalkingFacing(waypoints[0]);
  }

  /**
   * Köylüye belirtilen ağaca yürüyüp odun toplama emri verir.
   * Zaten ağacın yanındaysa doğrudan balta sallamaya başlar.
   */
  public setHarvestTreeOrder(
    treeId: string,
    approachWaypoints: GridCoord[],
    forestSystem: ForestSystem
  ): void {
    this.targetTreeId = treeId;
    this.chopTimerMs = 0;

    if (approachWaypoints.length > 0) {
      this.pathQueue = approachWaypoints.map((pt) => ({
        col: pt.col,
        row: pt.row,
      }));
      this.targetGridPos = {
        col: approachWaypoints[approachWaypoints.length - 1].col,
        row: approachWaypoints[approachWaypoints.length - 1].row,
      };
      this.state = 'walking';
      this.updateWalkingFacing(approachWaypoints[0]);
      return;
    }

    this.pathQueue = [];
    this.targetGridPos = null;
    this.beginChoppingIfPossible(forestSystem);
  }

  /** Mevcut yürüyüş veya odun toplama eylemini durdurup duruş (idle) karesine geçer. */
  public stopMovement(): void {
    this.pathQueue = [];
    this.targetGridPos = null;
    this.targetTreeId = null;
    this.chopTimerMs = 0;
    this.state = 'idle';
    this.sprite.anims.stop();
    this.sprite.anims.timeScale = 1;
    this.sprite.setFrame(this.facingBack ? 4 : 0);
    this.sprite.setFlipX(this.facingLeft);
  }

  /**
   * Her karede köylünün yürüyüşünü veya odun toplama döngüsünü günceller.
   */
  public update(
    deltaMs: number,
    forestSystem: ForestSystem,
    onWoodHarvested?: WoodHarvestCallback
  ): void {
    if (this.state === 'walking') {
      this.updateWalking(deltaMs, forestSystem);
      return;
    }

    if (this.state === 'chopping') {
      this.updateChopping(deltaMs, forestSystem, onWoodHarvested);
    }
  }

  /**
   * Dünya koordinatındaki (worldX, worldY) bir tıklama/dokunmanın bu köylünün
   * gövdesi üzerine denk gelip gelmediğini kontrol eder.
   */
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
   * Sabit arayüz (HUD) kamerasının köylü görsellerini çizmemesini sağlar.
   */
  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    camera.ignore([this.selectionRing, this.sprite]);
  }

  /** Harita konumu değişirse köylünün dünya konumunu ve derinliğini günceller. */
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

  private updateWalking(deltaMs: number, forestSystem: ForestSystem): void {
    if (this.pathQueue.length === 0) {
      this.beginChoppingIfPossible(forestSystem);
      return;
    }

    // Yolda yürürken hedef ağaç tükendiyse ağacın yanına vardığında duracaktır
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

    if (this.pathQueue.length === 0) {
      if (this.targetTreeId) {
        this.beginChoppingIfPossible(forestSystem);
      } else {
        this.stopMovement();
      }
    }
  }

  private beginChoppingIfPossible(forestSystem: ForestSystem): void {
    if (!this.targetTreeId) {
      this.stopMovement();
      return;
    }

    const tree = forestSystem.getTree(this.targetTreeId);
    if (!tree || tree.woodAmount <= 0) {
      this.stopMovement();
      return;
    }

    const treeWorld = this.isoGrid.tileToWorld(tree.tile.col, tree.tile.row);
    this.orientTowardWorldPoint(treeWorld.x, treeWorld.y);

    // Taşıma kapasitesi (20 odun) zaten doluysa ağaca dönük durur, kesime başlamaz
    if (this.isCarryFull()) {
      this.stopMovement();
      return;
    }

    this.state = 'chopping';
    // İlk vuruşun animasyonun 3. karesine (400ms balta iniş anı) denk gelmesi için 400ms ile başlat
    this.chopTimerMs = CHOP_INTERVAL_MS * 0.5;
    this.playChopAnimation();
  }

  private updateChopping(
    deltaMs: number,
    forestSystem: ForestSystem,
    onWoodHarvested?: WoodHarvestCallback
  ): void {
    if (!this.targetTreeId || this.isCarryFull()) {
      this.stopMovement();
      return;
    }

    const tree = forestSystem.getTree(this.targetTreeId);
    if (!tree || tree.woodAmount <= 0) {
      this.stopMovement();
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
        this.stopMovement();
        return;
      }

      const result = forestSystem.harvestWood(
        this.targetTreeId,
        Math.min(1, freeSpace)
      );

      if (result.harvested > 0) {
        this.carriedWood += result.harvested;
        onWoodHarvested?.(this, result);
      }

      // Kapasite (20) dolduysa veya ağacın odunu bittiyse toplamayı hemen bırak
      if (this.isCarryFull() || result.depleted) {
        this.stopMovement();
        return;
      }
    }
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
