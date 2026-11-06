/**
 * Karahanlı RTS — Harita Kamera ve Ekran Ölçekleme Kontrolcüsü (MapCameraController)
 *
 * Genişletilmiş 16x16 izometrik haritanın hem masaüstü hem mobil tarayıcılarda
 * tamamının dengeli biçimde görülmesini ve çoklu seçim kutusuyla çakışmadan
 * akıcı şekilde gezilebilmesini sağlar:
 * - Ekran boyutuna göre otomatik sığdırma (auto-fit zoom)
 * - Masaüstünde: Orta fare tuşu (veya Boşluk + Sol Sürükleme) ve WASD / Ok tuşlarıyla kaydırma
 *   (Sol tık sürükleme çoklu birim seçim dikdörtgenine ayrılmıştır)
 * - Mobilde: Tek parmak dokunmatik kaydırma ("Kutu Seç" modu kapalıyken) ve iki parmak yakınlaştırma
 * - Fare tekerleği ile yakınlaştırma, Home veya R ile merkeze sıfırlama
 */

import Phaser from 'phaser';

export interface MapCameraConfig {
  /** Haritanın toplam dünya piksel genişliği (16x16 için 1024) */
  mapWidth: number;
  /** Haritanın toplam dünya piksel yüksekliği (16x16 için ~518) */
  mapHeight: number;
  /** Üst başlık / HUD için ayrılan ekran piksel yüksekliği */
  topUiInset?: number;
  /** Alt kontrol çubuğu için ayrılan ekran piksel yüksekliği */
  bottomUiInset?: number;
}

const MAX_ZOOM = 1.85;
const KEYBOARD_PAN_SPEED = 420; // ekran pikseli / saniye
const DRAG_THRESHOLD_PX = 7; // tıklama/dokunma ile kamera sürüklemeyi ayıran eşik (px)

export class MapCameraController {
  private readonly scene: Phaser.Scene;
  private readonly camera: Phaser.Cameras.Scene2D.Camera;
  private readonly mapWidth: number;
  private readonly mapHeight: number;
  private readonly topUiInset: number;
  private readonly bottomUiInset: number;

  /** Kameranın ekran merkezinde baktığı dünya koordinatı */
  private lookX = 0;
  private lookY = 0;
  private minZoom = 0.5;
  private defaultZoom = 1;
  private hasUserAdjustedView = false;

  /** Sürükleme, tıklama ayrımı ve iki parmak yakınlaştırma durumu */
  private isPointerCandidate = false;
  private isDragging = false;
  private gestureDragged = false;
  private downStartX = 0;
  private downStartY = 0;
  private lastDragX = 0;
  private lastDragY = 0;
  private lastPinchDistance = 0;

  /** Seçim kutusu veya HUD butonları aktifken kamera sürüklemesini devre dışı bırakan sorgu */
  private shouldSuppressPointerDrag?: (pointer: Phaser.Input.Pointer) => boolean;

  /** Opsiyonel klavye tuşları (masaüstü) */
  private cursors?: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasdKeys?: {
    W: Phaser.Input.Keyboard.Key;
    A: Phaser.Input.Keyboard.Key;
    S: Phaser.Input.Keyboard.Key;
    D: Phaser.Input.Keyboard.Key;
    R: Phaser.Input.Keyboard.Key;
    HOME: Phaser.Input.Keyboard.Key;
    SPACE: Phaser.Input.Keyboard.Key;
  };

  constructor(
    scene: Phaser.Scene,
    camera: Phaser.Cameras.Scene2D.Camera,
    config: MapCameraConfig
  ) {
    this.scene = scene;
    this.camera = camera;
    this.mapWidth = config.mapWidth;
    this.mapHeight = config.mapHeight;
    this.topUiInset = config.topUiInset ?? 78;
    this.bottomUiInset = config.bottomUiInset ?? 52;

    // Mobil iki parmak pinch-to-zoom için ikinci dokunma noktasını etkinleştir
    if (scene.input.manager.pointersTotal < 3) {
      scene.input.addPointer(1);
    }

    this.setupPointerControls();
    this.setupKeyboardControls();
    this.fitToViewport(scene.scale.width, scene.scale.height, true);
  }

  /**
   * Harici sistemlerin (ör. mobil kutu seçim modu veya HUD buton tıklamaları)
   * belirli işaretçi hareketlerinde kamera sürüklemesini bastırmasına izin verir.
   */
  public setPointerDragSuppression(
    predicate: (pointer: Phaser.Input.Pointer) => boolean
  ): void {
    this.shouldSuppressPointerDrag = predicate;
  }

  /**
   * Masaüstünde Boşluk (Space) tuşunun kamera kaydırma için basılı olup olmadığını döndürür.
   */
  public isSpacePanHeld(): boolean {
    return Boolean(this.wasdKeys?.SPACE.isDown);
  }

