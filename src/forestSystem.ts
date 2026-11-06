/**
 * Karahanlı RTS — Küçük Orman ve Odun Kaynağı Altyapısı (ForestSystem)
 *
 * 16x16 harita üzerindeki kayın ve çam ağaçlarını odun kaynağı düğümleri
 * (TreeResourceNode) olarak yönetir. Köylülerin ağaçlara tıklayarak odun
 * toplaması, her darbede ağacın 100 odunluk kaynağının azalması ve odunu
 * sıfırlanan ağacın haritadan kaldırılması işlemlerini yürütür.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';

/** Desteklenen ağaç türleri */
export type TreeType = 'kayin' | 'cam';

/** Her ağacın başlangıç odun kaynağı miktarı */
export const INITIAL_WOOD_AMOUNT = 100;

interface TreeVisualSpec {
  textureKey: string;
  assetPath: string;
  /** Kök tabanının yatay merkez oranı (0..1) */
  originX: number;
  /** Köklerin çimene temas ettiği dikey taban oranı (0..1) */
  originY: number;
  defaultScale: number;
}

const TREE_SPECS: Record<TreeType, TreeVisualSpec> = {
  kayin: {
    textureKey: 'tree_kayin',
    assetPath: 'assets/sprites/steppe_tree.png',
    originX: 111 / 230,
    originY: 182 / 202,
    defaultScale: 0.54,
  },
  cam: {
    textureKey: 'tree_cam',
    assetPath: 'assets/sprites/pine_tree.png',
    originX: 65 / 129,
    originY: 207 / 228,
    defaultScale: 0.6,
  },
};

/** Haritaya yerleştirilecek bir ağacın başlangıç tanımı */
export interface TreeSpawnConfig {
  id: string;
  treeType: TreeType;
  col: number;
  row: number;
  woodAmount?: number;
  scale?: number;
}

/** Sahnedeki canlı bir ağaç/odun kaynağı düğümü */
export interface TreeResourceNode {
  readonly id: string;
  readonly treeType: TreeType;
  woodAmount: number;
  readonly maxWoodAmount: number;
  readonly tile: { col: number; row: number };
  readonly scale: number;
  readonly sprite: Phaser.GameObjects.Image;
}

/** Bir balta vuruşu sonucunda ağaçtan alınan odun özeti */
export interface WoodHarvestResult {
  harvested: number;
  remaining: number;
  depleted: boolean;
  treeType?: TreeType;
  worldPos?: { x: number; y: number };
}

/**
 * 16x16 haritanın kuzeybatı iç çayırında doğal bir koruluk (pocket woodland) yerleşimi:
 * - 2 kayın + 2 çam ağacı üst kenara duvar gibi dizilmeden organik küme oluşturur
 * - Ağaçların arasında köylülerin rahatça yürüyebileceği 1-2 karoluk doğal açıklıklar bulunur
 * - Haritanın geniş orta, doğu ve güney düzlükleri (col 6..15, row 3..15) tamamen açıktır
 */
export const INITIAL_FOREST_LAYOUT: readonly TreeSpawnConfig[] = [
  { id: 'wood_cam_1', treeType: 'cam', col: 4, row: 4, scale: 0.62 },
  { id: 'wood_kayin_1', treeType: 'kayin', col: 2, row: 6, scale: 0.55 },
  { id: 'wood_cam_2', treeType: 'cam', col: 5, row: 7, scale: 0.59 },
  { id: 'wood_kayin_2', treeType: 'kayin', col: 3, row: 9, scale: 0.53 },
];

export class ForestSystem {
  private readonly scene: Phaser.Scene;
  private readonly isoGrid: IsoGrid;
  private readonly nodesById = new Map<string, TreeResourceNode>();
  private readonly nodesByTile = new Map<string, TreeResourceNode>();
  private readonly ignoredCameras = new Set<Phaser.Cameras.Scene2D.Camera>();
  private readonly hitTweens = new Map<string, Phaser.Tweens.Tween>();

  constructor(scene: Phaser.Scene, isoGrid: IsoGrid) {
    this.scene = scene;
    this.isoGrid = isoGrid;
  }

  /**
   * Kayın ve çam ağacı görsellerini Phaser önbelleğine yükler.
   */
  public static preload(scene: Phaser.Scene): void {
    for (const spec of Object.values(TREE_SPECS)) {
      scene.load.image(spec.textureKey, spec.assetPath);
    }
  }

