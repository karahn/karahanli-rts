/**
 * Karahanlı RTS — Çoklu Birim Seçim, Grup Hareketi ve Odun Toplama Sistemi (VillagerSystem)
 *
 * Sahnedeki tüm Karahanlı köylü birimlerini hem tekli hem çoklu seçimle yönetir:
 * - Masaüstünde: Sol tık tekli seçim (Shift+Sol Tık ekleme/çıkarma, Çift Tık tümünü seçme),
 *   Sol tuşa basılı tutup sürükleyerek yeşil seçim dikdörtgeni (marquee box) ile çoklu seçim
 * - Mobilde: "Kutu Seç" moduyla parmak sürükleyerek seçim dikdörtgeni oluşturma veya tek tek
 *   ekleme, "Tümünü Seç" hızlı butonu ve köylüye çift dokunarak tümünü seçme
 * - Sağ tıkla (mobilde dokunarak) seçili tüm köylülere ortak formasyon yürüyüşü, ağaç kesme
 *   veya depoya teslim komutu verme
 * - Hareket esnasında ve varışta dinamik birim ayrışması ile köylülerin üst üste binmesini önleme
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

/** İki köylünün hedef/duruş noktaları arasındaki minimum ızgara aralığı */
const MIN_VILLAGER_SEPARATION = 0.62;

/** Yürüyüş esnasında köylülerin birbirinin üstüne binmesini önleyen dinamik ayrışma yarıçapı */
const DYNAMIC_SEPARATION_RADIUS = 0.64;

/** Grup yürüyüşünde formasyon noktaları arasındaki ızgara mesafesi */
const FORMATION_SPACING = 0.86;

/** Seçim dikdörtgenini (marquee) başlatmak için minimum sürükleme eşiği (ekran px) */
const MARQUEE_DRAG_THRESHOLD_PX = 7;

/** Köylü üzerine çift tıklama / çift dokunma ile tümünü seçme süresi (ms) */
const DOUBLE_TAP_WINDOW_MS = 350;

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

export interface MultiSelectedHudInfo {
  count: number;
  totalCarriedWood: number;
  totalCapacity: number;
  choppingCount: number;
  movingCount: number;
}

export interface VillagerHudStatus {
  totalStoredWood: number;
  totalVillagersCount: number;
  workingVillagersCount: number;
  remainingTreesCount: number;
  selectedCount: number;
  touchBoxSelectMode: boolean;
  selectedVillager: SelectedVillagerHudInfo | null;
  multiSelected: MultiSelectedHudInfo | null;
}

export class VillagerSystem {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly forestSystem: ForestSystem;
  private readonly woodDepot: WoodDepot;
  private readonly cameraController: MapCameraController;
  private readonly worldContext: VillagerWorldContext;

  private readonly villagers = new Map<string, Villager>();
  private readonly selectedVillagerIds = new Set<string>();
  private readonly ignoredWorldCameras = new Set<Phaser.Cameras.Scene2D.Camera>();

  /** Arayüz butonlarının ekran alanlarını kontrol ederek haritaya tıklama sızmasını önler */
  private isScreenUiBlocked?: (screenX: number, screenY: number) => boolean;

  /** Seçim dikdörtgeni (marquee box) durumu — ekran koordinatlarında çizilir */
  private readonly marqueeGraphics: Phaser.GameObjects.Graphics;
  private isMarqueeCandidate = false;
  private isMarqueeDragging = false;
  private marqueePointerId = -1;
  private marqueeStartX = 0;
  private marqueeStartY = 0;
  private marqueeAdditive = false;
  private marqueeBaseSelection = new Set<string>();

  /** Mobil dokunmatik için kutu seçim modu ("Kutu Seç" butonuyla açılır/kapanır) */
  private touchBoxSelectMode = false;

  /** Çift tık / çift dokunma takibi */
  private lastVillagerTapTime = 0;
  private lastTappedVillagerId: string | null = null;

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

    // Seçim dikdörtgeni HUD kamerasında 1:1 ekran pikselleriyle keskin çizilir
    this.marqueeGraphics = scene.add.graphics();
    this.marqueeGraphics.setDepth(4990);
    this.marqueeGraphics.setVisible(false);

    // Mobil kutu seçim modu aktifken veya HUD butonuna basıldığında kamera sürüklemesini durdur
    this.cameraController.setPointerDragSuppression((pointer) => {
      if (this.isScreenUiBlocked?.(pointer.x, pointer.y)) {
        return true;
      }
      if (pointer.wasTouch && this.touchBoxSelectMode) {
        return true;
      }
      return false;
    });

