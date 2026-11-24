import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { captureAssetId, isImageType, MAX_CAPTURE_IMAGES, MAX_INPUT_IMAGE_BYTES, MAX_SAVED_IMAGE_BYTES,
  MAX_IMAGE_EDGE, type CaptureImageUpload, type SavedCaptureImage } from "../../shared/capture-assets";

type Attachment = { label: string; uri: string };
export function clipboardImages(event: ClipboardEvent<HTMLTextAreaElement>) {
  return Array.from(event.clipboardData.items).filter(i => i.kind === "file" && i.type.startsWith("image/"))
    .map(i => i.getAsFile()).filter((f): f is File => f !== null);
}
const cancelled = () => new DOMException("Aborted", "AbortError");
function check(signal: AbortSignal) { if (signal.aborted) throw cancelled(); }

/** Bounded canvas preparation for capture images. Every GIF is saved as a static frame. */
export async function prepareImage(file: File, label: string, signal: AbortSignal): Promise<{ upload: CaptureImageUpload; blob: Blob }> {
  if (!isImageType(file.type)) throw Error(t("支持 PNG、JPEG、WebP 和 GIF 图片", "Use PNG, JPEG, WebP or GIF images"));
  if (!file.size || file.size > MAX_INPUT_IMAGE_BYTES) throw Error(t("单张图片不能超过10MB", "Each input image must be 10 MB or smaller"));
  check(signal);
  const url = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => { image.src = ""; reject(cancelled()); };
      image.onload = () => { signal.removeEventListener("abort", stop); resolve(); };
      image.onerror = () => { signal.removeEventListener("abort", stop); reject(Error(t("无法读取这张图片", "This image cannot be decoded"))); };
      signal.addEventListener("abort", stop, { once: true });
      image.src = url;
    });
    check(signal);
    let width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || Math.max(width, height) > 8192 || width * height > 36_000_000 || Math.max(width / height, height / width) > 150)
      throw Error(t("图片尺寸过大或比例无效", "Image dimensions or aspect ratio exceed the limits"));
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale));
    // Use the actual document for a detached canvas so ShadowRoot-based embedding hosts work too.
    const canvas = globalThis.document.createElement("canvas"), context = canvas.getContext("2d");
    if (!context) throw Error(t("当前环境无法处理图片", "Image processing is unavailable in this environment"));
    let output: Blob | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      check(signal);
      canvas.width = width; canvas.height = height;
      context.drawImage(image, 0, 0, width, height);
      output = await new Promise<Blob | null>((resolve, reject) => {
        const abort = () => reject(cancelled());
        signal.addEventListener("abort", abort, { once: true });
        canvas.toBlob(blob => { signal.removeEventListener("abort", abort); resolve(blob); }, "image/webp", Math.max(.3, .8 - attempt * .1));
      });
      check(signal);
      if (output && output.size > 0 && output.size <= MAX_SAVED_IMAGE_BYTES) break;
      if (attempt >= 4) { width = Math.max(1, Math.round(width * .75)); height = Math.max(1, Math.round(height * .75)); }
    }
    if (!output || !isImageType(output.type) || output.size > MAX_SAVED_IMAGE_BYTES || !output.size)
      throw Error(t("图片处理后仍超过180KB，请缩小后重试", "The processed image exceeds 180 KB; resize it and retry"));
    const bytes = new Uint8Array(await output.arrayBuffer());
    check(signal);
    let binary = "";
    for (let p = 0; p < bytes.length; p += 8192) binary += String.fromCharCode(...bytes.subarray(p, p + 8192));
    return { blob: output, upload: { dataBase64: btoa(binary), contentType: output.type, width: canvas.width, height: canvas.height, label } };
  } finally { URL.revokeObjectURL(url); }
}

export interface DraftImage {
  id: string;
  file: File;
  label: string;
  status: "saving" | "ready" | "error";
  preview?: string;
  error?: string;
  prepared?: Awaited<ReturnType<typeof prepareImage>>;
  saved?: SavedCaptureImage;
  controller?: AbortController;
}