  /**
   * Son işaretçi (fare/dokunma) etkileşiminin harita sürükleme veya iki parmak
   * yakınlaştırma olup olmadığını döndürür.
   */
  public wasPointerGestureDragged(): boolean {
    return this.gestureDragged;
  }

  /**
   * Ekran boyutu değiştiğinde ölçek sınırlarını günceller.
   */
  public handleResize(width: number, height: number): void {
    this.camera.setSize(width, height);
    this.fitToViewport(width, height, !this.hasUserAdjustedView);
  }

  /**
   * Kare bazlı klavye ve iki parmak (pinch) güncellemelerini çalıştırır.
   */
  public update(deltaMs: number): void {
    this.updatePinchZoom();
    this.updateKeyboardPan(deltaMs);
  }

  /**
   * Kamerayı tüm 16x16 haritayı dengeli gösterecek varsayılan konuma sıfırlar.
   */
  public resetView(): void {
    this.hasUserAdjustedView = false;
    this.fitToViewport(this.scene.scale.width, this.scene.scale.height, true);
  }

  private fitToViewport(width: number, height: number, recenter: boolean): void {
    const safeWidth = Math.max(width - 40, 220);
    const safeHeight = Math.max(
      height - this.topUiInset - this.bottomUiInset - 16,
      180
    );

    const fitScaleX = safeWidth / (this.mapWidth + 32);
    const fitScaleY = safeHeight / (this.mapHeight + 36);
    const fullMapFitZoom = Math.min(fitScaleX, fitScaleY);

    this.minZoom = Phaser.Math.Clamp(
      Math.min(fullMapFitZoom * 0.92, 0.75),
      0.3,
      0.9
    );
    this.defaultZoom = Phaser.Math.Clamp(fullMapFitZoom, 0.5, 1.08);

    if (recenter) {
      this.camera.setZoom(this.defaultZoom);
      this.lookX = 0;
      this.lookY = this.getCenteredLookY(this.defaultZoom);
    } else {
      const clampedZoom = Phaser.Math.Clamp(
        this.camera.zoom,
        this.minZoom,
        MAX_ZOOM
      );
      this.camera.setZoom(clampedZoom);
    }

    this.applyCameraTransform();
  }

  private getCenteredLookY(zoom: number): number {
    const verticalBias = (this.topUiInset - this.bottomUiInset) / (2 * zoom);
    return -4 - verticalBias;
  }

