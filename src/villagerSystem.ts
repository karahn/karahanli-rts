/**
 * Karahanlı RTS — Çoklu Köylü Yönetim, Seçim, Hareket ve Odun Toplama Sistemi (VillagerSystem)
 *
 * Sahnedeki tüm Karahanlı köylü birimlerini bağımsız durum makineleriyle yönetir:
 * - Başlangıçta en az 3 köylü oluşturur; her biri tek tek seçilebilir
 * - Verilen yürüyüş veya odun toplama komutu yalnızca seçili olan köylüyü etkiler
 * - Birden fazla köylü aynı ağaca veya ortak odun deposuna yöneldiğinde üst üste
 *   binmeyecek şekilde farklı yan noktalara yerleşir
 * - Ortak odun deposu ve toplam odun sayacı tüm köylüler tarafından paylaşılır
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

/** Ortak odun deposunun (7, 6) çevresindeki açık çayırda başlangıçtaki 3 Karahanlı köylüsü */
export const INITIAL_VILLAGER_SPAWNS: readonly VillagerConfig[] = [
  {
    id: 'villager_1',
    displayName: 'Köylü 1',
    col: 8,
    row: 6,
    initialFacingBack: false,
    initialFacingLeft: true,
  },
  {
    id: 'villager_2',
    displayName: 'Köylü 2',
    col: 8,
    row: 8,
    initialFacingBack: true,
    initialFacingLeft: true,
  },
  {
    id: 'villager_3',
    displayName: 'Köylü 3',
    col: 6,
    row: 8,
    initialFacingBack: false,
    initialFacingLeft: false,
  },
];

/** Ağaç gövdesi ve odun deposu kenarında durmak için ideal ızgara mesafesi (> 0.78 engel yarıçapı) */
const INTERACT_STAND_RADIUS = 0.86;

/** İki köylünün aynı noktada üst üste durmasını önleyen minimum ızgara aralığı */
const MIN_VILLAGER_SEPARATION = 0.56;

export interface SelectedVillagerHudInfo {
  id: string;
  displayName: string;
  carriedWood: number;
  maxCapacity: number;
  state: VillagerState;
  targetTreeType: TreeType | null;
  targetTreeWood: number | null;
  targetTreeMaxWood: number | null;
}

export interface VillagerHudStatus {
  totalStoredWood: number;
  totalVillagersCount: number;
  workingVillagersCount: number;
  remainingTreesCount: number;
  selectedVillager: SelectedVillagerHudInfo | null;
}

export class VillagerSystem {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly forestSystem: ForestSystem;
  private readonly woodDepot: WoodDepot;
  private readonly cameraController: MapCameraController;
  private readonly worldContext: VillagerWorldContext;

  private readonly villagers = new Map<string, Villager>();
  private selectedVillagerId: string | null = null;
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
      planPathToTree: (villager, tree) =>
        this.buildPathToTileAdjacent(villager, tree.tile),
      planPathToDepot: (villager) =>
        this.buildPathToTileAdjacent(villager, this.woodDepot.getTile()),
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

  /**
   * Başlangıçtaki Karahanlı köylülerini (varsayılan: 3 köylü) sahneye yerleştirir.
   */
  public spawnInitialVillagers(
    configs: readonly VillagerConfig[] = INITIAL_VILLAGER_SPAWNS
  ): Villager[] {
    return configs.map((cfg) => this.addVillager(cfg));
  }

  /**
   * Yeni bir köylü oluşturup sisteme kaydeder.
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

  /**
   * Yalnızca belirtilen kimlikteki köylüyü seçer; diğer tüm köylülerin seçim
   * halkasını kapatır (diğer köylülerin mevcut görevleri kesintisiz devam eder).
   */
  public selectSingleVillager(id: string): void {
    if (!this.villagers.has(id)) {
      return;
    }

    this.selectedVillagerId = id;
    for (const [vid, unit] of this.villagers.entries()) {
      unit.setSelected(vid === id);
    }
  }

  /** Tüm köylülerin seçimini kaldırır (devam eden görevlerini etkilemez). */
  public clearSelection(): void {
    this.selectedVillagerId = null;
    for (const unit of this.villagers.values()) {
      unit.setSelected(false);
    }
  }

  /** Şu anda seçili olan tekil köylüyü (yoksa null) döndürür. */
  public getSelectedVillager(): Villager | null {
    if (!this.selectedVillagerId) {
      return null;
    }
    return this.villagers.get(this.selectedVillagerId) ?? null;
  }

  /** Haritadaki tüm köylüleri döndürür. */
  public getAllVillagers(): Villager[] {
    return Array.from(this.villagers.values());
  }

