/**
 * Karahanlı RTS — Köylü Yönetim, Seçim, Hareket ve Odun Toplama/Teslim Sistemi (VillagerSystem)
 *
 * Sahnedeki Karahanlı köylü birimlerini yönetir; masaüstü (sol tık seçim,
 * boş alana sol tık seçim kaldırma, sağ tık yürüyüş, ağaca sağ tık odun kesme,
 * depoya sağ tık odun bırakma) ve mobil dokunmatik kontrolleri çalıştırır.
 */

import Phaser from 'phaser';
import { MapCameraController } from './cameraController';
import {
  ForestSystem,
  TreeResourceNode,
  TreeType,
  WoodHarvestResult,
} from './forestSystem';
import { IsoGrid } from './isoGrid';
import {
  findSmoothGridPath,
  GridCoord,
  GridObstacleQuery,
} from './pathfinding';
import {
  Villager,
  VillagerConfig,
  VillagerState,
  VillagerWorldContext,
} from './villager';
import { WoodDepot } from './woodDepot';

/** Haritanın orta açık çayırındaki ilk Karahanlı köylüsünün başlangıç konumu */
export const INITIAL_VILLAGER_SPAWN: VillagerConfig = {
  id: 'villager_1',
  col: 8,
  row: 7,
};

/** Ağaç gövdesi ve odun deposu kenarında durmak için ideal ızgara mesafesi (> 0.78 engel yarıçapı) */
const INTERACT_STAND_RADIUS = 0.86;

export interface VillagerHudStatus {
  totalStoredWood: number;
  carriedWood: number;
  maxCapacity: number;
  isSelected: boolean;
  state: VillagerState;
  targetTreeType: TreeType | null;
  targetTreeWood: number | null;
  targetTreeMaxWood: number | null;
  remainingTreesCount: number;
}

export class VillagerSystem {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly forestSystem: ForestSystem;
  private readonly woodDepot: WoodDepot;
  private readonly cameraController: MapCameraController;
  private readonly worldContext: VillagerWorldContext;

  private readonly villagers = new Map<string, Villager>();
  private readonly selectedIds = new Set<string>();
  private readonly ignoredCameras = new Set<Phaser.Cameras.Scene2D.Camera>();

  private readonly moveMarker: Phaser.GameObjects.Graphics;
  private moveMarkerTween?: Phaser.Tweens.Tween;

  constructor(
    scene: Phaser.Scene,
    isoGrid: IsoGrid,
    forestSystem: ForestSystem,
    woodDepot: WoodDepot,
    cameraController: MapCameraController
  ) {
    this.scene = scene;
    this.isoGrid = isoGrid;
    this.forestSystem = forestSystem;
    this.woodDepot = woodDepot;
    this.cameraController = cameraController;

    Villager.ensureAnimations(scene);

    this.worldContext = {
      forestSystem: this.forestSystem,
      woodDepot: this.woodDepot,
      planPathToTree: (from, tree) => this.buildPathToTileAdjacent(from, tree.tile),
      planPathToDepot: (from) =>
        this.buildPathToTileAdjacent(from, this.woodDepot.getTile()),
      onWoodHarvested: (villager, result) => {
        this.spawnWoodHarvestPop(villager, result);
      },
      onWoodDeposited: (_villager, depositedAmount) => {
        this.spawnWoodDepositPop(depositedAmount);
      },
    };

    this.moveMarker = scene.add.graphics();
    this.moveMarker.setDepth(5);
    this.moveMarker.setVisible(false);

    this.bindInputEvents();
  }

  public static preload(scene: Phaser.Scene): void {
    Villager.preload(scene);
  }

  public spawnInitialVillager(
    config: VillagerConfig = INITIAL_VILLAGER_SPAWN
  ): Villager {
    return this.addVillager(config);
  }

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

  public clearSelection(): void {
    for (const unit of this.villagers.values()) {
      unit.setSelected(false);
    }
    this.selectedIds.clear();
  }

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

