/**
 * Karahanlı RTS — Ana Giriş Dosyası
 *
 * Phaser 3 + TypeScript + Vite tabanlı 2D gerçek zamanlı strateji oyunu.
 * Genişletilmiş 16x16 dikişsiz izometrik çimen haritayı, doğal koruluk
 * yerleşimindeki 2 kayın + 2 çam odun kaynağını (her biri 100 odun) ve
 * masaüstü/mobil uyumlu kamera ölçekleme-kaydırma sistemini sahnede çalıştırır.
 */

import Phaser from 'phaser';
import { MapCameraController } from './cameraController';
import { ForestSystem } from './forestSystem';
import { IsoGrid } from './isoGrid';

/** Arayüz (UI) metinleri için en üst derinlik katmanı */
const UI_DEPTH = 5000;

/** Üst başlık alanı için ayrılan ekran yüksekliği (px) */
const TOP_HUD_INSET = 78;

class MainScene extends Phaser.Scene {
  private isoGrid?: IsoGrid;
  private forestSystem?: ForestSystem;
  private cameraController?: MapCameraController;
  private uiCamera?: Phaser.Cameras.Scene2D.Camera;
  private titleText?: Phaser.GameObjects.Text;
  private subtitleText?: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'MainScene' });
  }

  public preload(): void {
    ForestSystem.preload(this);
  }

  public create(): void {
    const { width, height } = this.scale;

    // 16x16 boyutunda, 64x32 piksel (2:1) dikişsiz izometrik çimen harita (dünya merkezinde: 0, 0)
    this.isoGrid = new IsoGrid(this, {
      cols: 16,
      rows: 16,
      tileWidth: 64,
      tileHeight: 32,
    });
    this.isoGrid.setPosition(0, 0);

    // Kuzeybatı iç çayırında doğal koruluk yerleşimi (2 kayın + 2 çam, her biri 100 odun)
    this.forestSystem = new ForestSystem(this, this.isoGrid);
    this.forestSystem.populate();

    // Sabit üst başlık ve alt bilgi metinleri
    this.titleText = this.add
      .text(0, 0, 'KARAHANLI RTS', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '22px',
        fontStyle: 'bold',
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0)
      .setDepth(UI_DEPTH);

    this.subtitleText = this.add
      .text(
        0,
        0,
        '16x16 İzometrik Çimen Harita — Doğal Koruluk (2 Kayın, 2 Çam • Her Ağaç 100 Odun)',
        {
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: '13px',
          color: '#94a3b8',
          align: 'center',
        }
      )
      .setOrigin(0.5, 0)
      .setDepth(UI_DEPTH);

    // Arayüz metinlerini yakınlaştırmadan/kaydırmadan bağımsız tutan şeffaf HUD kamerası
    this.uiCamera = this.cameras.add(0, 0, width, height, false, 'HudCamera');
    this.cameras.main.ignore([this.titleText, this.subtitleText]);
    const terrainImg = this.isoGrid.getTerrainImage();
    if (terrainImg) {
      this.uiCamera.ignore(terrainImg);
    }
    this.forestSystem.ignoreOnCamera(this.uiCamera);

    // 16x16 harita için ekran ölçekleme, sürükleme ve yakınlaştırma kontrolcüsü
    const mapSize = this.isoGrid.getWorldSize();
    this.cameraController = new MapCameraController(this, this.cameras.main, {
      mapWidth: mapSize.width,
      mapHeight: mapSize.height,
      topUiInset: TOP_HUD_INSET,
    });

    this.layoutHud(width);
    this.scale.on('resize', this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
  }

  public update(_time: number, delta: number): void {
    this.cameraController?.update(delta);
  }

  private layoutHud(width: number): void {
    const isCompact = width < 560;
    this.titleText?.setFontSize(isCompact ? 18 : 22);
    this.subtitleText?.setFontSize(isCompact ? 11 : 13);
    this.subtitleText?.setWordWrapWidth(Math.max(width - 24, 240));

    this.titleText?.setPosition(width / 2, isCompact ? 14 : 20);
    this.subtitleText?.setPosition(width / 2, isCompact ? 38 : 50);
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    this.uiCamera?.setSize(width, height);
    this.layoutHud(width);
    this.cameraController?.handleResize(width, height);
  }

  private cleanup(): void {
    this.scale.off('resize', this.handleResize, this);
    this.cameraController?.destroy();
    this.forestSystem?.destroy();
    this.isoGrid?.destroy();
  }
}

const gameConfig: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: 'game-container',
  backgroundColor: '#0f172a',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  render: {
    antialias: true,
    roundPixels: false,
  },
  scene: [MainScene],
};

new Phaser.Game(gameConfig);
