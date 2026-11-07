/**
 * Karahanlı RTS — Ana Giriş Dosyası
 *
 * Phaser 3 + TypeScript + Vite tabanlı 2D gerçek zamanlı strateji oyunu.
 * 16x16 dikişsiz izometrik çimen haritayı, doğal koruluk yerleşimindeki
 * 2 kayın + 2 çam odun kaynağını (her biri 100 odun), gerçekçi ahşap direkli ve
 * çatılı ortak odun deposunu, kurt armalı Eski Türk Hükümdar Konağı (Town Hall)
 * yapısını, Celtic Kings tarzı bina içi garnizon sistemini ve yakın plan karakter
 * portreli birleşik alt bilgi panelini sahnede çalıştırır.
 */

import Phaser from 'phaser';
import {
  BOTTOM_DOCK_TOTAL_HEIGHT,
  BottomInfoPanel,
} from './bottomInfoPanel';
import { Barracks } from './barracks';
import { MapCameraController } from './cameraController';
import { ForestSystem } from './forestSystem';
import { IsoGrid } from './isoGrid';
import { TownHall } from './townHall';
import { InactiveFoodProvisionWallet } from './unitTypes';
import { VillagerSystem } from './villagerSystem';
import { WoodDepot } from './woodDepot';

const UI_DEPTH = 5000;
const TOP_HUD_INSET = 96;

class MainScene extends Phaser.Scene {
  private isoGrid?: IsoGrid;
  private forestSystem?: ForestSystem;
  private woodDepot?: WoodDepot;
  private townHall?: TownHall;
  private barracks?: Barracks;
  private villagerSystem?: VillagerSystem;
  private cameraController?: MapCameraController;
  private bottomPanel?: BottomInfoPanel;
  private uiCamera?: Phaser.Cameras.Scene2D.Camera;
  private readonly provisionWallet = new InactiveFoodProvisionWallet();

  private titleText?: Phaser.GameObjects.Text;
  private subtitleText?: Phaser.GameObjects.Text;
  private topResourceBg?: Phaser.GameObjects.Graphics;
  private topResourceText?: Phaser.GameObjects.Text;
  private lastTopResourceLine = '';

  constructor() {
    super({ key: 'MainScene' });
  }

  public preload(): void {
    ForestSystem.preload(this);
    WoodDepot.preload(this);
    TownHall.preload(this);
    Barracks.preload(this);
    VillagerSystem.preload(this);
    BottomInfoPanel.preload(this);
  }