  /**
   * Verilen ağaç listesini (varsayılan: 2 kayın + 2 çam koruluğu) haritaya yerleştirir.
   */
  public populate(layout: readonly TreeSpawnConfig[] = INITIAL_FOREST_LAYOUT): void {
    for (const item of layout) {
      this.addTree(item);
    }
  }

  /**
   * Tek bir ağacı izometrik karoya yerleştirir ve odun kaynağı olarak kaydeder.
   */
  public addTree(config: TreeSpawnConfig): TreeResourceNode {
    const key = this.tileKey(config.col, config.row);
    if (this.nodesById.has(config.id)) {
      throw new Error(`Ağaç kimliği zaten kullanımda: ${config.id}`);
    }
    if (this.nodesByTile.has(key)) {
      throw new Error(`(${config.col}, ${config.row}) karosunda zaten bir ağaç bulunuyor.`);
    }

    const spec = TREE_SPECS[config.treeType];
    const worldPos = this.isoGrid.tileToWorld(config.col, config.row);
    const scale = config.scale ?? spec.defaultScale;
    const initialWood = config.woodAmount ?? INITIAL_WOOD_AMOUNT;

    const sprite = this.scene.add.image(worldPos.x, worldPos.y, spec.textureKey);
    sprite.setOrigin(spec.originX, spec.originY);
    sprite.setScale(scale);
    sprite.setDepth(this.isoGrid.getTileDepth(config.col, config.row));

    for (const cam of this.ignoredCameras) {
      cam.ignore(sprite);
    }

    const node: TreeResourceNode = {
      id: config.id,
      treeType: config.treeType,
      woodAmount: initialWood,
      maxWoodAmount: initialWood,
      tile: { col: config.col, row: config.row },
      scale,
      sprite,
    };

    this.nodesById.set(node.id, node);
    this.nodesByTile.set(key, node);
    return node;
  }

  /**
   * Ağaçtan belirtilen miktarda odun eksiltir; odun 0'a düştüğünde ağacı
   * haritadan ve veri yapısından otomatik olarak kaldırır.
   */
  public harvestWood(id: string, requestedAmount: number): WoodHarvestResult {
    const node = this.nodesById.get(id);
    if (!node || requestedAmount <= 0) {
      return {
        harvested: 0,
        remaining: node?.woodAmount ?? 0,
        depleted: !node || node.woodAmount <= 0,
      };
    }

    const worldPos = this.isoGrid.tileToWorld(node.tile.col, node.tile.row);
    const treeType = node.treeType;
    const harvested = Math.min(node.woodAmount, requestedAmount);
    node.woodAmount -= harvested;

    if (node.woodAmount <= 0) {
      node.woodAmount = 0;
      this.removeTree(node.id);
      return {
        harvested,
        remaining: 0,
        depleted: true,
        treeType,
        worldPos,
      };
    }

    this.playTrunkImpactShake(node, worldPos.x);
    return {
      harvested,
      remaining: node.woodAmount,
      depleted: false,
      treeType,
      worldPos,
    };
  }

  /**
   * Dünya koordinatındaki (worldX, worldY) bir sağ tık veya dokunmanın hangi
   * ağacın köküne, gövdesine ya da taç yapraklarına isabet ettiğini bulur.
   * Öndeki ağaçlar (yüksek depth) arkadakilere göre önceliklidir.
   */
  public pickTreeAtWorld(
    worldX: number,
    worldY: number,
    isTouch = false
  ): TreeResourceNode | undefined {
    const pad = isTouch ? 9 : 3;
    const candidates = Array.from(this.nodesById.values()).sort(
      (a, b) => b.sprite.depth - a.sprite.depth
    );

    for (const node of candidates) {
      const base = this.isoGrid.tileToWorld(node.tile.col, node.tile.row);
      const dx = worldX - base.x;
      const dy = worldY - base.y;

      if (node.treeType === 'cam') {
        // Çam: kök tabanından konik tepeye uzanan gövde + ibreli dallar alanı
        const topH = 198 * node.scale + pad;
        const botH = 10 + pad;
        if (dy <= botH && dy >= -topH) {
          const heightRatio = Phaser.Math.Clamp(-dy / Math.max(1, topH), 0, 1);
          const halfW = (52 * (1 - heightRatio * 0.65) + 12) * node.scale + pad;
          if (Math.abs(dx) <= halfW) {
            return node;
          }
        }
      } else {
        // Kayın: kök/gövde dikdörtgeni + geniş eliptik yaprak tacı
        const trunkHalfW = 28 * node.scale + pad;
        const inTrunk =
          Math.abs(dx) <= trunkHalfW && dy <= 10 + pad && dy >= -68 * node.scale;

        const crownCenterY = -98 * node.scale;
        const crownRx = 96 * node.scale + pad;
        const crownRy = 72 * node.scale + pad;
        const normX = dx / crownRx;
        const normY = (dy - crownCenterY) / crownRy;
        const inCrown = normX * normX + normY * normY <= 1;

        if (inTrunk || inCrown) {
          return node;
        }
      }
    }

    // Son kontrol: doğrudan ağacın bulunduğu ızgara karosuna tıklandıysa
    const rawTile = this.isoGrid.worldToTile(worldX, worldY);
    return this.getTreeAt(Math.round(rawTile.col), Math.round(rawTile.row));
  }

