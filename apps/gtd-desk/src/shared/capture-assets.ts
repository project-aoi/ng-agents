/** Images are local assets; only label/uri belongs in an envelope. */
export const MAX_INPUT_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SAVED_IMAGE_BYTES = 180 * 1024;
export const MAX_CAPTURE_IMAGES = 5;
export const MAX_IMAGE_EDGE = 2048;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageType = typeof IMAGE_TYPES[number];
export const CAPTURE_ASSET_PREFIX = "/api/capture-assets/";
export const isImageType = (value: unknown): value is ImageType => IMAGE_TYPES.includes(value as ImageType);
export function captureAssetId(uri: string): string | null {
  const id = uri.startsWith(CAPTURE_ASSET_PREFIX) ? uri.slice(CAPTURE_ASSET_PREFIX.length) : "";
  return /^[a-f0-9]{64}$/.test(id) ? id : null;
}
export interface CaptureImageUpload {
  dataBase64: string;
  contentType: ImageType;
  width: number;
  height: number;
  label: string;
}
export interface SavedCaptureImage {
  label: string;
  uri: string;
  contentType: ImageType;
  width: number;
  height: number;
  bytes: number;
}
export interface CaptureImageData {
  dataBase64: string;
  contentType: ImageType;
  width: number;
  height: number;
  bytes: number;
}