  private setupPointerControls(): void {
    const { input } = this.scene;

    input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (this.isTwoFingerGestureActive()) {
        this.isPointerCandidate = false;
        this.isDragging = false;
        this.gestureDragged = true;
        return;
      }

      this.gestureDragged = false;

      if (this.shouldSuppressPointerDrag?.(pointer)) {
        this.isPointerCandidate = false;
        this.isDragging = false;
        return;
      }

      if (!pointer.wasTouch) {
        // Masaüstünde sol tık sürükleme çoklu seçim kutusu içindir;
        // kamera fare ile orta tuş (button === 1) veya Space + Sol tuşla sürüklenir
        const isMiddleButton = pointer.button === 1;
        const isSpaceLeftDrag =
          pointer.button === 0 && Boolean(this.wasdKeys?.SPACE.isDown);
        if (!isMiddleButton && !isSpaceLeftDrag) {
          this.isPointerCandidate = false;
          this.isDragging = false;
          return;
        }
      }

      this.isPointerCandidate = true;
      this.isDragging = false;
      this.downStartX = pointer.x;
      this.downStartY = pointer.y;
      this.lastDragX = pointer.x;
      this.lastDragY = pointer.y;
    });

    input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.isTwoFingerGestureActive()) {
        this.isPointerCandidate = false;
        this.isDragging = false;
        this.gestureDragged = true;
        return;
      }

      if (!this.isPointerCandidate || !pointer.isDown) {
        return;
      }

      if (!this.isDragging) {
        const totalMove = Phaser.Math.Distance.Between(
          this.downStartX,
          this.downStartY,
          pointer.x,
          pointer.y
        );
        if (totalMove < DRAG_THRESHOLD_PX) {
          return;
        }
        this.isDragging = true;
        this.gestureDragged = true;
        this.lastDragX = pointer.x;
        this.lastDragY = pointer.y;
        return;
      }

      const dx = pointer.x - this.lastDragX;
      const dy = pointer.y - this.lastDragY;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        return;
      }

      this.lastDragX = pointer.x;
      this.lastDragY = pointer.y;
      this.hasUserAdjustedView = true;

      this.lookX -= dx / this.camera.zoom;
      this.lookY -= dy / this.camera.zoom;
      this.applyCameraTransform();
    });

    const stopDragging = (): void => {
      if (!this.scene.input.activePointer.isDown) {
        this.isPointerCandidate = false;
        this.isDragging = false;
      }
    };

    input.on('pointerup', stopDragging);
    input.on('pointerupoutside', stopDragging);

    input.on(
      'wheel',
      (
        pointer: Phaser.Input.Pointer,
        _gameObjects: Phaser.GameObjects.GameObject[],
        _deltaX: number,
        deltaY: number
      ) => {
        const zoomFactor = deltaY > 0 ? 0.9 : 1.11;
        this.zoomAtScreenPoint(
          this.camera.zoom * zoomFactor,
          pointer.x,
          pointer.y
        );
      }
    );
  }

  private setupKeyboardControls(): void {
    const keyboard = this.scene.input.keyboard;
    if (!keyboard) {
      return;
    }

    this.cursors = keyboard.createCursorKeys();
    this.wasdKeys = {
      W: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.D),
      R: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.R),
      HOME: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.HOME),
      SPACE: keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
    };

    this.wasdKeys.R.on('down', () => this.resetView());
    this.wasdKeys.HOME.on('down', () => this.resetView());
  }

  private updatePinchZoom(): void {
    const p1 = this.scene.input.pointer1;
    const p2 = this.scene.input.pointer2;

    if (!p1?.isDown || !p2?.isDown) {
      this.lastPinchDistance = 0;
      return;
    }

    this.gestureDragged = true;
    const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
    if (dist < 8) {
      return;
    }

    if (this.lastPinchDistance > 0) {
      const ratio = dist / this.lastPinchDistance;
      if (Math.abs(ratio - 1) > 0.004) {
        const midX = (p1.x + p2.x) * 0.5;
        const midY = (p1.y + p2.y) * 0.5;
        this.zoomAtScreenPoint(this.camera.zoom * ratio, midX, midY);
      }
    }

    this.lastPinchDistance = dist;
  }

  private updateKeyboardPan(deltaMs: number): void {
    if (!this.cursors || !this.wasdKeys) {
      return;
    }

    let dirX = 0;
    let dirY = 0;

    if (this.cursors.left.isDown || this.wasdKeys.A.isDown) dirX -= 1;
    if (this.cursors.right.isDown || this.wasdKeys.D.isDown) dirX += 1;
    if (this.cursors.up.isDown || this.wasdKeys.W.isDown) dirY -= 1;
    if (this.cursors.down.isDown || this.wasdKeys.S.isDown) dirY += 1;

    if (dirX === 0 && dirY === 0) {
      return;
    }

    const len = Math.hypot(dirX, dirY);
    const stepWorld =
      (KEYBOARD_PAN_SPEED * (deltaMs / 1000)) / this.camera.zoom;

    this.hasUserAdjustedView = true;
    this.lookX += (dirX / len) * stepWorld;
    this.lookY += (dirY / len) * stepWorld;
    this.applyCameraTransform();
  }

  private zoomAtScreenPoint(
    targetZoom: number,
    screenX: number,
    screenY: number
  ): void {
    const oldZoom = this.camera.zoom;
    const newZoom = Phaser.Math.Clamp(targetZoom, this.minZoom, MAX_ZOOM);
    if (Math.abs(newZoom - oldZoom) < 0.0005) {
      return;
    }

    const offsetX = screenX - this.camera.width * 0.5;
    const offsetY = screenY - this.camera.height * 0.5;

    const worldBeforeX = this.lookX + offsetX / oldZoom;
    const worldBeforeY = this.lookY + offsetY / oldZoom;

    this.camera.setZoom(newZoom);
    this.lookX = worldBeforeX - offsetX / newZoom;
    this.lookY = worldBeforeY - offsetY / newZoom;
    this.hasUserAdjustedView = true;

    this.applyCameraTransform();
  }

  private isTwoFingerGestureActive(): boolean {
    return Boolean(
      this.scene.input.pointer1?.isDown && this.scene.input.pointer2?.isDown
    );
  }

  private applyCameraTransform(): void {
    const maxOffsetX = this.mapWidth * 0.52;
    const maxOffsetY = this.mapHeight * 0.56;
    const centerBaseY = this.getCenteredLookY(this.camera.zoom);

    this.lookX = Phaser.Math.Clamp(this.lookX, -maxOffsetX, maxOffsetX);
    this.lookY = Phaser.Math.Clamp(
      this.lookY,
      centerBaseY - maxOffsetY,
      centerBaseY + maxOffsetY
    );

    this.camera.centerOn(this.lookX, this.lookY);
  }

  public destroy(): void {
    this.wasdKeys?.R.removeAllListeners();
    this.wasdKeys?.HOME.removeAllListeners();
  }
}