  public create(): void {
    const { width, height } = this.scale;

    // 16x16 boyutunda, 64x32 piksel (2:1) dikişsiz izometrik çimen harita
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

    // Ahşap direkli, çatılı ve istiflenmiş kütük yığınlı ortak odun deposu (col: 6, row: 5)
    this.woodDepot = new WoodDepot(this, this.isoGrid);

    // Kurt armalı Eski Türk Hükümdar Konağı — Town Hall (cols: 9..11, rows: 5..7)
    this.townHall = new TownHall(this, this.isoGrid, this.woodDepot);

    // Ahşap karkaslı, taş temelli Karahanlı Kışlası — 3x2 askerî yapı (cols: 6..8, rows: 10..11)
    this.barracks = new Barracks(this, this.isoGrid);

    // Kamera kontrolcüsü (üst kaynak çubuğu ve alt bilgi paneli boşluklarıyla dengeli)
    const mapSize = this.isoGrid.getWorldSize();
    this.cameraController = new MapCameraController(this, this.cameras.main, {
      mapWidth: mapSize.width,
      mapHeight: mapSize.height,
      topUiInset: TOP_HUD_INSET,
      bottomUiInset: BOTTOM_DOCK_TOTAL_HEIGHT,
    });

    // Çoklu birim seçim, hareket, odun toplama ve garnizon sistemi
    this.villagerSystem = new VillagerSystem(
      this,
      this.isoGrid,
      this.forestSystem,
      this.woodDepot,
      this.townHall,
      this.cameraController
    );
    if (this.barracks) {
      this.villagerSystem.setBarracks(this.barracks);
    }
    this.villagerSystem.spawnInitialVillagers();

    // Age of Empires & Celtic Kings tarzı yakın plan portreli alt bilgi ve yönetim paneli
    this.bottomPanel = new BottomInfoPanel(this, {
      onToggleTouchBoxMode: () => {
        this.villagerSystem?.toggleTouchBoxSelectMode();
        this.refreshHud(true);
      },
      onSelectAllUnits: () => {
        this.villagerSystem?.setTouchBoxSelectMode(false);
        this.villagerSystem?.selectAllVillagers();
        this.refreshHud(true);
      },
      onSelectTownHall: () => {
        this.villagerSystem?.selectTownHall();
        this.refreshHud(true);
      },
      onSelectBarracks: () => {
        this.villagerSystem?.selectBarracks();
        this.refreshHud(true);
      },
      onClearSelection: () => {
        this.villagerSystem?.setTouchBoxSelectMode(false);
        this.villagerSystem?.clearSelection();
        this.refreshHud(true);
      },
      onSelectSingleUnit: (unitId) => {
        this.villagerSystem?.selectSingleVillager(unitId);
        this.refreshHud(true);
      },
      onCommandSelectedEnterTownHall: () => {
        this.villagerSystem?.commandEnterSelectedIntoBuilding(
          this.townHall?.id
        );
        this.refreshHud(true);
      },
      onTrainVillager: () => {
        const res = this.townHall?.tryTrainVillager();
        this.refreshHud(true);
        return Boolean(res?.ok);
      },
      onEjectSingleUnit: (unitId) => {
        this.villagerSystem?.ejectOneFromTownHall(unitId);
        this.refreshHud(true);
      },
      onEjectAllUnits: () => {
        this.villagerSystem?.ejectAllFromTownHall();
        this.refreshHud(true);
      },
    });

    this.villagerSystem.setUiHitBlocker((sx, sy) =>
      Boolean(this.bottomPanel?.containsScreenPoint(sx, sy))
    );

    // Üst başlık ve yerleşim kaynak özeti şeridi
    this.titleText = this.add
      .text(0, 0, 'KARAHANLI RTS', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '20px',
        fontStyle: 'bold',
        color: '#f8fafc',
      })
      .setOrigin(0.5, 0)
      .setDepth(UI_DEPTH);

    this.subtitleText = this.add
      .text(
        0,
        0,
        "Sol Sürükle: Çoklu Seç  •  Sağ Tık: Hareket / Odun / Konak'a Gir  •  Sol Tık: Birim veya Town Hall Seç",
        {
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          fontSize: '11.5px',
          color: '#94a3b8',
          align: 'center',
        }
      )
      .setOrigin(0.5, 0)
      .setDepth(UI_DEPTH);

    this.topResourceBg = this.add.graphics().setDepth(UI_DEPTH);
    this.topResourceText = this.add
      .text(0, 0, '', {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: '12.5px',
        fontStyle: 'bold',
        color: '#f1f5f9',
      })
      .setOrigin(0.5, 0.5)
      .setDepth(UI_DEPTH + 1);

    // Şeffaf arayüz kamerası (HudCamera)
    this.uiCamera = this.cameras.add(0, 0, width, height, false, 'HudCamera');

    this.cameras.main.ignore([
      this.titleText,
      this.subtitleText,
      this.topResourceBg,
      this.topResourceText,
      ...this.bottomPanel.getGameObjects(),
      ...this.villagerSystem.getScreenOverlayObjects(),
    ]);

