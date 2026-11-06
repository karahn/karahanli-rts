/**
 * Karahanlı RTS — Ana Başlangıç Dosyası
 * Bu proje, Karahanlı RTS (Gerçek Zamanlı Strateji) oyunu için
 * Phaser 3 ve TypeScript kullanılarak hazırlanmış temel oyun altyapısıdır.
 */

import Phaser from 'phaser';
import { IsoGrid } from './isoGrid';

const STEPPE_TREE_TILE = { col: 3, row: 3 } as const;

// 2x HD (230×202) bozkır ağacı sprite'ı temizlenmiş 3B kök taban merkezi: (111, 182)
const STEPPE_TREE_ORIGIN_X = 111 / 230;
const STEPPE_TREE_ORIGIN_Y = 182 / 202;
const STEPPE_SPRITE_SCALE = 0.5;

class MainScene extends Phaser.Scene {
  private isoGrid?: IsoGrid;
  private steppeTree?: Phaser.GameObjects.Image;
  private titleText?: Phaser.GameObjects.Text;
  private subtitleText?: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'MainScene' });
  }

  preload(): void {
    this.load.image('steppe-tree', 'assets/sprites/steppe_tree.png');
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

    const treePos = this.isoGrid.tileToWorld(
      STEPPE_TREE_TILE.col,
      STEPPE_TREE_TILE.row
    );

    // Kök tabanı ve hafif temas gölgesi doğrudan karo merkezine oturan bozkır ağacı
    this.steppeTree = this.add
      .image(treePos.x, treePos.y, 'steppe-tree')
      .setOrigin(STEPPE_TREE_ORIGIN_X, STEPPE_TREE_ORIGIN_Y)
      .setScale(STEPPE_SPRITE_SCALE)
      .setDepth(
        this.isoGrid.getTileDepth(STEPPE_TREE_TILE.col, STEPPE_TREE_TILE.row)
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

    if (this.isoGrid && this.steppeTree) {
      const treePos = this.isoGrid.tileToWorld(
        STEPPE_TREE_TILE.col,
        STEPPE_TREE_TILE.row
      );
      this.steppeTree.setPosition(treePos.x, treePos.y);
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
