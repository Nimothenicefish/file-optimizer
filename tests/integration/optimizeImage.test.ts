import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { optimizeImage } from "@/lib/pipeline/optimizeImage";

let dirs: string[] = [];

function mkTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-optimizer-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("optimizeImage — redimensionne pendant le décodage (shrink-on-load)", () => {
  it("réduit une image JPEG dont une dimension dépasse maxDimension", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "photo.jpg");
    await sharp({ create: { width: 6000, height: 3000, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .jpeg({ quality: 90 })
      .toFile(filePath);

    const result = await optimizeImage({
      filePath,
      maxDimension: 2000,
      quality: 85,
      keepOriginal: false,
    });

    expect(result.originalSize).toBeGreaterThan(0);
    expect(result.optimizedSize).toBeGreaterThan(0);

    const meta = await sharp(fs.readFileSync(filePath)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2000);
  });

  it("ne touche pas une image déjà sous maxDimension", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "small.jpg");
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .toFile(filePath);

    await optimizeImage({ filePath, maxDimension: 2000, quality: 85, keepOriginal: false });

    const meta = await sharp(fs.readFileSync(filePath)).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });
});

describe("optimizeImage — conserve le format d'origine (pas de conversion vers JPEG universel)", () => {
  it("un PNG reste un PNG (ré-encodé, pas converti)", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "graphic.png");
    await sharp({
      create: { width: 500, height: 500, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toFile(filePath);

    await optimizeImage({ filePath, maxDimension: 2000, quality: 85, keepOriginal: false });

    const meta = await sharp(fs.readFileSync(filePath)).metadata();
    expect(meta.format).toBe("png");
    // La transparence (canal alpha) doit survivre — perdue si on avait
    // converti en JPEG.
    expect(meta.hasAlpha).toBe(true);
  });

  it("un WebP reste un WebP", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "photo.webp");
    await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 5, g: 5, b: 5 } } })
      .webp()
      .toFile(filePath);

    await optimizeImage({ filePath, maxDimension: 2000, quality: 80, keepOriginal: false });

    const meta = await sharp(fs.readFileSync(filePath)).metadata();
    expect(meta.format).toBe("webp");
  });
});

describe("optimizeImage — forceJpeg : conversion forcée en JPG", () => {
  it("convertit un PNG avec transparence en JPG (fond blanc) et supprime l'ancien fichier", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "graphic.png");
    const width = 300;
    const height = 300;
    // Bruit RGBA (pas de zones plates) : un PNG lossless compresse mal du
    // bruit, un JPEG qualité 85 nettement mieux — garantit que la conversion
    // réduit réellement la taille (sinon le garde-fou "jamais plus gros"
    // annulerait la conversion, voir plus bas).
    const raw = Buffer.alloc(width * height * 4);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    // Un coin entièrement transparent, pour vérifier l'aplatissement sur blanc.
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        raw[(y * width + x) * 4 + 3] = 0;
      }
    }
    await sharp(raw, { raw: { width, height, channels: 4 } }).png().toFile(filePath);

    const result = await optimizeImage({
      filePath,
      maxDimension: 2000,
      quality: 85,
      keepOriginal: false,
      forceJpeg: true,
    });

    const jpgPath = path.join(dir, "graphic.jpg");
    expect(result.finalPath).toBe(jpgPath);
    expect(fs.existsSync(jpgPath)).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);

    const output = sharp(fs.readFileSync(jpgPath));
    const meta = await output.metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false);

    const corner = await output.clone().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    expect(Array.from(corner.subarray(0, 3))).toEqual([255, 255, 255]);
  });

  it("conserve l'original dans origin/ (pas de suppression) quand keepOriginal est aussi activé", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "graphic.png");
    const width = 300;
    const height = 300;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(filePath);

    const result = await optimizeImage({
      filePath,
      maxDimension: 2000,
      quality: 85,
      keepOriginal: true,
      forceJpeg: true,
    });

    expect(fs.existsSync(path.join(dir, "origin", "graphic.png"))).toBe(true);
    expect(fs.existsSync(result.finalPath)).toBe(true);
    expect(result.finalPath).toBe(path.join(dir, "graphic.jpg"));
  });

  it("n'a aucun effet sur un fichier déjà en JPEG (pas de renommage)", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "photo.jpg");
    await sharp({ create: { width: 500, height: 500, channels: 3, background: { r: 5, g: 10, b: 15 } } })
      .jpeg({ quality: 95 })
      .toFile(filePath);

    const result = await optimizeImage({
      filePath,
      maxDimension: 2000,
      quality: 85,
      keepOriginal: false,
      forceJpeg: true,
    });

    expect(result.finalPath).toBe(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("évite d'écraser un fichier .jpg déjà présent du même nom (suffixe numérique)", async () => {
    const dir = mkTempDir();
    const pngPath = path.join(dir, "graphic.png");
    const existingJpgPath = path.join(dir, "graphic.jpg");

    const width = 300;
    const height = 300;
    const raw = Buffer.alloc(width * height * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    await sharp(raw, { raw: { width, height, channels: 3 } }).png().toFile(pngPath);
    fs.writeFileSync(existingJpgPath, "contenu existant, ne doit pas être touché");

    const result = await optimizeImage({
      filePath: pngPath,
      maxDimension: 2000,
      quality: 85,
      keepOriginal: false,
      forceJpeg: true,
    });

    expect(result.finalPath).toBe(path.join(dir, "graphic_1.jpg"));
    expect(fs.readFileSync(existingJpgPath, "utf8")).toBe("contenu existant, ne doit pas être touché");
    expect(fs.existsSync(pngPath)).toBe(false);
  });

  it("garde le PNG original si la conversion forcée en JPG ne réduit pas la taille", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "tiny.png");
    await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 10, b: 10 } } })
      .png()
      .toFile(filePath);
    const originalBytes = fs.readFileSync(filePath);

    const result = await optimizeImage({
      filePath,
      maxDimension: 2000,
      quality: 85,
      keepOriginal: false,
      forceJpeg: true,
    });

    expect(result.finalPath).toBe(filePath);
    expect(result.optimizedSize).toBe(result.originalSize);
    expect(fs.readFileSync(filePath).equals(originalBytes)).toBe(true);
    expect(fs.existsSync(path.join(dir, "tiny.jpg"))).toBe(false);
  });
});