export function useCaptureImages(prepare = prepareImage) {
  const [images, setImages] = useState<DraftImage[]>([]), [error, setError] = useState("");
  const current = useRef<DraftImage[]>([]), alive = useRef(true), queue = useRef(Promise.resolve());
  function publish(next: DraftImage[]) { current.current = next; if (alive.current) setImages(next); }
  const contains = (item: DraftImage) => alive.current && current.current.includes(item);
  function changed() { publish([...current.current]); }
  function release(item: DraftImage) { item.controller?.abort(); if (item.preview) URL.revokeObjectURL(item.preview); }
  function clear() { current.current.forEach(release); publish([]); setError(""); }
  useEffect(() => { alive.current = true; return () => { alive.current = false; current.current.forEach(release); current.current = []; }; }, []);
  function save(item: DraftImage) {
    queue.current = queue.current.then(async () => {
      if (!contains(item)) return;
      item.status = "saving"; item.error = "";
      const controller = new AbortController(); item.controller = controller;
      const timeout = setTimeout(() => controller.abort(), 30_000);
      changed();
      try {
        const prepared = item.prepared ?? await prepare(item.file, item.label, controller.signal);
        if (!contains(item)) return;
        item.prepared = prepared;
        if (!item.preview) item.preview = URL.createObjectURL(prepared.blob);
        changed();
        const saved = await api.saveCaptureImage(prepared.upload, controller.signal);
        if (!contains(item)) return;
        check(controller.signal);
        item.saved = saved; item.status = "ready";
      } catch (err) {
        if (contains(item)) {
          item.status = "error";
          item.error = item.prepared ? t("图片保存失败，请重试或移除", "Saving failed; retry or remove this image") :
            (err instanceof Error ? err.message : t("图片处理失败", "Image processing failed"));
        }
      } finally { clearTimeout(timeout); if (contains(item)) changed(); }
    });
  }
  function add(files: File[]) {
    const slots = MAX_CAPTURE_IMAGES - current.current.length;
    setError(files.length > slots ? t("每条随手记最多5张图片", "A note can contain up to 5 images") : "");
    const added = files.slice(0, slots).map((file, n): DraftImage => ({ id: crypto.randomUUID(), file,
      label: file.name.replace(/[\\/\x00-\x1f]/g, "").slice(0, 160).trim() || t(`图片${current.current.length + n + 1}`, `Image ${current.current.length + n + 1}`), status: "saving" }));
    publish([...current.current, ...added]); added.forEach(save);
  }
  return { images, error, add, clear,
    remove(id: string) { const item = current.current.find(i => i.id === id); if (item) release(item); publish(current.current.filter(i => i.id !== id)); },
    retry(id: string) { const item = current.current.find(i => i.id === id); if (item?.status === "error") { item.status = "saving"; changed(); save(item); } },
    ready: images.every(i => i.status === "ready"),
    attachments: images.flatMap(i => i.saved ? [{ label: i.saved.label, uri: i.saved.uri }] : []),
  };
}

export function CaptureImageGrid({ images, disabled, remove, retry }: { images: DraftImage[]; disabled: boolean; remove(id: string): void; retry(id: string): void }) {
  return <div className="capture-images" aria-label={t("图片附件", "Image attachments")}>
    {images.map(item => <div className="capture-image" key={item.id}>
      {item.preview && <img src={item.preview} alt={item.label} />}
      <span className="capture-image-label" title={item.label}>{item.label}</span>
      {item.status === "saving" && <small role="status">{t("正在处理并保存…", "Processing and saving…")}</small>}
      {item.saved && <small>{item.saved.width} × {item.saved.height} · {new Intl.NumberFormat(undefined, { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 }).format(item.saved.bytes / 1024)} · {item.saved.contentType.slice(6).toUpperCase()}</small>}
      {item.error && <small role="alert" className="draft-message error">{item.error}</small>}
      <div className="capture-image-actions">
        {item.status === "error" && <button type="button" className="btn sm ghost" disabled={disabled} onClick={() => retry(item.id)}>{t("重试", "Retry")}</button>}
        <button type="button" className="btn sm ghost" disabled={disabled} aria-label={t(`移除图片：${item.label}`, `Remove image: ${item.label}`)} onClick={() => remove(item.id)}>{t("移除", "Remove")}</button>
      </div>
    </div>)}
  </div>;
}