  /**
   * Belirtilen kameranın (ör. sabit arayüz/HUD kamerası) ağaç sprite'larını
   * çizmemesini sağlar; sonradan eklenecek ağaçlara da otomatik uygulanır.
   */
  public ignoreOnCamera(camera: Phaser.Cameras.Scene2D.Camera): void {
    this.ignoredCameras.add(camera);
    for (const node of this.nodesById.values()) {
      camera.ignore(node.sprite);
    }
  }

  /**
   * Kimliği verilen ağacı sahneden ve veri yapısından güvenli şekilde kaldırır.
   */
  public removeTree(id: string): boolean {
    const node = this.nodesById.get(id);
    if (!node) {
      return false;
    }

    const activeTween = this.hitTweens.get(id);
    if (activeTween) {
      activeTween.stop();
      this.hitTweens.delete(id);
    }

    node.sprite.destroy();
    this.nodesById.delete(id);
    this.nodesByTile.delete(this.tileKey(node.tile.col, node.tile.row));
    return true;
  }

  /** Verilen karodaki ağacı kaldırır. */
  public removeTreeAt(col: number, row: number): boolean {
    const node = this.getTreeAt(col, row);
    return node ? this.removeTree(node.id) : false;
  }

  /** Kimliğe göre ağaç kaynağını döner. */
  public getTree(id: string): TreeResourceNode | undefined {
    return this.nodesById.get(id);
  }

  /** Karo koordinatına göre ağaç kaynağını döner. */
  public getTreeAt(col: number, row: number): TreeResourceNode | undefined {
    return this.nodesByTile.get(this.tileKey(col, row));
  }

  /** Haritadaki tüm aktif ağaç kaynaklarını döner. */
  public getAllTrees(): TreeResourceNode[] {
    return Array.from(this.nodesById.values());
  }

  /**
   * Harita merkezi (IsoGrid) taşındığında tüm ağaçların dünya konumlarını
   * ve izometrik derinliklerini yeniden senkronize eder.
   */
  public syncPositions(): void {
    for (const node of this.nodesById.values()) {
      const pos = this.isoGrid.tileToWorld(node.tile.col, node.tile.row);
      node.sprite.setPosition(pos.x, pos.y);
      node.sprite.setDepth(this.isoGrid.getTileDepth(node.tile.col, node.tile.row));
    }
  }

  /** Tüm ağaç nesnelerini temizler. */
  public destroy(): void {
    for (const tw of this.hitTweens.values()) {
      tw.stop();
    }
    this.hitTweens.clear();
    for (const node of this.nodesById.values()) {
      node.sprite.destroy();
    }
    this.nodesById.clear();
    this.nodesByTile.clear();
    this.ignoredCameras.clear();
  }

  private playTrunkImpactShake(node: TreeResourceNode, baseX: number): void {
    const prev = this.hitTweens.get(node.id);
    if (prev) {
      prev.stop();
      node.sprite.x = baseX;
    }

    const tween = this.scene.tweens.add({
      targets: node.sprite,
      x: baseX + 1.3,
      duration: 45,
      yoyo: true,
      repeat: 1,
      ease: 'Sine.easeInOut',
      onComplete: () => {
        if (node.sprite.active) {
          node.sprite.x = baseX;
        }
        this.hitTweens.delete(node.id);
      },
    });
    this.hitTweens.set(node.id, tween);
  }

  private tileKey(col: number, row: number): string {
    return `${col},${row}`;
  }
}
