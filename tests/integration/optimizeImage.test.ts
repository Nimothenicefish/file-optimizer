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