    this.bindInputEvents();
  }

  public static preload(scene: Phaser.Scene): void {
    Villager.preload(scene);
  }

  /**
   * Üst/alt HUD butonlarının ekran koordinatlarını tık sızmasına karşı tanıtır.
   */
  public setUiHitBlocker(
    predicate: (screenX: number, screenY: number) => boolean
  ): void {
    this.isScreenUiBlocked = predicate;
  }

  /**
   * Ana dünya kamerasının yok sayması gereken ekran üstü (HUD) çizim nesnelerini döndürür.
   */
  public getScreenOverlayObjects(): Phaser.GameObjects.GameObject[] {
    return [this.marqueeGraphics];
  }

  /**
   * Mobil dokunmatik kutu seçim modunu açar/kapatır.
   */
  public setTouchBoxSelectMode(enabled: boolean): void {
    this.touchBoxSelectMode = enabled;
    if (!enabled && this.isMarqueeDragging) {
      this.cancelMarqueeDrag();
    }
  }

  public toggleTouchBoxSelectMode(): boolean {
    this.setTouchBoxSelectMode(!this.touchBoxSelectMode);
    return this.touchBoxSelectMode;
  }

  public isTouchBoxSelectMode(): boolean {
    return this.touchBoxSelectMode;
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
    for (const cam of this.ignoredWorldCameras) {
      villager.ignoreOnCamera(cam);
    }

    this.villagers.set(villager.id, villager);
    return villager;
  }

  /**
   * Yalnızca belirtilen kimlikteki tek köylüyü seçer.
   */
  public selectSingleVillager(id: string): void {
    if (!this.villagers.has(id)) {
      return;
    }
    this.selectedVillagerIds.clear();
    this.selectedVillagerIds.add(id);
    this.syncSelectionRings();
  }

  /**
   * Birden fazla köylüyü aynı anda seçer (additive=true ise mevcut seçime ekler).
   */
  public selectVillagers(ids: Iterable<string>, additive = false): void {
    if (!additive) {
      this.selectedVillagerIds.clear();
    }
    for (const id of ids) {
      if (this.villagers.has(id)) {
        this.selectedVillagerIds.add(id);
      }
    }
    this.syncSelectionRings();
  }

  /**
   * Belirtilen köylünün seçili durumunu tersine çevirir (Shift+Tık veya mobil çoklu seçim).
   */
  public toggleVillagerSelection(id: string): void {
    if (!this.villagers.has(id)) {
      return;
    }
    if (this.selectedVillagerIds.has(id)) {
      this.selectedVillagerIds.delete(id);
    } else {
      this.selectedVillagerIds.add(id);
    }
    this.syncSelectionRings();
  }

  /**
   * Haritadaki tüm köylüleri seçer ve yeşil seçim halkalarını gösterir.
   */
  public selectAllVillagers(): void {
    this.selectedVillagerIds.clear();
    for (const id of this.villagers.keys()) {
      this.selectedVillagerIds.add(id);
    }
    this.syncSelectionRings();
  }

  /** Tüm köylülerin seçimini kaldırır (devam eden görevlerini etkilemez). */
  public clearSelection(): void {
    this.selectedVillagerIds.clear();
    this.syncSelectionRings();
  }

  /** Şu anda seçili olan tüm köylüleri döndürür. */
  public getSelectedVillagers(): Villager[] {
    const result: Villager[] = [];
    for (const id of this.selectedVillagerIds) {
      const unit = this.villagers.get(id);
      if (unit) {
        result.push(unit);
      }
    }
    return result;
  }

  public getSelectedCount(): number {
    return this.selectedVillagerIds.size;
  }

  /** Haritadaki tüm köylüleri döndürür. */
  public getAllVillagers(): Villager[] {
    return Array.from(this.villagers.values());
  }

  /**
   * Üst arayüzde (HUD) ortak toplam depo odununu, tekli veya çoklu seçili köylülerin
   * durumunu göstermek için özet veri döner.
   */
  public getHudStatus(): VillagerHudStatus {
    let workingCount = 0;
    for (const unit of this.villagers.values()) {
      if (unit.getState() !== 'idle') {
        workingCount += 1;
      }
    }

    const selectedUnits = this.getSelectedVillagers();
    let singleInfo: SelectedVillagerHudInfo | null = null;
    let multiInfo: MultiSelectedHudInfo | null = null;

    if (selectedUnits.length === 1) {
      const selected = selectedUnits[0];
      const treeId = selected.getTargetTreeId();
      const targetTree = treeId ? this.forestSystem.getTree(treeId) : undefined;
      singleInfo = {
        id: selected.id,
        displayName: selected.displayName,
        carriedWood: selected.getCarriedWood(),
        maxCapacity: selected.getMaxWoodCapacity(),
        state: selected.getState(),
        targetTreeType: targetTree?.treeType ?? null,
        targetTreeWood: targetTree ? targetTree.woodAmount : null,
        targetTreeMaxWood: targetTree ? targetTree.maxWoodAmount : null,
      };
    } else if (selectedUnits.length > 1) {
      let totalCarried = 0;
      let totalCap = 0;
      let chopping = 0;
      let moving = 0;

      for (const u of selectedUnits) {
        totalCarried += u.getCarriedWood();
        totalCap += u.getMaxWoodCapacity();
        if (u.getState() === 'chopping') {
          chopping += 1;
        } else if (u.isMoving()) {
          moving += 1;
        }
      }

      multiInfo = {
        count: selectedUnits.length,
        totalCarriedWood: totalCarried,
        totalCapacity: totalCap,
        choppingCount: chopping,
        movingCount: moving,
      };
    }

    return {
      totalStoredWood: this.woodDepot.getStoredWood(),
      totalVillagersCount: this.villagers.size,
      workingVillagersCount: workingCount,
      remainingTreesCount: this.forestSystem.getAllTrees().length,
      selectedCount: selectedUnits.length,
      touchBoxSelectMode: this.touchBoxSelectMode,
      selectedVillager: singleInfo,
      multiSelected: multiInfo,
    };
  }

  /**
   * Seçili tüm köylülere verilen ağaca ayrı kenarlardan yürüyüp odun kesme emri verir.
   */
  public commandHarvestSelectedTree(tree: TreeResourceNode): boolean {
    const selected = this.getSelectedVillagers();
    if (selected.length === 0) {
      return false;
    }

    const obstacleQuery = this.createObstacleQuery();
    const sorted = [...selected].sort((a, b) => {
      const pa = a.getGridPosition();
      const pb = b.getGridPosition();
      return (
        Math.hypot(pa.col - tree.tile.col, pa.row - tree.tile.row) -
        Math.hypot(pb.col - tree.tile.col, pb.row - tree.tile.row)
      );
    });

    const selectedSet = new Set(sorted.map((u) => u.id));
    const reservedSpots: GridCoord[] = [];

    for (const unit of sorted) {
      const startPos = unit.getGridPosition();
      const distToTree = Math.hypot(
        startPos.col - tree.tile.col,
        startPos.row - tree.tile.row
      );

      if (
        distToTree >= 0.74 &&
        distToTree <= 1.1 &&
        !this.isSpotCrowded(unit.id, startPos, selectedSet, reservedSpots)
      ) {
        reservedSpots.push({ col: startPos.col, row: startPos.row });
        unit.setHarvestTreeOrder(tree.id, [], this.worldContext);
        continue;
      }

      const standSpot = this.computeBestStandSpot(
        unit.id,
        startPos,
        tree.tile,
        obstacleQuery,
        selectedSet,
        reservedSpots
      );

      if (standSpot) {
        reservedSpots.push(standSpot);
        const waypoints = findSmoothGridPath(startPos, standSpot, obstacleQuery);
        unit.setHarvestTreeOrder(tree.id, waypoints, this.worldContext);
      } else {
        unit.setHarvestTreeOrder(tree.id, [], this.worldContext);
      }
    }

    const treeWorld = this.isoGrid.tileToWorld(tree.tile.col, tree.tile.row);
    this.playOrderFeedback(treeWorld.x, treeWorld.y, 0xf59e0b);
    return true;
  }

  /**
   * Seçili tüm köylülere ellerindeki odunu ortak depoya götürme emri verir.
   */
  public commandDeliverSelectedToDepot(): boolean {
    const selected = this.getSelectedVillagers();
    if (selected.length === 0) {
      return false;
    }

    const depotTile = this.woodDepot.getTile();
    const obstacleQuery = this.createObstacleQuery();
    const sorted = [...selected].sort((a, b) => {
      const pa = a.getGridPosition();
      const pb = b.getGridPosition();
      return (
        Math.hypot(pa.col - depotTile.col, pa.row - depotTile.row) -
        Math.hypot(pb.col - depotTile.col, pb.row - depotTile.row)
      );
    });

    const selectedSet = new Set(sorted.map((u) => u.id));
    const reservedSpots: GridCoord[] = [];

    for (const unit of sorted) {
      const startPos = unit.getGridPosition();
      const standSpot = this.computeBestStandSpot(
        unit.id,
        startPos,
        depotTile,
        obstacleQuery,
        selectedSet,
        reservedSpots
      );
      if (standSpot) {
        reservedSpots.push(standSpot);
        const waypoints = findSmoothGridPath(startPos, standSpot, obstacleQuery);
        unit.setDeliverToDepotOrder(this.worldContext, waypoints);
      } else {
        unit.setDeliverToDepotOrder(this.worldContext);
      }
    }

    const depotWorld = this.woodDepot.getWorldPosition();
    this.playOrderFeedback(depotWorld.x, depotWorld.y, 0x38bdf8);
    return true;
  }

  /**
   * Seçili tek veya çoklu köylüleri verilen dünya koordinatına üst üste binmeyecek
   * düzenli formasyon noktalarıyla yürütür.
   */
  public commandMoveSelectedToWorld(worldX: number, worldY: number): boolean {
    const selected = this.getSelectedVillagers();
    if (selected.length === 0) {
      return false;
    }

    if (!this.isoGrid.isWorldPointOnMap(worldX, worldY)) {
      return false;
    }

    const rawTile = this.isoGrid.worldToTile(worldX, worldY);
    const obstacleQuery = this.createObstacleQuery();
    const selectedSet = new Set(selected.map((u) => u.id));

    const assignments = this.computeGroupFormationAssignments(
      selected,
      rawTile,
      obstacleQuery,
      selectedSet
    );

    let anyMoved = false;
    for (const { unit, goal } of assignments) {
      const startPos = unit.getGridPosition();
      const waypoints = findSmoothGridPath(startPos, goal, obstacleQuery);
      if (waypoints.length > 0) {
        unit.setMovePath(waypoints);
        anyMoved = true;
      } else {
        unit.stopMovement();
      }
    }

    if (anyMoved) {
      const clampedCenter = this.isoGrid.clampContinuousTile(
        rawTile.col,
        rawTile.row,
        0.26
      );
      const feedbackWorld = this.isoGrid.tileToWorld(
        clampedCenter.col,
        clampedCenter.row
      );
      this.playOrderFeedback(feedbackWorld.x, feedbackWorld.y, 0x4ade80);
    }

    return anyMoved;
  }

  public update(deltaMs: number): void {
    for (const unit of this.villagers.values()) {
      unit.update(deltaMs, this.worldContext);
    }
    this.applyDynamicUnitSeparation(deltaMs);
  }

  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    this.ignoredWorldCameras.add(camera);
    camera.ignore(this.moveMarker);
    for (const unit of this.villagers.values()) {
      unit.ignoreOnCamera(camera);
    }
  }

  public destroy(): void {
    this.scene.input.off('pointerdown', this.handlePointerDown, this);
    this.scene.input.off('pointermove', this.handlePointerMove, this);
    this.scene.input.off('pointerup', this.handlePointerUp, this);
    this.scene.input.off('pointerupoutside', this.handlePointerUpOutside, this);
    this.scene.input.setDefaultCursor('default');
    this.moveMarkerTween?.stop();
    this.moveMarker.destroy();
    this.marqueeGraphics.destroy();
    for (const unit of this.villagers.values()) {
      unit.destroy();
    }
    this.villagers.clear();
    this.selectedVillagerIds.clear();
    this.ignoredWorldCameras.clear();
  }

  private syncSelectionRings(): void {
    for (const [vid, unit] of this.villagers.entries()) {
      unit.setSelected(this.selectedVillagerIds.has(vid));
    }
  }

  /**
   * Köylüler yürürken ve dururken birbirlerinin üstüne binmemeleri için kare bazlı
   * yumuşak ve engel-güvenli ayrışma (steering separation) uygular.
   */
  private applyDynamicUnitSeparation(deltaMs: number): void {
    const units = Array.from(this.villagers.values());
    if (units.length < 2) {
      return;
    }

    const dt = Math.min(deltaMs, 50) / 1000;
    const isWalkablePos = (col: number, row: number): boolean =>
      this.isContinuousPositionWalkable(col, row);

    const offsets = new Map<string, { dc: number; dr: number }>();
    for (const u of units) {
      offsets.set(u.id, { dc: 0, dr: 0 });
    }

    for (let i = 0; i < units.length; i += 1) {
      for (let j = i + 1; j < units.length; j += 1) {
        const a = units[i];
        const b = units[j];
        const posA = a.getGridPosition();
        const posB = b.getGridPosition();

        let dc = posA.col - posB.col;
        let dr = posA.row - posB.row;
        let dist = Math.hypot(dc, dr);

        if (dist >= DYNAMIC_SEPARATION_RADIUS) {
          continue;
        }

        if (dist < 0.001) {
          const fallbackAngle = (i * 2.1 + j * 1.3) % (Math.PI * 2);
          dc = Math.cos(fallbackAngle);
          dr = Math.sin(fallbackAngle);
          dist = 1;
        } else {
          dc /= dist;
          dr /= dist;
        }

        const overlap = DYNAMIC_SEPARATION_RADIUS - dist;
        const overlapRatio = overlap / DYNAMIC_SEPARATION_RADIUS;
        const pushMagnitude = Math.min(
          overlap * 0.48,
          2.4 * (0.35 + overlapRatio) * dt
        );

        const aMoving = a.isMoving();
        const bMoving = b.isMoving();
        const aChopping = a.getState() === 'chopping';
        const bChopping = b.getState() === 'chopping';

        let weightA = 0.5;
        let weightB = 0.5;

        if (aMoving && !bMoving) {
          weightA = 1.0;
          weightB = 0.0;
        } else if (!aMoving && bMoving) {
          weightA = 0.0;
          weightB = 1.0;
        } else if (aChopping && bChopping) {
          weightA = 0.15;
          weightB = 0.15;
        } else if (aChopping && !bMoving) {
          weightA = 0.0;
          weightB = 1.0;
        } else if (bChopping && !aMoving) {
          weightA = 1.0;
          weightB = 0.0;
        }

        const offA = offsets.get(a.id)!;
        const offB = offsets.get(b.id)!;

        offA.dc += dc * pushMagnitude * weightA;
        offA.dr += dr * pushMagnitude * weightA;
        offB.dc -= dc * pushMagnitude * weightB;
        offB.dr -= dr * pushMagnitude * weightB;
      }
    }

    for (const u of units) {
      const off = offsets.get(u.id)!;
      u.applySeparationOffset(off.dc, off.dr, isWalkablePos);
    }
  }

  /**
   * Sürekli (floating-point) bir ızgara koordinatının harita sınırları içinde ve
   * ağaç/depo engellerinden güvenli mesafede olup olmadığını doğrular.
   */
  private isContinuousPositionWalkable(col: number, row: number): boolean {
    const cols = this.isoGrid.getCols();
    const rows = this.isoGrid.getRows();
    if (col < 0.25 || col > cols - 1.25 || row < 0.25 || row > rows - 1.25) {
      return false;
    }

    const minC = Math.max(0, Math.floor(col) - 1);
    const maxC = Math.min(cols - 1, Math.ceil(col) + 1);
    const minR = Math.max(0, Math.floor(row) - 1);
    const maxR = Math.min(rows - 1, Math.ceil(row) + 1);

    for (let r = minR; r <= maxR; r += 1) {
      for (let c = minC; c <= maxC; c += 1) {
        const blocked =
          this.forestSystem.getTreeAt(c, r) !== undefined ||
          this.woodDepot.occupiesTile(c, r);
        if (blocked && Math.hypot(col - c, row - r) < 0.76) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Seçili köylü grubu için tıklanan hedef etrafında birbirine çakışmayan ve
   * yolların çapraz kesişmesini en aza indiren formasyon hedefleri üretir.
   */
  private computeGroupFormationAssignments(
    units: Villager[],
    rawCenter: GridCoord,
    grid: GridObstacleQuery,
    movingIds: ReadonlySet<string>
  ): Array<{ unit: Villager; goal: GridCoord }> {
    const center = this.isoGrid.clampContinuousTile(
      rawCenter.col,
      rawCenter.row,
      0.28
    );

    if (units.length === 1) {
      const singleGoal = this.findNearestValidGroundSpot(
        center,
        grid,
        movingIds,
        []
      );
      return [{ unit: units[0], goal: singleGoal }];
    }

    // Grubun ağırlık merkezinden hedefe gidiş yönünü bul ve dikey eksende yan yana diz
    let avgCol = 0;
    let avgRow = 0;
    for (const u of units) {
      const p = u.getGridPosition();
      avgCol += p.col;
      avgRow += p.row;
    }
    avgCol /= units.length;
    avgRow /= units.length;

    let fwdC = center.col - avgCol;
    let fwdR = center.row - avgRow;
    const fwdLen = Math.hypot(fwdC, fwdR);
    if (fwdLen > 0.05) {
      fwdC /= fwdLen;
      fwdR /= fwdLen;
    } else {
      fwdC = 0.7071;
      fwdR = 0.7071;
    }

    // İlerleme yönüne dik (yan yana) birim vektör
    const rightC = -fwdR;
    const rightR = fwdC;

    const count = units.length;
    const colsPerRow = Math.min(3, count);
    const totalRows = Math.ceil(count / colsPerRow);

    const slots: GridCoord[] = [];
    for (let idx = 0; idx < count; idx += 1) {
      const rIdx = Math.floor(idx / colsPerRow);
      const itemsInThisRow =
        rIdx === totalRows - 1 ? count - rIdx * colsPerRow : colsPerRow;
      const cIdx = idx - rIdx * colsPerRow;

      const lateralOffset =
        (cIdx - (itemsInThisRow - 1) * 0.5) * FORMATION_SPACING;
      const depthOffset =
        (rIdx - (totalRows - 1) * 0.5) * (FORMATION_SPACING * 0.92);

      const desiredSlot: GridCoord = {
        col: center.col + rightC * lateralOffset - fwdC * depthOffset,
        row: center.row + rightR * lateralOffset - fwdR * depthOffset,
      };

      const validSlot = this.findNearestValidGroundSpot(
        desiredSlot,
        grid,
        movingIds,
        slots
      );
      slots.push(validSlot);
    }

    // Yolların birbirini kesmemesi için sol-sağ izdüşümüne göre eşleştir
    const sortedUnits = [...units].sort((a, b) => {
      const pa = a.getGridPosition();
      const pb = b.getGridPosition();
      return pa.col * rightC + pa.row * rightR - (pb.col * rightC + pb.row * rightR);
    });

    const sortedSlots = [...slots].sort(
      (a, b) => a.col * rightC + a.row * rightR - (b.col * rightC + b.row * rightR)
    );

    return sortedUnits.map((unit, index) => ({
      unit,
      goal: sortedSlots[index],
    }));
  }

  private findNearestValidGroundSpot(
    desired: GridCoord,
    grid: GridObstacleQuery,
    ignoredVillagerIds: ReadonlySet<string>,
    reservedSpots: readonly GridCoord[]
  ): GridCoord {
    const base = this.isoGrid.clampContinuousTile(
      desired.col,
      desired.row,
      0.28
    );

    const isAcceptable = (pt: GridCoord): boolean => {
      const tc = Math.round(pt.col);
      const tr = Math.round(pt.row);
      if (grid.isTileBlocked(tc, tr)) {
        return false;
      }
      if (!this.isContinuousPositionWalkable(pt.col, pt.row)) {
        return false;
      }
      return !this.isSpotCrowded(
        '',
        pt,
        ignoredVillagerIds,
        reservedSpots
      );
    };

    if (isAcceptable(base)) {
      return base;
    }

    const radii = [0.68, 1.15, 1.65];
    const angles = [0, 45, -45, 90, -90, 135, -135, 180];
    for (const radius of radii) {
      for (const deg of angles) {
        const rad = Phaser.Math.DegToRad(deg);
        const candidate = this.isoGrid.clampContinuousTile(
          base.col + Math.cos(rad) * radius,
          base.row + Math.sin(rad) * radius,
          0.28
        );
        if (isAcceptable(candidate)) {
          return candidate;
        }
      }
    }

    return base;
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
      obstacleQuery,
      new Set([requester.id]),
      []
    );
    if (!standSpot) {
      return [];
    }
    return findSmoothGridPath(fromPos, standSpot, obstacleQuery);
  }

  private computeBestStandSpot(
    requesterId: string,
    fromPos: GridCoord,
    targetTile: GridCoord,
    grid: GridObstacleQuery,
    ignoredIds: ReadonlySet<string>,
    reservedSpots: readonly GridCoord[]
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
      { dc: -1, dr: 1, bias: 0.32 },
      { dc: 1, dr: -1, bias: 0.32 },
      { dc: 1, dr: 1, bias: 0.42 },
      { dc: -1, dr: -1, bias: 0.42 },
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
      const crowded = this.isSpotCrowded(
        requesterId,
        { col: spotCol, row: spotRow },
        ignoredIds,
        reservedSpots
      );
      const crowdPenalty = crowded ? 6.0 : 0;

      const score = dist + bias + crowdPenalty;
      if (score < bestScore) {
        bestScore = score;
        bestSpot = { col: spotCol, row: spotRow };
      }
    }

    return bestSpot;
  }

  private isSpotCrowded(
    requesterId: string,
    spot: GridCoord,
    ignoredIds: ReadonlySet<string>,
    reservedSpots: readonly GridCoord[]
  ): boolean {
    for (const rSpot of reservedSpots) {
      if (
        Math.hypot(rSpot.col - spot.col, rSpot.row - spot.row) <
        MIN_VILLAGER_SEPARATION
      ) {
        return true;
      }
    }

    for (const [vid, other] of this.villagers.entries()) {
      if (vid === requesterId || ignoredIds.has(vid)) {
        continue;
      }

      const pos = other.getGridPosition();
      if (
        !other.isMoving() &&
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
    this.scene.input.on('pointerdown', this.handlePointerDown, this);
    this.scene.input.on('pointermove', this.handlePointerMove, this);
    this.scene.input.on('pointerup', this.handlePointerUp, this);
    this.scene.input.on('pointerupoutside', this.handlePointerUpOutside, this);
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.isScreenUiBlocked?.(pointer.x, pointer.y)) {
      this.cancelMarqueeDrag();
      return;
    }

    // İki parmak yakınlaştırma başladığında kutu seçim adaylığını iptal et
    if (this.scene.input.pointer1?.isDown && this.scene.input.pointer2?.isDown) {
      this.cancelMarqueeDrag();
      return;
    }

    const isTouch = pointer.wasTouch;
    const canStartDesktopMarquee =
      !isTouch &&
      pointer.button === 0 &&
      !this.cameraController.isSpacePanHeld();
    const canStartTouchMarquee = isTouch && this.touchBoxSelectMode;

    if (canStartDesktopMarquee || canStartTouchMarquee) {
      this.isMarqueeCandidate = true;
      this.isMarqueeDragging = false;
      this.marqueePointerId = pointer.id;
      this.marqueeStartX = pointer.x;
      this.marqueeStartY = pointer.y;
      const shiftHeld = Boolean(
        (pointer.event as MouseEvent | undefined)?.shiftKey
      );
      this.marqueeAdditive = shiftHeld;
      this.marqueeBaseSelection = new Set(
        shiftHeld ? this.selectedVillagerIds : []
      );
    }
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.scene.input.pointer1?.isDown && this.scene.input.pointer2?.isDown) {
      if (this.isMarqueeCandidate || this.isMarqueeDragging) {
        this.cancelMarqueeDrag();
      }
      return;
    }

    if (
      this.isMarqueeCandidate &&
      pointer.isDown &&
      pointer.id === this.marqueePointerId
    ) {
      const dist = Phaser.Math.Distance.Between(
        this.marqueeStartX,
        this.marqueeStartY,
        pointer.x,
        pointer.y
      );

      if (!this.isMarqueeDragging && dist >= MARQUEE_DRAG_THRESHOLD_PX) {
        this.isMarqueeDragging = true;
      }

      if (this.isMarqueeDragging) {
        this.drawAndApplyMarquee(
          this.marqueeStartX,
          this.marqueeStartY,
          pointer.x,
          pointer.y
        );
        return;
      }
    }

    if (!pointer.wasTouch && !pointer.isDown) {
      this.updateHoverCursor(pointer);
    }
  }

  private handlePointerUpOutside(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.marqueePointerId) {
      this.finishMarqueeIfActive(pointer.wasTouch);
    }
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    if (pointer.id === this.marqueePointerId && this.isMarqueeDragging) {
      this.drawAndApplyMarquee(
        this.marqueeStartX,
        this.marqueeStartY,
        pointer.x,
        pointer.y
      );
      this.finishMarqueeIfActive(pointer.wasTouch);
      return;
    }

    this.cancelMarqueeDrag();

    if (this.isScreenUiBlocked?.(pointer.x, pointer.y)) {
      return;
    }

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
    const now = this.scene.time.now;

    if (isTouch) {
      // MOBİL DOKUNMATİK KONTROLLER:
      if (this.touchBoxSelectMode) {
        // Kutu Seç modundayken tek dokunuş köylüleri çoklu seçime ekler/çıkarır
        if (hitVillager) {
          this.toggleVillagerSelection(hitVillager.id);
        }
        return;
      }

      if (hitVillager) {
        if (
          this.lastTappedVillagerId === hitVillager.id &&
          now - this.lastVillagerTapTime <= DOUBLE_TAP_WINDOW_MS
        ) {
          this.selectAllVillagers();
          this.lastTappedVillagerId = null;
        } else {
          this.selectSingleVillager(hitVillager.id);
          this.lastTappedVillagerId = hitVillager.id;
          this.lastVillagerTapTime = now;
        }
        return;
      }

      if (this.selectedVillagerIds.size > 0) {
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
    const isLeftClick =
      pointer.button === 0 &&
      !isRightClick &&
      !this.cameraController.isSpacePanHeld();

    if (isLeftClick) {
      const shiftHeld = Boolean(
        (pointer.event as MouseEvent | undefined)?.shiftKey
      );

      if (hitVillager) {
        if (shiftHeld) {
          this.toggleVillagerSelection(hitVillager.id);
        } else if (
          this.lastTappedVillagerId === hitVillager.id &&
          now - this.lastVillagerTapTime <= DOUBLE_TAP_WINDOW_MS
        ) {
          this.selectAllVillagers();
          this.lastTappedVillagerId = null;
        } else {
          this.selectSingleVillager(hitVillager.id);
          this.lastTappedVillagerId = hitVillager.id;
          this.lastVillagerTapTime = now;
        }
      } else if (!shiftHeld) {
        this.clearSelection();
      }
      return;
    }

    if (isRightClick && this.selectedVillagerIds.size > 0) {
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
   * Seçim dikdörtgenini ekranda çizer ve dikdörtgenin kapsadığı tüm köylüleri anlık seçer.
   */
  private drawAndApplyMarquee(
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): void {
    const minScreenX = Math.min(x1, x2);
    const minScreenY = Math.min(y1, y2);
    const maxScreenX = Math.max(x1, x2);
    const maxScreenY = Math.max(y1, y2);
    const rectW = Math.max(1, maxScreenX - minScreenX);
    const rectH = Math.max(1, maxScreenY - minScreenY);

    this.marqueeGraphics.clear();
    this.marqueeGraphics.fillStyle(0x22c55e, 0.16);
    this.marqueeGraphics.fillRect(minScreenX, minScreenY, rectW, rectH);
    this.marqueeGraphics.lineStyle(1.5, 0x4ade80, 0.95);
    this.marqueeGraphics.strokeRect(minScreenX, minScreenY, rectW, rectH);
    this.marqueeGraphics.setVisible(true);

    const cam = this.scene.cameras.main;
    const worldTopLeft = cam.getWorldPoint(minScreenX, minScreenY);
    const worldBottomRight = cam.getWorldPoint(maxScreenX, maxScreenY);

    const wMinX = Math.min(worldTopLeft.x, worldBottomRight.x);
    const wMaxX = Math.max(worldTopLeft.x, worldBottomRight.x);
    const wMinY = Math.min(worldTopLeft.y, worldBottomRight.y);
    const wMaxY = Math.max(worldTopLeft.y, worldBottomRight.y);

    const nextSelection = new Set<string>(
      this.marqueeAdditive ? this.marqueeBaseSelection : []
    );

    for (const [id, unit] of this.villagers.entries()) {
      if (unit.intersectsWorldRect(wMinX, wMinY, wMaxX, wMaxY)) {
        nextSelection.add(id);
      }
    }

    this.selectedVillagerIds.clear();
    for (const id of nextSelection) {
      this.selectedVillagerIds.add(id);
    }
    this.syncSelectionRings();
  }

  private finishMarqueeIfActive(wasTouch: boolean): void {
    const hadBoxSelection =
      this.isMarqueeDragging && this.selectedVillagerIds.size > 0;
    this.cancelMarqueeDrag();

    // Mobilde kutu içine köylü alındıysa bir sonraki dokunuşla hemen emir verilebilsin
    if (wasTouch && this.touchBoxSelectMode && hadBoxSelection) {
      this.touchBoxSelectMode = false;
    }
  }

  private cancelMarqueeDrag(): void {
    this.isMarqueeCandidate = false;
    this.isMarqueeDragging = false;
    this.marqueePointerId = -1;
    this.marqueeAdditive = false;
    this.marqueeBaseSelection.clear();
    this.marqueeGraphics.clear();
    this.marqueeGraphics.setVisible(false);
  }

  private updateHoverCursor(pointer: Phaser.Input.Pointer): void {
    if (this.isScreenUiBlocked?.(pointer.x, pointer.y)) {
      this.scene.input.setDefaultCursor('pointer');
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

    if (this.selectedVillagerIds.size > 0) {
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

    for (const cam of this.ignoredWorldCameras) {
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

    for (const cam of this.ignoredWorldCameras) {
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
