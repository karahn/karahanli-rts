/**
 * Karahanlı RTS — Ana Giriş Dosyası
 *
 * Phaser 3 + TypeScript + Vite tabanlı 2D gerçek zamanlı strateji oyunu.
 * 16x16 dikişsiz izometrik çimen haritayı, doğal koruluk yerleşimindeki
 * 2 kayın + 2 çam odun kaynağını (her biri 100 odun), ortak ahşap odun deposunu
 * ve birbirinden bağımsız hareket edip odun toplayabilen çoklu Karahanlı
 * köylülerini (başlangıçta 3 köylü) sahnede çalıştırır.
 */

import Phaser from 'phaser';
import { MapCameraController } from './cameraController';
import { ForestSystem } from './forestSystem';
import { IsoGrid } from './isoGrid';
import { VillagerSystem } from './villagerSystem';
import { WoodDepot } from './woodDepot';

/** Arayüz (UI) öğeleri için en üst derinlik katmanı */
const UI_DEPTH = 5000;

/** Üst başlık ve ortak odun sayacı için ayrılan ekran yüksekliği (px) */
const TOP_HUD_INSET = 104;

class MainScene extends Phaser.Scene {
  private isoGrid?: IsoGrid;
  private forestSystem?: ForestSystem;
  private woodDepot?: WoodDepot;
  private villagerSystem?: VillagerSystem;
  private cameraController?: MapCameraController;
  private uiCamera?: Phaser.Cameras.Scene2D.Camera;

  private titleText?: Phaser.GameObjects.Text;
  private subtitleText?: Phaser.GameObjects.Text;
  private woodPanelBg?: Phaser.GameObjects.Graphics;
  private woodStatusText?: Phaser.GameObjects.Text;
  private lastWoodHudLine = '';
  private lastHighlightActive = false;

  constructor() {
    super({ key: 'MainScene' });
  }

