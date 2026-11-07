import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One chapter at a time is scheduled by Jobs. Images are embedded in manifest order.
export async function generateChapterPdf({ directory, images, output, title, splitLongImages = true, exclusive = false, checkpoint = async () => {}, onProgress = async () => {} }) {
  if (!images.length || images.some(i => i.status !== 'done')) throw new Error('图片尚未全部下载，不能生成完整 PDF');
  const ordered = [...images].sort((a,b) => a.index - b.index);
  const temporary = output + '.' + randomUUID() + '.part';
  const doc = new PDFDocument({ autoFirstPage: false, compress: true, info: { Title: title, Creator: 'Page Collector' } });
  const finished = pipeline(doc, createWriteStream(temporary, { flags: 'wx' }));
  finished.catch(() => {});
  let pages = 0;
  try {
    for (let index = 0; index < ordered.length; index++) {
      await checkpoint();
      const item = ordered[index];
      if (!item.file || path.basename(item.file) !== item.file) throw new Error('图片文件名无效');
      const buffer = await fs.readFile(path.join(directory, item.file));
      const metadata = await sharp(buffer, { limitInputPixels: 80000000 }).metadata();
      const rotated = [5,6,7,8].includes(metadata.orientation);
      const width = rotated ? metadata.height : metadata.width;
      const height = rotated ? metadata.width : metadata.height;
      if (!width || !height) throw new Error(`无法读取图片尺寸：${item.file}`);
      const split = splitLongImages && height > width * 3;
      const stripHeight = split ? Math.max(1, Math.floor(width * 1.5)) : height;
      for (let top = 0; top < height; top += stripHeight) {
        await checkpoint();
        const partHeight = Math.min(stripHeight, height - top);
        let embedded = buffer;
        if (split || !['jpeg','png'].includes(metadata.format)) {
          let image = sharp(buffer, { limitInputPixels: 80000000 }).rotate();
          if (split) image = image.extract({ left: 0, top, width, height: partHeight });
          embedded = await image.png().toBuffer();
        }
        const scale = Math.min(600 / width, 14400 / partHeight);
        const pageWidth = Math.max(1, width * scale), pageHeight = Math.max(1, partHeight * scale);
        doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
        doc.image(embedded, 0, 0, { width: pageWidth, height: pageHeight });
        pages++;
        if (pages > 5000) throw new Error('单章 PDF 超过 5000 页，请检查图片内容');
      }
      await onProgress({ done: index + 1, total: ordered.length, pages });
    }
    doc.end(); await finished;
    await checkpoint();
    if (exclusive) { await fs.link(temporary, output); await fs.rm(temporary); }
    else await fs.rename(temporary, output);
    return { pages };
  } catch (e) {
    doc.destroy(); await finished.catch(() => {});
    await fs.rm(temporary, { force: true }); throw e;
  }
}
