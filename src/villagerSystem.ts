/**
 * Karahanlı RTS — Köylü Yönetim, Seçim ve Hareket Sistemi (VillagerSystem)
 *
 * Sahnedeki Karahanlı köylü birimlerini yönetir; masaüstü (sol tık seçim,
 * boş alana sol tık seçim kaldırma, sağ tık hareket) ve mobil (dokunarak
 * seçim, seçiliyken boş noktaya dokunarak hareket) kontrollerini kamera
 * sürükleme sistemiyle çakışmadan çalıştırır.
 */

import Phaser from 'phaser';
import { MapCameraController } from './cameraController';
import { ForestSystem } from './forestSystem';
import { IsoGrid } from './isoGrid';
import { findSmoothGridPath, GridObstacleQuery } from './pathfinding';
import { Villager, VillagerConfig } from './villager';

/** Haritanın orta açık çayırındaki ilk Karahanlı köylüsünün başlangıç konumu */
export const INITIAL_VILLAGER_SPAWN: VillagerConfig = {
  id: 'villager_1',
  col: 8,
  row: 7,
};

export class VillagerSystem {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly forestSystem: ForestSystem;
  private readonly cameraController: MapCameraController;

  private readonly villagers = new Map<string, Villager>();
  private readonly selectedIds = new Set<string>();
  private readonly ignoredCameras = new Set<Phaser.Cameras.Scene2D.Camera>();

  private readonly moveMarker: Phaser.GameObjects.Graphics;
  private moveMarkerTween?: Phaser.Tweens.Tween;

  constructor(
    scene: Phaser.Scene,
    isoGrid: IsoGrid,
    forestSystem: ForestSystem,
    cameraController: MapCameraController
  ) {
    this.scene = scene;
    this.isoGrid = isoGrid;
    this.forestSystem = forestSystem;
    this.cameraController = cameraController;

    Villager.ensureAnimations(scene);

    // Hareket komutu verildiğinde hedef noktada kısa süreli beliren ince yeşil halka
    this.moveMarker = scene.add.graphics();
    this.moveMarker.setDepth(5);
    this.moveMarker.setVisible(false);
    this.drawMoveMarkerGraphic();

    this.bindInputEvents();
  }

  /** Köylü varlıklarını ön yükler. */
  public static preload(scene: Phaser.Scene): void {
    Villager.preload(scene);
  }

  /** Başlangıç köylüsünü (şimdilik tek köylü) sahneye yerleştirir. */
  public spawnInitialVillager(
    config: VillagerConfig = INITIAL_VILLAGER_SPAWN
  ): Villager {
    return this.addVillager(config);
  }

  /**
   * Yeni bir köylü oluşturup sisteme kaydeder (ileride çoklu köylü için hazırdır).
   */
  public addVillager(config: VillagerConfig): Villager {
    if (this.villagers.has(config.id)) {
      throw new Error(`Köylü kimliği zaten kullanımda: ${config.id}`);
    }

    const villager = new Villager(this.scene, this.isoGrid, config);
    for (const cam of this.ignoredCameras) {
      villager.ignoreOnCamera(cam);
    }

    this.villagers.set(villager.id, villager);
    return villager;
  }

  /** Belirtilen kimlikteki köylüyü seçer (önceki seçimleri temizleyerek). */
  public selectSingleVillager(id: string): void {
    const target = this.villagers.get(id);
    if (!target) {
      return;
    }

    for (const [vid, unit] of this.villagers.entries()) {
      const shouldSelect = vid === id;
      unit.setSelected(shouldSelect);
      if (shouldSelect) {
        this.selectedIds.add(vid);
      } else {
        this.selectedIds.delete(vid);
      }
    }
  }

  /** Tüm köylülerin seçimini kaldırır. */
  public clearSelection(): void {
    for (const unit of this.villagers.values()) {
      unit.setSelected(false);
    }
    this.selectedIds.clear();
  }

  /** Şu anda seçili olan köylüleri döndürür. */
  public getSelectedVillagers(): Villager[] {
    const list: Villager[] = [];
    for (const id of this.selectedIds) {
      const unit = this.villagers.get(id);
      if (unit) {
        list.push(unit);
      }
    }
    return list;
  }

  /** Haritadaki tüm köylüleri döndürür. */
  public getAllVillagers(): Villager[] {
    return Array.from(this.villagers.values());
  }

  /**
   * Seçili köylüleri verilen dünya koordinatına (worldX, worldY) engelsiz bir
   * rotayla yürütür. Yeni hedef verildiğinde mevcut yürüyüş anında güncellenir.
   */
  public commandMoveSelectedToWorld(worldX: number, worldY: number): boolean {
    if (this.selectedIds.size === 0) {
      return false;
    }

    if (!this.isoGrid.isWorldPointOnMap(worldX, worldY)) {
      return false;
    }

    const rawTile = this.isoGrid.worldToTile(worldX, worldY);
    const obstacleQuery: GridObstacleQuery = {
      cols: this.isoGrid.getCols(),
      rows: this.isoGrid.getRows(),
      isTileBlocked: (col: number, row: number) =>
        !this.isoGrid.isInBounds(col, row) ||
        this.forestSystem.getTreeAt(col, row) !== undefined,
    };

    let anyMoved = false;
    let destinationWorld: { x: number; y: number } | null = null;

    for (const unit of this.getSelectedVillagers()) {
      const startPos = unit.getGridPosition();
      const waypoints = findSmoothGridPath(startPos, rawTile, obstacleQuery);
      if (waypoints.length > 0) {
        unit.setMovePath(waypoints);
        const last = waypoints[waypoints.length - 1];
        destinationWorld = this.isoGrid.tileToWorld(last.col, last.row);
        anyMoved = true;
      }
    }

    if (anyMoved && destinationWorld) {
      this.playMoveFeedback(destinationWorld.x, destinationWorld.y);
    }

    return anyMoved;
  }