  public preload(): void {
    ForestSystem.preload(this);
    VillagerSystem.preload(this);
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

    // Tüm köylülerin ortak kullandığı sabit odun deposu (col: 7, row: 6)
    this.woodDepot = new WoodDepot(this, this.isoGrid);

    // 16x16 harita için ekran ölçekleme, sürükleme ve yakınlaştırma kontrolcüsü
    const mapSize = this.isoGrid.getWorldSize();
    this.cameraController = new MapCameraController(this, this.cameras.main, {
      mapWidth: mapSize.width,
      mapHeight: mapSize.height,
      topUiInset: TOP_HUD_INSET,
    });

    // Çoklu Karahanlı köylü sistemi (başlangıçta 3 bağımsız köylü)
    this.villagerSystem = new VillagerSystem(
      this,
      this.isoGrid,
      this.forestSystem,
      this.woodDepot,
      this.cameraController
    );
    this.villagerSystem.spawnInitialVillagers();

    // Sabit üst başlık, kontrol açıklaması ve ortak odun sayacı
    this.titleText = this.add
      .text(0, 0, 'KARAHANLI RTS', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '21px',
        fontStyle: 'bold',
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0)
      .setDepth(UI_DEPTH);

    this.subtitleText = this.add
      .text(
        0,
        0,
        'Sol Tık / Dokun: Köylü Seç  •  Ağaca Sağ Tık / Dokun: Odun Topla  •  Zemine Sağ Tık / Dokun: Yürüt',
        {
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: '12px',
          color: '#94a3b8',
          align: 'center',
        }
      )
      .setOrigin(0.5, 0)
      .setDepth(UI_DEPTH);

    this.woodPanelBg = this.add.graphics().setDepth(UI_DEPTH);

    this.woodStatusText = this.add
      .text(0, 0, '', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '13px',
        fontStyle: 'bold',
        color: '#e2e8f0',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(UI_DEPTH + 1);

    // Arayüz metinlerini yakınlaştırmadan/kaydırmadan bağımsız tutan şeffaf HUD kamerası
    this.uiCamera = this.cameras.add(0, 0, width, height, false, 'HudCamera');
    this.cameras.main.ignore([
      this.titleText,
      this.subtitleText,
      this.woodPanelBg,
      this.woodStatusText,
    ]);

    const terrainImg = this.isoGrid.getTerrainImage();
    if (terrainImg) {
      this.uiCamera.ignore(terrainImg);
    }
    this.forestSystem.ignoreOnCamera(this.uiCamera);
    this.woodDepot.ignoreOnCamera(this.uiCamera);
    this.villagerSystem.ignoreOnCamera(this.uiCamera);

    this.refreshWoodHud(true);
    this.layoutHud(width);
    this.scale.on('resize', this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
  }

  public update(_time: number, delta: number): void {
    this.cameraController?.update(delta);
    this.villagerSystem?.update(delta);
    this.refreshWoodHud(false);
  }

  private refreshWoodHud(force: boolean): void {
    if (!this.villagerSystem || !this.woodStatusText) {
      return;
    }

    const status = this.villagerSystem.getHudStatus();
    const sel = status.selectedVillager;

    let line: string;
    let highlight = false;

    if (sel) {
      highlight = true;
      const stateLabel =
        sel.state === 'chopping'
          ? 'Kesiyor'
          : sel.state === 'returning_to_depot'
            ? 'Depoya Götürüyor'
            : sel.state === 'walking'
              ? 'Yürüyor'
              : 'Hazır';

      let detailPart = stateLabel;
      if (
        sel.targetTreeType !== null &&
        sel.targetTreeWood !== null &&
        sel.targetTreeMaxWood !== null
      ) {
        const treeName = sel.targetTreeType === 'cam' ? 'Çam' : 'Kayın';
        detailPart = `${stateLabel} (${treeName}: ${sel.targetTreeWood}/${sel.targetTreeMaxWood})`;
      }

      line = `Toplam Odun: ${status.totalStoredWood}   •   ${sel.displayName}: ${sel.carriedWood}/${sel.maxCapacity}   •   ${detailPart}`;
    } else {
      line = `Toplam Odun: ${status.totalStoredWood}   •   Köylüler: ${status.totalVillagersCount} (${status.workingVillagersCount} Aktif)   •   Orman: ${status.remainingTreesCount} Ağaç`;
    }

    if (
      !force &&
      line === this.lastWoodHudLine &&
      highlight === this.lastHighlightActive
    ) {
      return;
    }

    this.lastWoodHudLine = line;
    this.lastHighlightActive = highlight;
    this.woodStatusText.setText(line);
    this.woodStatusText.setColor(highlight ? '#f8fafc' : '#e2e8f0');
    this.drawWoodPillBackground(this.scale.width);
  }

  private layoutHud(width: number): void {
    const isCompact = width < 560;
    this.titleText?.setFontSize(isCompact ? 17 : 21);
    this.subtitleText?.setFontSize(isCompact ? 11 : 12);
    this.subtitleText?.setWordWrapWidth(Math.max(width - 24, 240));
    this.woodStatusText?.setFontSize(isCompact ? 11 : 13);

    this.titleText?.setPosition(width / 2, isCompact ? 10 : 14);
    this.subtitleText?.setPosition(width / 2, isCompact ? 32 : 40);
    this.woodStatusText?.setPosition(width / 2, isCompact ? 74 : 76);

    this.drawWoodPillBackground(width);
  }

  private drawWoodPillBackground(screenWidth: number): void {
    if (!this.woodPanelBg || !this.woodStatusText) {
      return;
    }

    const isCompact = screenWidth < 560;
    const centerY = isCompact ? 74 : 76;
    const textW = this.woodStatusText.width;
    const pillW = Math.min(screenWidth - 16, Math.max(240, textW + 28));
    const pillH = isCompact ? 24 : 26;
    const x = (screenWidth - pillW) * 0.5;
    const y = centerY - pillH * 0.5;

    this.woodPanelBg.clear();
    this.woodPanelBg.fillStyle(0x1e293b, 0.88);
    this.woodPanelBg.fillRoundedRect(x, y, pillW, pillH, 12);
    this.woodPanelBg.lineStyle(
      1,
      this.lastHighlightActive ? 0x4ade80 : 0x475569,
      0.9
    );
    this.woodPanelBg.strokeRoundedRect(x, y, pillW, pillH, 12);
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    this.uiCamera?.setSize(width, height);
    this.layoutHud(width);
    this.cameraController?.handleResize(width, height);
  }

  private cleanup(): void {
    this.scale.off('resize', this.handleResize, this);
    this.villagerSystem?.destroy();
    this.woodDepot?.destroy();
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