function CapturePicture({ attachment, passive = false }: { attachment: Attachment; passive?: boolean }) {
  const [url, setUrl] = useState(""), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0), [viewer, setViewer] = useState(false);
  const returnFocus = useRef<HTMLButtonElement | null>(null), wasOpen = useRef(false);
  useEffect(() => {
    if (viewer) { wasOpen.current = true; return; }
    if (wasOpen.current) { wasOpen.current = false; const target = returnFocus.current; returnFocus.current = null; if (target?.isConnected) target.focus(); }
  }, [viewer]);
  const [pageVisible, setPageVisible] = useState(!globalThis.document.hidden);
  const element = useRef<HTMLDivElement>(null);
  const [visibleUri, setVisibleUri] = useState<string | null>(() => (typeof IntersectionObserver === "undefined" ? attachment.uri : null));
  const [loadedUri, setLoadedUri] = useState<string | null>(() => (typeof IntersectionObserver === "undefined" && !globalThis.document.hidden ? attachment.uri : null));
  const visible = visibleUri === attachment.uri;
  const shouldLoad = loadedUri === attachment.uri;
  useEffect(() => {
    const update = () => setPageVisible(!globalThis.document.hidden);
    globalThis.document.addEventListener("visibilitychange", update);
    return () => globalThis.document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") { setVisibleUri(attachment.uri); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisibleUri(attachment.uri); observer.disconnect(); } });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [attachment.uri]);
  useEffect(() => {
    if (visible && pageVisible && loadedUri !== attachment.uri) setLoadedUri(attachment.uri);
  }, [visible, pageVisible, attachment.uri, loadedUri]);
  useEffect(() => {
    if (!shouldLoad) { setUrl(""); setFailed(false); setViewer(false); return; }
    const controller = new AbortController(); let owned = "";
    setFailed(false); setUrl("");
    api.readCaptureImage(attachment.uri, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      owned = URL.createObjectURL(blob); setUrl(owned);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (owned) URL.revokeObjectURL(owned); };
  }, [attachment.uri, shouldLoad, attempt]);
  const image = url && !failed ? <img src={url} alt={attachment.label} onError={() => setFailed(true)} /> : <span>{failed ? t("图片暂不可用", "Image unavailable") : t("载入图片…", "Loading image…")}</span>;
  return <div className="capture-image" ref={element}>
    {passive ? image : <button type="button" className="capture-image-open" onClick={event => { if (failed) setAttempt(a => a + 1); else if (url) { returnFocus.current = event.currentTarget; setViewer(true); } }} aria-label={t(`查看图片：${attachment.label}`, `View image: ${attachment.label}`)}>{image}</button>}
    {!passive && <span className="capture-image-label">{attachment.label}</span>}
    {viewer && url && <CaptureImageViewer url={url} label={attachment.label} close={() => setViewer(false)} />}
  </div>;
}

export function CaptureAttachments({ items, compact = false }: { items?: Attachment[]; compact?: boolean }) {
  const images = items?.filter(a => captureAssetId(a.uri)) ?? [], links = items?.filter(a => !captureAssetId(a.uri)) ?? [];
  return <>
    {images.length > 0 && <div className={compact ? "capture-images compact" : "capture-images"}>
      {(compact ? images.slice(0, 1) : images).map((a, index) => <CapturePicture key={`${a.uri}:${index}`} attachment={a} passive={compact} />)}
      {compact && <small>{t(`${images.length}张图片`, `${images.length} image${images.length === 1 ? "" : "s"}`)}</small>}
    </div>}
    {!compact && links.map((a, n) => <p key={n}>{/^https?:\/\//i.test(a.uri) ? <a href={a.uri} target="_blank" rel="noreferrer noopener">{a.label}</a> : a.label}</p>)}
  </>;
}

function CaptureImageViewer({ url, label, close }: { url: string; label: string; close(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (ref.current?.showModal) ref.current.showModal(); else ref.current?.setAttribute("open", ""); }, []);
  return <dialog className="capture-image-viewer" ref={ref} aria-label={t("图片预览", "Image preview")} onCancel={e => { e.preventDefault(); close(); }} onKeyDown={e => {
    // The capture drawer also handles Escape/Tab at its root. Native modal focus belongs to this dialog.
    e.stopPropagation(); e.nativeEvent.stopImmediatePropagation();
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }}>
    <img className="capture-viewer-image" src={url} alt={label} /><button autoFocus type="button" className="btn" onClick={close}>{t("关闭", "Close")}</button>
  </dialog>;
}