  /**
   * Üst arayüzde (HUD) ortak toplam depo odununu, çalışan köylü sayısını ve
   * seçili köylünün bilgisini göstermek için özet durum döner.
   */
  public getHudStatus(): VillagerHudStatus {
    let workingCount = 0;
    for (const unit of this.villagers.values()) {
      if (unit.getState() !== 'idle') {
        workingCount += 1;
      }
    }

    const selected = this.getSelectedVillager();
    let selectedInfo: SelectedVillagerHudInfo | null = null;

    if (selected) {
      const treeId = selected.getTargetTreeId();
      const targetTree = treeId ? this.forestSystem.getTree(treeId) : undefined;
      selectedInfo = {
        id: selected.id,
        displayName: selected.displayName,
        carriedWood: selected.getCarriedWood(),
        maxCapacity: selected.getMaxWoodCapacity(),
        state: selected.getState(),
        targetTreeType: targetTree?.treeType ?? null,
        targetTreeWood: targetTree ? targetTree.woodAmount : null,
        targetTreeMaxWood: targetTree ? targetTree.maxWoodAmount : null,
      };
    }

    return {
      totalStoredWood: this.woodDepot.getStoredWood(),
      totalVillagersCount: this.villagers.size,
      workingVillagersCount: workingCount,
      remainingTreesCount: this.forestSystem.getAllTrees().length,
      selectedVillager: selectedInfo,
    };
  }

  /**
   * Yalnızca seçili köylüye verilen ağaca yürüyüp odun kesme emri verir.
   */
  public commandHarvestSelectedTree(tree: TreeResourceNode): boolean {
    const unit = this.getSelectedVillager();
    if (!unit) {
      return false;
    }

    const startPos = unit.getGridPosition();
    const distToTree = Math.hypot(
      startPos.col - tree.tile.col,
      startPos.row - tree.tile.row
    );

    if (
      distToTree >= 0.76 &&
      distToTree <= 1.06 &&
      !this.isSpotCrowdedByOthers(unit.id, startPos)
    ) {
      unit.setHarvestTreeOrder(tree.id, [], this.worldContext);
    } else {
      const waypoints = this.buildPathToTileAdjacent(unit, tree.tile);
      unit.setHarvestTreeOrder(tree.id, waypoints, this.worldContext);
    }

    const treeWorld = this.isoGrid.tileToWorld(tree.tile.col, tree.tile.row);
    this.playOrderFeedback(treeWorld.x, treeWorld.y, 0xf59e0b);
    return true;
  }

  /**
   * Yalnızca seçili köylüye eldeki odunu ortak depoya götürme emri verir.
   */
  public commandDeliverSelectedToDepot(): boolean {
    const unit = this.getSelectedVillager();
    if (!unit) {
      return false;
    }

    unit.setDeliverToDepotOrder(this.worldContext);
    const depotWorld = this.woodDepot.getWorldPosition();
    this.playOrderFeedback(depotWorld.x, depotWorld.y, 0x38bdf8);
    return true;
  }

  /**
   * Yalnızca seçili köylüyü verilen dünya koordinatına (worldX, worldY) yürütür.
   */
  public commandMoveSelectedToWorld(worldX: number, worldY: number): boolean {
    const unit = this.getSelectedVillager();
    if (!unit) {
      return false;
    }

    if (!this.isoGrid.isWorldPointOnMap(worldX, worldY)) {
      return false;
    }

    const rawTile = this.isoGrid.worldToTile(worldX, worldY);
    const obstacleQuery = this.createObstacleQuery();
    const goalTile = this.resolveUnoccupiedGroundTarget(
      unit.id,
      rawTile,
      obstacleQuery
    );

    const startPos = unit.getGridPosition();
    const waypoints = findSmoothGridPath(startPos, goalTile, obstacleQuery);
    if (waypoints.length > 0) {
      unit.setMovePath(waypoints);
      const last = waypoints[waypoints.length - 1];
      const destinationWorld = this.isoGrid.tileToWorld(last.col, last.row);
      this.playOrderFeedback(destinationWorld.x, destinationWorld.y, 0x4ade80);
      return true;
    }

    unit.stopMovement();
    return false;
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
    this.selectedVillagerId = null;
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

  private buildPathToTileAdjacent(
    requester: Villager,
    targetTile: GridCoord
  ): GridCoord[] {
    const obstacleQuery = this.createObstacleQuery();
    const fromPos = requester.getGridPosition();
    const standSpot = this.computeBestStandSpot(
      requester.id,
      fromPos,
      targetTile,
      obstacleQuery
    );
    if (!standSpot) {
      return [];
    }
    return findSmoothGridPath(fromPos, standSpot, obstacleQuery);
  }

  /**
   * Ağaç veya depo etrafındaki açık kenar noktalarından bu köylüye en uygun olanı seçer.
   * Başka bir köylünün zaten durduğu veya yöneldiği noktalara ceza puanı uygulayarak
   * köylülerin farklı kenarlara dağılmasını sağlar.
   */
  private computeBestStandSpot(
    requesterId: string,
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
      const crowdPenalty = this.isSpotCrowdedByOthers(requesterId, {
        col: spotCol,
        row: spotRow,
      })
        ? 5.0
        : 0;

      const score = dist + bias + crowdPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestSpot = { col: spotCol, row: spotRow };
      }
    }

