/**
 * Karahanlı RTS — Ana Başlangıç Dosyası
 * Bu proje, Karahanlı RTS (Gerçek Zamanlı Strateji) oyunu için
 * Phaser 3 ve TypeScript kullanılarak hazırlanmış temel oyun altyapısıdır.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';

const TEST_TREE_TILE = { col: 3, row: 3 } as const;
// 105×108 sprite içinde gövde kök tabanının yere bastığı piksel (45, 93)
const TREE_ORIGIN_X = 45 / 105;
const TREE_ORIGIN_Y = 93 / 108;

class MainScene extends Phaser.Scene {
  private isoGrid?: IsoGrid;
  private testTree?: Phaser.GameObjects.Image;
  private titleText?: Phaser.GameObjects.Text;
  private subtitleText?: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'MainScene' });
  }

  preload(): void {
    this.load.image('tree-karagach', 'assets/sprites/tree_karagach.png');
  }

  create(): void {
    const { width, height } = this.scale;

    this.isoGrid = new IsoGrid(this, {
      cols: 8,
      rows: 8,
      tileWidth: 64,
      tileHeight: 32
    });
    this.isoGrid.setPosition(width / 2, height / 2 + 20);

    // 8×8 harita üzerinde tek adet Orta Asya karaağaç (Karagach) test ağacı
    const treePos = this.isoGrid.tileToWorld(
      TEST_TREE_TILE.col,
      TEST_TREE_TILE.row
    );
    this.testTree = this.add
      .image(treePos.x, treePos.y, 'tree-karagach')
      .setOrigin(TREE_ORIGIN_X, TREE_ORIGIN_Y)
      .setDepth(
        this.isoGrid.getTileDepth(TEST_TREE_TILE.col, TEST_TREE_TILE.row)
      );

    this.titleText = this.add
      .text(width / 2, 42, 'KARAHANLI RTS', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '32px',
        fontStyle: 'bold',
        color: '#f59e0b'
      })
      .setOrigin(0.5)
      .setDepth(5000);

    this.subtitleText = this.add
      .text(width / 2, 76, 'İzometrik Çimen Arazi (8×8 Harita • 64×32 Tile)', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '15px',
        color: '#94a3b8'
      })
      .setOrigin(0.5)
      .setDepth(5000);

    this.scale.on('resize', this.handleResize, this);
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    this.isoGrid?.setPosition(width / 2, height / 2 + 20);

    if (this.isoGrid && this.testTree) {
      const treePos = this.isoGrid.tileToWorld(
        TEST_TREE_TILE.col,
        TEST_TREE_TILE.row
      );
      this.testTree.setPosition(treePos.x, treePos.y);
    }

    this.titleText?.setPosition(width / 2, 42);
    this.subtitleText?.setPosition(width / 2, 76);
  }

  update(_time: number, _delta: number): void {
    // Ana oyun döngüsü buraya eklenecek
  }
}

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0f172a',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: '100%',
    height: '100%'
  },
  scene: [MainScene]
};

export default new Phaser.Game(config);