  public getAllVillagers(): Villager[] {
    return Array.from(this.villagers.values());
  }

  /**
   * Üst arayüzde (HUD) toplam depo odununu, köylünün taşıdığı odunu ve
   * aktif ağaç bilgisini göstermek için özet durum döner.
   */
  public getHudStatus(): VillagerHudStatus | null {
    const selected = this.getSelectedVillagers()[0];
    const primary = selected ?? this.villagers.values().next().value;
    if (!primary) {
      return null;
    }

    const treeId = primary.getTargetTreeId();
    const targetTree = treeId ? this.forestSystem.getTree(treeId) : undefined;

    return {
      totalStoredWood: this.woodDepot.getStoredWood(),
      carriedWood: primary.getCarriedWood(),
      maxCapacity: primary.getMaxWoodCapacity(),
      isSelected: primary.isSelected(),
      state: primary.getState(),
      targetTreeType: targetTree?.treeType ?? null,
      targetTreeWood: targetTree ? targetTree.woodAmount : null,
      targetTreeMaxWood: targetTree ? targetTree.maxWoodAmount : null,
      remainingTreesCount: this.forestSystem.getAllTrees().length,
    };
  }

  /**
   * Seçili köylülere verilen ağaca yürüyüp odun kesme (ve 20 oldukça depoya taşıma) emri verir.
   */
  public commandHarvestSelectedTree(tree: TreeResourceNode): boolean {
    if (this.selectedIds.size === 0) {
      return false;
    }

    let anyOrdered = false;

    for (const unit of this.getSelectedVillagers()) {
      const startPos = unit.getGridPosition();
      const distToTree = Math.hypot(
        startPos.col - tree.tile.col,
        startPos.row - tree.tile.row
      );

      if (distToTree >= 0.76 && distToTree <= 1.06) {
        unit.setHarvestTreeOrder(tree.id, [], this.worldContext);
        anyOrdered = true;
        continue;
      }

      const waypoints = this.buildPathToTileAdjacent(startPos, tree.tile);
      unit.setHarvestTreeOrder(tree.id, waypoints, this.worldContext);
      anyOrdered = true;
    }

    if (anyOrdered) {
      const treeWorld = this.isoGrid.tileToWorld(tree.tile.col, tree.tile.row);
      this.playOrderFeedback(treeWorld.x, treeWorld.y, 0xf59e0b);
    }

    return anyOrdered;
  }

  /**
   * Seçili köylülere eldeki odunları doğrudan depoya götürüp teslim etme emri verir.
   */
  public commandDeliverSelectedToDepot(): boolean {
    if (this.selectedIds.size === 0) {
      return false;
    }

    for (const unit of this.getSelectedVillagers()) {
      unit.setDeliverToDepotOrder(this.worldContext);
    }

    const depotWorld = this.woodDepot.getWorldPosition();
    this.playOrderFeedback(depotWorld.x, depotWorld.y, 0x38bdf8);
    return true;
  }