    return bestSpot;
  }

  /**
   * Açık zemine yürüyüş emri verildiğinde hedefte başka bir köylü duruyorsa,
   * iki köylünün tam üst üste binip seçimi zorlaştırmaması için hedefi hafifçe kaydırır.
   */
  private resolveUnoccupiedGroundTarget(
    requesterId: string,
    rawTarget: GridCoord,
    grid: GridObstacleQuery
  ): GridCoord {
    const clamped = this.isoGrid.clampContinuousTile(
      rawTarget.col,
      rawTarget.row,
      0.24
    );
    if (!this.isSpotCrowdedByOthers(requesterId, clamped)) {
      return clamped;
    }

    const angles = [0, 60, -60, 120, -120, 180, 30, -30];
    for (const deg of angles) {
      const rad = Phaser.Math.DegToRad(deg);
      const candidate = this.isoGrid.clampContinuousTile(
        clamped.col + Math.cos(rad) * 0.65,
        clamped.row + Math.sin(rad) * 0.65,
        0.24
      );
      const tileC = Math.round(candidate.col);
      const tileR = Math.round(candidate.row);
      if (
        !grid.isTileBlocked(tileC, tileR) &&
        !this.isSpotCrowdedByOthers(requesterId, candidate)
      ) {
        return candidate;
      }
    }

    return clamped;
  }

  private isSpotCrowdedByOthers(requesterId: string, spot: GridCoord): boolean {
    for (const [vid, other] of this.villagers.entries()) {
      if (vid === requesterId) {
        continue;
      }

      const pos = other.getGridPosition();
      if (
        other.getState() !== 'walking' &&
        other.getState() !== 'returning_to_depot' &&
        Math.hypot(pos.col - spot.col, pos.row - spot.row) <
          MIN_VILLAGER_SEPARATION
      ) {
        return true;
      }

      const target = other.getTargetPosition();
      if (
        target &&
        Math.hypot(target.col - spot.col, target.row - spot.row) <
          MIN_VILLAGER_SEPARATION
      ) {
        return true;
      }
    }
    return false;
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
    const hoveredVillager = this.pickBestVillagerAt(
      worldPt.x,
      worldPt.y,
      false
    );
    if (hoveredVillager) {
      this.scene.input.setDefaultCursor('pointer');
      return;
    }

    if (this.selectedVillagerId !== null) {
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
    const hitVillager = this.pickBestVillagerAt(
      worldPt.x,
      worldPt.y,
      isTouch
    );

    if (isTouch) {
      // MOBİL DOKUNMATİK KONTROLLER:
      // Herhangi bir köylüye dokunulduğunda doğrudan o köylüyü seç (seçimi değiştirme dahil)
      if (hitVillager) {
        this.selectSingleVillager(hitVillager.id);
        return;
      }

      if (this.selectedVillagerId !== null) {
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

    if (isRightClick && this.selectedVillagerId !== null) {
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

  /**
   * Tıklanan/dokunulan noktadaki köylüler arasından imlece gövde merkezi en yakın
   * olanı (çok yakın eşitlikte ekranda daha önde duranı) seçer.
   */
  private pickBestVillagerAt(
    worldX: number,
    worldY: number,
    isTouch: boolean
  ): Villager | undefined {
    let best: Villager | undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    let bestY = Number.NEGATIVE_INFINITY;

    for (const unit of this.villagers.values()) {
      if (!unit.containsWorldPoint(worldX, worldY, isTouch)) {
        continue;
      }

      const dist = unit.distanceToBodyCenter(worldX, worldY);
      const posY = unit.getWorldPosition().y;

      if (
        !best ||
        dist < bestDist - 3.5 ||
        (Math.abs(dist - bestDist) <= 3.5 && posY >= bestY)
      ) {
        best = unit;
        bestDist = dist;
        bestY = posY;
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