  /** Her karede tüm köylülerin hareket ve animasyonlarını günceller. */
  public update(deltaMs: number): void {
    for (const unit of this.villagers.values()) {
      unit.update(deltaMs);
    }
  }

  /**
   * Sabit arayüz (HUD) kamerasının köylüleri ve hedef işaretçisini çizmemesini sağlar.
   */
  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    this.ignoredCameras.add(camera);
    camera.ignore(this.moveMarker);
    for (const unit of this.villagers.values()) {
      unit.ignoreOnCamera(camera);
    }
  }

  public destroy(): void {
    this.scene.input.off('pointerup', this.handlePointerUp, this);
    this.scene.input.off('pointermove', this.handlePointerHover, this);
    this.scene.input.setDefaultCursor('default');
    this.moveMarkerTween?.stop();
    this.moveMarker.destroy();
    for (const unit of this.villagers.values()) {
      unit.destroy();
    }
    this.villagers.clear();
    this.selectedIds.clear();
    this.ignoredCameras.clear();
  }

  private bindInputEvents(): void {
    // Sağ tık tarayıcı menüsünü devre dışı bırak (masaüstü sağ tık yürüyüş komutu için)
    this.scene.input.mouse?.disableContextMenu();
    this.scene.input.on('pointerup', this.handlePointerUp, this);
    this.scene.input.on('pointermove', this.handlePointerHover, this);
  }

  private handlePointerHover(pointer: Phaser.Input.Pointer): void {
    if (pointer.wasTouch || pointer.isDown) {
      return;
    }
    const worldPt = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const hovered = this.pickTopmostVillagerAt(worldPt.x, worldPt.y, false);
    this.scene.input.setDefaultCursor(hovered ? 'pointer' : 'default');
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    // Kamera sürükleme veya iki parmak yakınlaştırma yapıldıysa birim komutu tetikleme
    if (this.cameraController.wasPointerGestureDragged()) {
      return;
    }

    const worldPt = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const isTouch = pointer.wasTouch;
    const hitVillager = this.pickTopmostVillagerAt(worldPt.x, worldPt.y, isTouch);

    if (isTouch) {
      // MOBİL DOKUNMATİK KONTROLLER:
      // 1) Köylüye dokunulduysa -> köylüyü seç
      if (hitVillager) {
        this.selectSingleVillager(hitVillager.id);
        return;
      }

      // 2) Köylü seçiliyken haritadaki boş bir noktaya dokunulduysa -> oraya yürüt
      if (this.selectedIds.size > 0) {
        if (this.isoGrid.isWorldPointOnMap(worldPt.x, worldPt.y)) {
          this.commandMoveSelectedToWorld(worldPt.x, worldPt.y);
        } else {
          // Harita dışındaki boşluğa dokunulduğunda seçimi kaldır
          this.clearSelection();
        }
      }
      return;
    }

    // MASAÜSTÜ FARE KONTROLLERİ:
    const isRightClick = pointer.button === 2 || pointer.rightButtonReleased();
    const isLeftClick = pointer.button === 0 && !isRightClick;

    if (isLeftClick) {
      if (hitVillager) {
        this.selectSingleVillager(hitVillager.id);
      } else {
        this.clearSelection();
      }
      return;
    }

    if (isRightClick && this.selectedIds.size > 0) {
      this.commandMoveSelectedToWorld(worldPt.x, worldPt.y);
    }
  }

  /**
   * Tıklanan noktada birden fazla köylü varsa ekranda en önde (yüksek depth) olanı seçer.
   */
  private pickTopmostVillagerAt(
    worldX: number,
    worldY: number,
    isTouch: boolean
  ): Villager | undefined {
    let best: Villager | undefined;
    let bestY = Number.NEGATIVE_INFINITY;

    for (const unit of this.villagers.values()) {
      if (unit.containsWorldPoint(worldX, worldY, isTouch)) {
        const pos = unit.getWorldPosition();
        if (pos.y >= bestY) {
          bestY = pos.y;
          best = unit;
        }
      }
    }

    return best;
  }

  private drawMoveMarkerGraphic(): void {
    this.moveMarker.clear();
    this.moveMarker.lineStyle(1.3, 0x4ade80, 0.9);
    this.moveMarker.strokeEllipse(0, 0, 18, 9);
  }

  private playMoveFeedback(worldX: number, worldY: number): void {
    this.moveMarkerTween?.stop();
    this.moveMarker.setPosition(worldX, worldY);
    this.moveMarker.setScale(0.55);
    this.moveMarker.setAlpha(0.95);
    this.moveMarker.setVisible(true);

    this.moveMarkerTween = this.scene.tweens.add({
      targets: this.moveMarker,
      scaleX: 1.2,
      scaleY: 1.2,
      alpha: 0,
      duration: 340,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.moveMarker.setVisible(false);
      },
    });
  }
}