  /**
   * Seçili köylüleri verilen dünya koordinatına (worldX, worldY) yürütür.
   * Aktif kesim veya depo döngüsü anında iptal edilir.
   */
  public commandMoveSelectedToWorld(worldX: number, worldY: number): boolean {
    if (this.selectedIds.size === 0) {
      return false;
    }

    if (!this.isoGrid.isWorldPointOnMap(worldX, worldY)) {
      return false;
    }

    const rawTile = this.isoGrid.worldToTile(worldX, worldY);
    const obstacleQuery = this.createObstacleQuery();

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
      } else {
        unit.stopMovement();
      }
    }

    if (anyMoved && destinationWorld) {
      this.playOrderFeedback(destinationWorld.x, destinationWorld.y, 0x4ade80);
    }

    return anyMoved;
  }

  public update(deltaMs: number): void {
    for (const unit of this.villagers.values()) {
      unit.update(deltaMs, this.worldContext);
    }
  }

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

  private createObstacleQuery(): GridObstacleQuery {
    return {
      cols: this.isoGrid.getCols(),
      rows: this.isoGrid.getRows(),
      isTileBlocked: (col: number, row: number) =>
        !this.isoGrid.isInBounds(col, row) ||
        this.forestSystem.getTreeAt(col, row) !== undefined ||
        this.woodDepot.occupiesTile(col, row),
    };
  }

  /**
   * Bir hedef karonun (ağaç veya odun deposu) etrafındaki en yakın açık etkileşim
   * noktasına engelsiz yürüyüş rotası hesaplar.
   */
  private buildPathToTileAdjacent(
    fromPos: GridCoord,
    targetTile: GridCoord
  ): GridCoord[] {
    const obstacleQuery = this.createObstacleQuery();
    const standSpot = this.computeBestStandSpot(
      fromPos,
      targetTile,
      obstacleQuery
    );
    if (!standSpot) {
      return [];
    }
    return findSmoothGridPath(fromPos, standSpot, obstacleQuery);
  }

  private computeBestStandSpot(
    fromPos: GridCoord,
    targetTile: GridCoord,
    grid: GridObstacleQuery
  ): GridCoord | null {
    const tc = targetTile.col;
    const tr = targetTile.row;

    const candidateDirs: ReadonlyArray<{
      dc: number;
      dr: number;
      bias: number;
    }> = [
      { dc: -1, dr: 0, bias: 0 },
      { dc: 0, dr: 1, bias: 0 },
      { dc: 1, dr: 0, bias: 0 },
      { dc: 0, dr: -1, bias: 0 },
      { dc: -1, dr: 1, bias: 0.35 },
      { dc: 1, dr: -1, bias: 0.35 },
      { dc: 1, dr: 1, bias: 0.45 },
      { dc: -1, dr: -1, bias: 0.45 },
    ];

    let bestSpot: GridCoord | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const { dc, dr, bias } of candidateDirs) {
      const neighborCol = tc + dc;
      const neighborRow = tr + dr;
      if (grid.isTileBlocked(neighborCol, neighborRow)) {
        continue;
      }

      const len = Math.hypot(dc, dr);
      const spotCol = tc + (dc / len) * INTERACT_STAND_RADIUS;
      const spotRow = tr + (dr / len) * INTERACT_STAND_RADIUS;

      const dist = Math.hypot(spotCol - fromPos.col, spotRow - fromPos.row);
      const score = dist + bias;
      if (score < bestScore) {
        bestScore = score;
        bestSpot = { col: spotCol, row: spotRow };
      }
    }

    return bestSpot;
  }

  private bindInputEvents(): void {
    this.scene.input.mouse?.disableContextMenu();
    this.scene.input.on('pointerup', this.handlePointerUp, this);
    this.scene.input.on('pointermove', this.handlePointerHover, this);
  }

  private handlePointerHover(pointer: Phaser.Input.Pointer): void {
    if (pointer.wasTouch || pointer.isDown) {
      return;
    }
    const worldPt = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const hoveredVillager = this.pickTopmostVillagerAt(
      worldPt.x,
      worldPt.y,
      false
    );
    if (hoveredVillager) {
      this.scene.input.setDefaultCursor('pointer');
      return;
    }

    if (this.selectedIds.size > 0) {
      const hoveredTree = this.forestSystem.pickTreeAtWorld(
        worldPt.x,
        worldPt.y,
        false
      );
      if (
        hoveredTree ||
        this.woodDepot.containsWorldPoint(worldPt.x, worldPt.y, false)
      ) {
        this.scene.input.setDefaultCursor('pointer');
        return;
      }
    }

    this.scene.input.setDefaultCursor('default');
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    if (this.cameraController.wasPointerGestureDragged()) {
      return;
    }

    const worldPt = this.scene.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const isTouch = pointer.wasTouch;
    const hitVillager = this.pickTopmostVillagerAt(
      worldPt.x,
      worldPt.y,
      isTouch
    );

    if (isTouch) {
      // MOBİL DOKUNMATİK KONTROLLER:
      if (hitVillager) {
        this.selectSingleVillager(hitVillager.id);
        return;
      }

      if (this.selectedIds.size > 0) {
        const hitTree = this.forestSystem.pickTreeAtWorld(
          worldPt.x,
          worldPt.y,
          true
        );
        if (hitTree) {
          this.commandHarvestSelectedTree(hitTree);
          return;
        }

        if (this.woodDepot.containsWorldPoint(worldPt.x, worldPt.y, true)) {
          this.commandDeliverSelectedToDepot();
          return;
        }

        if (this.isoGrid.isWorldPointOnMap(worldPt.x, worldPt.y)) {
          this.commandMoveSelectedToWorld(worldPt.x, worldPt.y);
        } else {
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
      const hitTree = this.forestSystem.pickTreeAtWorld(
        worldPt.x,
        worldPt.y,
        false
      );
      if (hitTree) {
        this.commandHarvestSelectedTree(hitTree);
        return;
      }

      if (this.woodDepot.containsWorldPoint(worldPt.x, worldPt.y, false)) {
        this.commandDeliverSelectedToDepot();
        return;
      }

      this.commandMoveSelectedToWorld(worldPt.x, worldPt.y);
    }
  }

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

  private playOrderFeedback(
    worldX: number,
    worldY: number,
    strokeColor: number
  ): void {
    this.moveMarkerTween?.stop();
    this.moveMarker.clear();
    this.moveMarker.lineStyle(1.4, strokeColor, 0.92);
    this.moveMarker.strokeEllipse(0, 0, 18, 9);

    this.moveMarker.setPosition(worldX, worldY);
    this.moveMarker.setScale(0.55);
    this.moveMarker.setAlpha(0.95);
    this.moveMarker.setVisible(true);

    this.moveMarkerTween = this.scene.tweens.add({
      targets: this.moveMarker,
      scaleX: 1.25,
      scaleY: 1.25,
      alpha: 0,
      duration: 340,
      ease: 'Quad.easeOut',
      onComplete: () => {
        this.moveMarker.setVisible(false);
      },
    });
  }

  private spawnWoodHarvestPop(
    villager: Villager,
    result: WoodHarvestResult
  ): void {
    const vPos = villager.getWorldPosition();
    const popText = this.scene.add
      .text(vPos.x, vPos.y - 36, `+${result.harvested}`, {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '11px',
        fontStyle: 'bold',
        color: '#fcd34d',
        stroke: '#1e1b18',
        strokeThickness: 2.5,
      })
      .setOrigin(0.5, 1)
      .setDepth(vPos.y + 2200);

    for (const cam of this.ignoredCameras) {
      cam.ignore(popText);
    }

    this.scene.tweens.add({
      targets: popText,
      y: vPos.y - 49,
      alpha: 0,
      duration: 500,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        popText.destroy();
      },
    });
  }

  /**
   * Köylü depoya odun teslim ettiğinde deponun üzerinde "+20 Odun" bildirimi gösterir.
   */
  private spawnWoodDepositPop(depositedAmount: number): void {
    const dPos = this.woodDepot.getWorldPosition();
    const popText = this.scene.add
      .text(dPos.x, dPos.y - 34, `+${depositedAmount} Depo`, {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '12px',
        fontStyle: 'bold',
        color: '#4ade80',
        stroke: '#14261a',
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(dPos.y + 2300);

    for (const cam of this.ignoredCameras) {
      cam.ignore(popText);
    }

    this.scene.tweens.add({
      targets: popText,
      y: dPos.y - 52,
      alpha: 0,
      duration: 750,
      ease: 'Cubic.easeOut',
      onComplete: () => {
        popText.destroy();
      },
    });
  }
}
