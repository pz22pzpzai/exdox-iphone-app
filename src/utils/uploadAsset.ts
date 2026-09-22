import * as FileSystem from 'expo-file-system/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Image } from 'react-native';

const IMAGE_WIDTH_LIMIT = 1800;
const IMPORT_MAX_DIMENSION = 1600;
const IMPORT_COMPRESS_QUALITY = 0.88;
const documentDirectory = FileSystem.documentDirectory ?? undefined;
const uploadDirectory = documentDirectory ? `${documentDirectory}uploads/` : undefined;

export const prepareDocumentUpload = async ({
  uri,
  fileName,
  lowResolution,
  source,
}: {
  uri: string;
  fileName: string;
  lowResolution: boolean;
  source?: 'camera' | 'gallery' | 'files' | 'seeded';
}) => {
  const normalizedUploadName = isImageFile(fileName, uri) ? normalizeJpegName(fileName) : fileName;

  if (!isImageFile(fileName, uri)) {
    const stableUri = await persistPreparedUpload(uri, normalizedUploadName);
    return {
      uri: stableUri,
      fileName: normalizedUploadName,
      mimeType: inferMimeType(fileName),
    };
  }

  if (source === 'camera') {
    const stableUri = await persistPreparedUpload(uri, normalizedUploadName);
    return {
      uri: stableUri,
      fileName: normalizedUploadName,
      mimeType: 'image/jpeg',
    };
  }

  try {
    const context = ImageManipulator.manipulate(uri);
    context.resize({ width: IMAGE_WIDTH_LIMIT, height: null });
    const rendered = await context.renderAsync();
    const result = await rendered.saveAsync({
      compress: lowResolution ? 0.55 : 0.85,
      format: SaveFormat.JPEG,
    });

    return {
      uri: await persistPreparedUpload(result.uri, normalizedUploadName),
      fileName: normalizedUploadName,
      mimeType: 'image/jpeg',
    };
  } catch {
    const stableUri = await persistPreparedUpload(uri, normalizedUploadName);
    return {
      uri: stableUri,
      fileName: inferMimeType(fileName) === 'image/jpeg' ? normalizedUploadName : fileName,
      mimeType: inferMimeType(fileName),
    };
  }
};

export const readFileSize = async (uri: string) => {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists ? info.size ?? null : null;
};

export const prepareImportedImageForApp = async ({
  id,
  uri,
  fileName,
}: {
  id: string;
  uri: string;
  fileName: string;
}) => {
  const normalizedFileName = normalizeJpegName(fileName);

  try {
    const size = await getImageSize(uri);
    const resized = getResizeTarget(size.width, size.height, IMPORT_MAX_DIMENSION);
    const context = ImageManipulator.manipulate(uri);
    context.resize(resized);
    const rendered = await context.renderAsync();
    const result = await rendered.saveAsync({
      compress: IMPORT_COMPRESS_QUALITY,
      format: SaveFormat.JPEG,
    });

    return {
      uri: await persistImportedImage(id, result.uri, normalizedFileName),
      fileName: normalizedFileName,
      mimeType: 'image/jpeg' as const,
    };
  } catch {
    return {
      uri,
      fileName: normalizedFileName,
      mimeType: 'image/jpeg' as const,
    };
  }
};

export const prepareCombinedImageDocumentForApp = async ({
  id,
  assets,
  fileNameStem,
}: {
  id: string;
  assets: Array<{
    uri: string;
    fileName: string;
  }>;
  fileNameStem: string;
}) => {
  const preparedImages = await Promise.all(
    assets.map((asset, index) =>
      prepareImportedImageForApp({
        id: `${id}-${index}`,
        uri: asset.uri,
        fileName: asset.fileName,
      }),
    ),
  );

  const pages = await Promise.all(
    preparedImages.map(async (image) => {
      const size = await getImageSize(image.uri);
      const imageBase64 = await FileSystem.readAsStringAsync(image.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return {
        width: size.width,
        height: size.height,
        asciiHex: `${base64ToHex(imageBase64)}>`,
      };
    }),
  );

  const pdfContent = buildPdfFromAsciiHexImages(pages);
  const normalizedStem = (fileNameStem || 'combined-document').replace(/[^a-zA-Z0-9._-]/g, '-');
  const fileName = `${normalizedStem}-${Date.now()}.pdf`;
  const uri = await persistTextUpload(pdfContent, fileName);

  return {
    uri,
    fileName,
    mimeType: 'application/pdf' as const,
    previewImageUri: preparedImages[0]?.uri,
    previewImageUris: preparedImages.map((image) => image.uri),
  };
};

function isImageFile(fileName: string, uri: string) {
  return /\.(jpg|jpeg|png|webp|heic)$/i.test(fileName) || /^file:.*\.(jpg|jpeg|png|webp|heic)$/i.test(uri);
}

function normalizeJpegName(fileName: string) {
  const stem = fileName.replace(/\.[^/.]+$/, '') || `capture-${Date.now()}`;
  return `${stem}.jpg`;
}

function getImageSize(uri: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      (error) => reject(error),
    );
  });
}