describe("optimizeImage — conservation de l'original (keepOriginal: true)", () => {
  it("déplace l'original dans origin/ à côté du fichier, et l'emplacement d'origine contient la version optimisée", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "photo.jpg");
    await sharp({ create: { width: 6000, height: 4000, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .jpeg({ quality: 95 })
      .toFile(filePath);
    const originalBytes = fs.readFileSync(filePath);

    await optimizeImage({ filePath, maxDimension: 2000, quality: 85, keepOriginal: true });

    const originPath = path.join(dir, "origin", "photo.jpg");
    expect(fs.existsSync(originPath)).toBe(true);
    expect(fs.readFileSync(originPath).equals(originalBytes)).toBe(true);

    // Le fichier à l'emplacement d'origine est bien la version optimisée
    // (dimensions réduites), pas l'ancien contenu.
    const meta = await sharp(fs.readFileSync(filePath)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2000);
  });

  it("évite d'écraser un original déjà préservé lors d'un run précédent (suffixe numérique)", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "photo.jpg");
    fs.mkdirSync(path.join(dir, "origin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "origin", "photo.jpg"), "ancien original déjà préservé");

    await sharp({ create: { width: 6000, height: 4000, channels: 3, background: { r: 1, g: 1, b: 1 } } })
      .jpeg()
      .toFile(filePath);

    await optimizeImage({ filePath, maxDimension: 2000, quality: 85, keepOriginal: true });

    expect(fs.readFileSync(path.join(dir, "origin", "photo.jpg"), "utf8")).toBe(
      "ancien original déjà préservé"
    );
    expect(fs.existsSync(path.join(dir, "origin", "photo_1.jpg"))).toBe(true);
  });
});

describe("optimizeImage — ne dégrade jamais un fichier déjà bien compressé", () => {
  it("garde le fichier original intact si le ré-encodage produirait un fichier plus gros", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "noise.jpg");
    const width = 300;
    const height = 300;
    const channels = 3;
    const raw = Buffer.alloc(width * height * channels);
    for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
    // Du bruit (pas de zones plates) : la qualité JPEG influence vraiment la
    // taille de sortie, contrairement à une image de test unie.
    await sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 30 }).toFile(filePath);
    const originalBytes = fs.readFileSync(filePath);

    // Qualité demandée bien supérieure à celle d'origine, sans redimension
    // (maxDimension largement au-dessus) : le ré-encodage produit forcément
    // un fichier plus gros.
    const result = await optimizeImage({
      filePath,
      maxDimension: 2000,
      quality: 95,
      keepOriginal: true,
    });

    expect(result.optimizedSize).toBe(result.originalSize);
    expect(fs.readFileSync(filePath).equals(originalBytes)).toBe(true);
    expect(fs.existsSync(path.join(dir, "origin", "noise.jpg"))).toBe(false);
  });
});

describe("optimizeImage — tolère un JPEG légèrement corrompu", () => {
  it("n'échoue pas sur un simple avertissement libjpeg mineur", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "corrupted.jpg");

    const clean = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 50, g: 50, b: 50 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Injecte un octet parasite juste avant le marqueur DQT (0xFFDB) —
    // reproduit "Corrupt JPEG data: N extraneous bytes before marker".
    let idx = -1;
    for (let i = 2; i < clean.length - 1; i++) {
      if (clean[i] === 0xff && clean[i + 1] === 0xdb) {
        idx = i;
        break;
      }
    }
    const corrupted = Buffer.concat([clean.subarray(0, idx), Buffer.from([0x00]), clean.subarray(idx)]);
    fs.writeFileSync(filePath, corrupted);

    const result = await optimizeImage({ filePath, maxDimension: 2000, quality: 85, keepOriginal: false });
    expect(result.optimizedSize).toBeGreaterThan(0);

    const meta = await sharp(fs.readFileSync(filePath)).metadata();
    expect(meta.format).toBe("jpeg");
  });
});

describe("optimizeImage — annulation", () => {
  it("n'écrit rien et laisse la photo intacte si l'annulation arrive avant l'écriture", async () => {
    const dir = mkTempDir();
    const filePath = path.join(dir, "photo.png");
    await sharp({ create: { width: 3000, height: 2000, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
      .png({ compressionLevel: 0 })
      .toFile(filePath);
    const before = fs.readFileSync(filePath);
    const controller = new AbortController();
    controller.abort();

    await expect(
      optimizeImage({
        filePath,
        maxDimension: 1000,
        quality: 80,
        keepOriginal: true,
        forceJpeg: true,
        signal: controller.signal,
      })
    ).rejects.toThrow();

    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(["photo.png"]);
  });
});