    const terrainImg = this.isoGrid.getTerrainImage();
    if (terrainImg) {
      this.uiCamera.ignore(terrainImg);
    }
    this.forestSystem.ignoreOnCamera(this.uiCamera);
    this.woodDepot.ignoreOnCamera(this.uiCamera);
    this.townHall.ignoreOnCamera(this.uiCamera);
    this.barracks?.ignoreOnCamera(this.uiCamera);
    this.villagerSystem.ignoreOnCamera(this.uiCamera);

    this.layoutTopHud(width);
    this.refreshHud(true);
    this.scale.on('resize', this.handleResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanup, this);
  }

  public update(_time: number, delta: number): void {
    this.cameraController?.update(delta);
    this.townHall?.update(delta, this.provisionWallet);
    this.villagerSystem?.update(delta);
    this.refreshHud(false);
  }

  private refreshHud(force: boolean): void {
    if (
      !this.villagerSystem ||
      !this.townHall ||
      !this.bottomPanel ||
      !this.topResourceText
    ) {
      return;
    }

    const unitStatus = this.villagerSystem.getHudStatus();
    const thSnap = this.townHall.getHudSnapshot();
    const barracksSnap = this.barracks ? this.barracks.getHudSnapshot() : null;

    // Garnizondaki birim sayısı üst şeritte gösterilmez; yalnızca Town Hall seçildiğinde alt panelde yer alır
    const topLine =
      `Toplam Odun: ${unitStatus.totalStoredWood}   •   ` +
      `Nüfus: ${unitStatus.totalVillagersCount} Köylü   •   ` +
      `Orman: ${unitStatus.remainingTreesCount} Ağaç`;

    if (force || topLine !== this.lastTopResourceLine) {
      this.lastTopResourceLine = topLine;
      this.topResourceText.setText(topLine);
      this.drawTopResourcePill(this.scale.width);
    }

    this.bottomPanel.render(
      this.scale.width,
      this.scale.height,
      unitStatus,
      thSnap,
      barracksSnap,
      force
    );
  }

  private layoutTopHud(width: number): void {
    const isCompact = width < 620;
    this.titleText?.setFontSize(isCompact ? 16.5 : 20);
    this.subtitleText?.setFontSize(isCompact ? 10.5 : 11.5);
    this.subtitleText?.setWordWrapWidth(Math.max(width - 20, 240));
    this.topResourceText?.setFontSize(isCompact ? 11 : 12.5);

    this.titleText?.setPosition(width * 0.5, isCompact ? 8 : 10);
    this.subtitleText?.setPosition(width * 0.5, isCompact ? 29 : 34);
    this.topResourceText?.setPosition(width * 0.5, isCompact ? 68 : 70);

    this.drawTopResourcePill(width);
  }

  private drawTopResourcePill(screenWidth: number): void {
    if (!this.topResourceBg || !this.topResourceText) {
      return;
    }

    const isCompact = screenWidth < 620;
    const centerY = isCompact ? 68 : 70;
    const pillW = Math.min(
      screenWidth - 16,
      Math.max(240, this.topResourceText.width + 26)
    );
    const pillH = isCompact ? 23 : 25;
    const x = (screenWidth - pillW) * 0.5;
    const y = centerY - pillH * 0.5;

    this.topResourceBg.clear();
    this.topResourceBg.fillStyle(0x1e293b, 0.88);
    this.topResourceBg.fillRoundedRect(x, y, pillW, pillH, 11);
    this.topResourceBg.lineStyle(1, 0xb45309, 0.85);
    this.topResourceBg.strokeRoundedRect(x, y, pillW, pillH, 11);
  }

  private handleResize(gameSize: Phaser.Structs.Size): void {
    const { width, height } = gameSize;
    this.uiCamera?.setSize(width, height);
    this.layoutTopHud(width);
    this.cameraController?.handleResize(width, height);
    this.refreshHud(true);
  }

  private cleanup(): void {
    this.scale.off('resize', this.handleResize, this);
    this.bottomPanel?.destroy();
    this.villagerSystem?.destroy();
    this.townHall?.destroy();
    this.barracks?.destroy();
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