function getResizeTarget(width: number, height: number, maxDimension: number) {
  if (width <= maxDimension && height <= maxDimension) {
    return { width, height };
  }

  if (width >= height) {
    const ratio = maxDimension / width;
    return {
      width: maxDimension,
      height: Math.max(1, Math.round(height * ratio)),
    };
  }

  const ratio = maxDimension / height;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: maxDimension,
  };
}

async function persistImportedImage(id: string, uri: string, fileName: string) {
  if (!documentDirectory) {
    return uri;
  }

  const importDirectory = `${documentDirectory}imports/`;
  const nextUri = `${importDirectory}${id}-${fileName}`;

  try {
    await FileSystem.makeDirectoryAsync(importDirectory, { intermediates: true });
    await FileSystem.copyAsync({
      from: uri,
      to: nextUri,
    });
    return nextUri;
  } catch {
    return uri;
  }
}

async function persistPreparedUpload(uri: string, fileName: string) {
  if (!uploadDirectory) {
    return uri;
  }

  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_') || `upload-${Date.now()}.jpg`;
  const nextUri = `${uploadDirectory}${safeFileName}`;

  try {
    await FileSystem.makeDirectoryAsync(uploadDirectory, { intermediates: true });
    await FileSystem.copyAsync({
      from: uri,
      to: nextUri,
    });
    return nextUri;
  } catch {
    return uri;
  }
}

async function persistTextUpload(contents: string, fileName: string) {
  if (!uploadDirectory) {
    throw new Error('No writable upload directory is available on this device.');
  }

  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_') || `upload-${Date.now()}.pdf`;
  const nextUri = `${uploadDirectory}${safeFileName}`;

  await FileSystem.makeDirectoryAsync(uploadDirectory, { intermediates: true });
  await FileSystem.writeAsStringAsync(nextUri, contents, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  return nextUri;
}

function buildPdfFromAsciiHexImages(
  pages: Array<{
    width: number;
    height: number;
    asciiHex: string;
  }>,
) {
  const pageWidth = 595;
  const objects: string[] = [];
  const pageReferences: string[] = [];

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';

  pages.forEach((page, index) => {
    const objectBase = 3 + index * 3;
    const imageObjectId = objectBase;
    const contentObjectId = objectBase + 1;
    const pageObjectId = objectBase + 2;
    const pageHeight = Math.max(1, Math.round((page.height / Math.max(page.width, 1)) * pageWidth));
    const contentStream = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im${index + 1} Do\nQ`;

    objects[imageObjectId] =
      `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${page.asciiHex.length} >>\nstream\n${page.asciiHex}\nendstream`;
    objects[contentObjectId] =
      `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;
    objects[pageObjectId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im${index + 1} ${imageObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`;
    pageReferences.push(`${pageObjectId} 0 R`);
  });

  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageReferences.join(' ')}] >>`;

  let pdf = '%PDF-1.4\n% Exdox combined document\n';
  const offsets: number[] = [];

  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    const body = objects[objectId];
    if (!body) {
      continue;
    }
    offsets[objectId] = pdf.length;
    pdf += `${objectId} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length}\n`;
  pdf += '0000000000 65535 f \n';

  for (let objectId = 1; objectId < objects.length; objectId += 1) {
    const offset = offsets[objectId] ?? 0;
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }

  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

function base64ToHex(base64: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const sanitized = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  let bits = 0;
  let bitCount = 0;
  let hex = '';

  for (const char of sanitized) {
    if (char === '=') {
      break;
    }
    const value = alphabet.indexOf(char);
    if (value < 0) {
      continue;
    }
    bits = (bits << 6) | value;
    bitCount += 6;
    while (bitCount >= 8) {
      bitCount -= 8;
      const byte = (bits >> bitCount) & 0xff;
      hex += byte.toString(16).padStart(2, '0').toUpperCase();
    }
  }

  return hex;
}

function inferMimeType(fileName: string) {
  if (/\.pdf$/i.test(fileName)) {
    return 'application/pdf';
  }
  if (/\.png$/i.test(fileName)) {
    return 'image/png';
  }
  if (/\.webp$/i.test(fileName)) {
    return 'image/webp';
  }
  return 'image/jpeg';
}
